import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { z } from "zod";
import { IMcpTool } from "./IMcpTool.js";
import { FhirUtilities } from "../fhir/fhir-utilities.js";
import { fhirClient } from "../fhir/fhir-client.js";
import {
  buildResultContext,
  isLinkedToResult,
  ResultContext,
} from "../fhir/result-linkage.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { logger } from "../util/logger.js";
import {
  classifyResultSeverity,
  AbnormalResultLike,
} from "../clinical/thresholds.js";
import {
  ClosureStatus,
  LoopHistoryRecord,
  summarizeLoopHistory,
} from "../clinical/closure-pattern.js";
import { coerceNumber } from "./schema-coercion.js";

/**
 * Tool 9: get_patient_loop_history (F4 — Longitudinal Loop Memory)
 *
 * Looks back across a patient's full history window (default 24 months) to detect
 * systemic closure-failure patterns: how many abnormal results of the same type
 * went unfollowed across that window, not just the recent 90 days that T1 covers.
 *
 * Returns a deterministic summary the agent can quote verbatim, e.g.
 *   "This patient has had 3 abnormal Screening Mammogram results in the past
 *    24 months — only 1 has documented follow-up."
 *
 * The tool exists to surface repeat-failure patterns (Zheng / Mathur impact signal)
 * and is never used for diagnosis or treatment recommendation.
 */
class GetPatientLoopHistoryTool implements IMcpTool {
  registerTool(server: McpServer, req: Request): void {
    server.registerTool(
      "get_patient_loop_history",
      {
        description:
          "Detects longitudinal closure-failure patterns across a patient's " +
          "abnormal-result history. Returns counts of repeated abnormal " +
          "result types and how many of each remained without documented " +
          "follow-up. Useful for surfacing systemic safety risks rather " +
          "than a single open loop. Default lookback window is 24 months.",
        inputSchema: {
          patientId: z
            .string()
            .describe(
              "The patient ID. Optional; Prompt Opinion patient context is authoritative when available.",
            )
            .optional(),
          historyMonths: coerceNumber
            .describe(
              "Number of months to look back for abnormal-result history. Defaults to 24.",
            )
            .optional(),
        },
      },
      async ({ patientId, historyMonths }) => {
        try {
          patientId = FhirUtilities.getPatientIdOrThrow(req, patientId);
          const months = historyMonths ?? 24;
          const lookbackDate = computeLookbackDate(months);

          logger.info(
            { patientId, historyMonths: months, lookbackDate },
            "Scanning longitudinal loop history",
          );

          const abnormalRecords = await collectAbnormalResults(
            req,
            patientId,
            lookbackDate,
          );

          if (abnormalRecords.length === 0) {
            const emptySummary = summarizeLoopHistory([], months);
            return McpUtilities.createJsonResponse({
              status: "no_abnormal_results_in_window",
              patientId,
              historyMonths: months,
              lookbackDate,
              message:
                "No abnormal lab or imaging results were found in the requested history window.",
              summary: emptySummary,
              safetyNote:
                "This is an automated audit. All findings require clinician review before action.",
            });
          }

          const records: LoopHistoryRecord[] = [];
          for (const candidate of abnormalRecords) {
            const closureStatus = await computeClosureStatusForCandidate(
              req,
              patientId,
              candidate,
            );

            const severitySignal = classifyResultSeverity({
              resourceType: candidate.resourceType,
              code: candidate.code,
              display: candidate.display,
              value: candidate.value,
              unit: candidate.unit,
              interpretation: candidate.interpretation,
            });

            records.push({
              reference: candidate.reference,
              resultType: candidate.display ?? candidate.code ?? "Unknown",
              date: candidate.date,
              closureStatus,
              severityLevel: severitySignal.level,
            });
          }

          const summary = summarizeLoopHistory(records, months);

          return McpUtilities.createJsonResponse({
            status: "loop_history_analyzed",
            patientId,
            historyMonths: months,
            lookbackDate,
            recordsAudited: records.length,
            summary,
            records,
            safetyNote:
              "Pattern detection is for clinician review only. ResultLoop does not diagnose, contact patients, or order care. Findings must be verified in the EHR before any clinical action.",
          });
        } catch (error) {
          logger.error(
            { error },
            "Failed to analyze longitudinal loop history",
          );
          return McpUtilities.createTextResponse(
            `Error analyzing loop history: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
            { isError: true },
          );
        }
      },
    );
  }
}

export const GetPatientLoopHistoryToolInstance =
  new GetPatientLoopHistoryTool();

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

interface AbnormalCandidate extends AbnormalResultLike {
  reference: string;
  date: string;
}

const FOLLOW_UP_RESOURCE_TYPES = [
  "ServiceRequest",
  "Task",
  "Communication",
  "CarePlan",
  "Encounter",
] as const;

const MAX_ABNORMAL_RECORDS = 25;

function computeLookbackDate(months: number): string {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().split("T")[0];
}

async function collectAbnormalResults(
  req: Request,
  patientId: string,
  lookbackDate: string,
): Promise<AbnormalCandidate[]> {
  const candidates: AbnormalCandidate[] = [];

  const observations = await searchPatientResources(
    req,
    "Observation",
    patientId,
    lookbackDate,
  );
  for (const entry of observations) {
    const obs = entry as Record<string, unknown>;
    if (obs?.["resourceType"] !== "Observation") continue;
    if (!isAbnormalObservation(obs)) continue;
    const candidate = mapObservationToCandidate(obs);
    if (candidate) candidates.push(candidate);
  }

  const reports = await searchPatientResources(
    req,
    "DiagnosticReport",
    patientId,
    lookbackDate,
  );
  for (const entry of reports) {
    const dr = entry as Record<string, unknown>;
    if (dr?.["resourceType"] !== "DiagnosticReport") continue;
    if (!isAbnormalDiagnosticReport(dr)) continue;
    const candidate = mapDiagnosticReportToCandidate(dr);
    if (candidate) candidates.push(candidate);
  }

  candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return candidates.slice(0, MAX_ABNORMAL_RECORDS);
}

async function searchPatientResources(
  req: Request,
  resourceType: "Observation" | "DiagnosticReport",
  patientId: string,
  lookbackDate: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const dated = await fhirClient.search(req, resourceType, [
      `patient=${patientId}`,
      `date=ge${lookbackDate}`,
      `_count=100`,
      `_sort=-date`,
    ]);

    if (dated.entry && dated.entry.length > 0) {
      return dated.entry
        .map((entry) => entry.resource as unknown as Record<string, unknown>)
        .filter((resource): resource is Record<string, unknown> =>
          Boolean(resource),
        );
    }

    const fallback = await fhirClient.search(req, resourceType, [
      `patient=${patientId}`,
      `_count=100`,
      `_sort=-date`,
    ]);

    return (fallback.entry || [])
      .map((entry) => entry.resource as unknown as Record<string, unknown>)
      .filter((resource): resource is Record<string, unknown> =>
        Boolean(resource),
      )
      .filter((resource) => {
        const date =
          (resource["effectiveDateTime"] as string) ||
          (resource["issued"] as string) ||
          "";
        return typeof date === "string" && date.slice(0, 10) >= lookbackDate;
      });
  } catch (error) {
    logger.warn(
      {
        resourceType,
        error: error instanceof Error ? error.message : "Unknown",
      },
      "Failed to fetch resource for loop history",
    );
    return [];
  }
}

function isAbnormalObservation(obs: Record<string, unknown>): boolean {
  const interpretation = obs["interpretation"] as
    | Array<{ coding?: Array<{ code?: string }> }>
    | undefined;
  if (interpretation) {
    for (const interp of interpretation) {
      for (const coding of interp.coding || []) {
        const code = coding.code?.toUpperCase();
        if (
          code &&
          ["A", "AA", "H", "HH", "L", "LL", "HU", "LU", "CR"].includes(code)
        ) {
          return true;
        }
      }
    }
  }

  const valueQuantity = obs["valueQuantity"] as { value?: number } | undefined;
  const referenceRange = obs["referenceRange"] as
    | Array<{ low?: { value?: number }; high?: { value?: number } }>
    | undefined;

  if (valueQuantity?.value !== undefined && referenceRange?.[0]) {
    const range = referenceRange[0];
    const val = valueQuantity.value;
    if (range.low?.value !== undefined && val < range.low.value) return true;
    if (range.high?.value !== undefined && val > range.high.value) return true;
  }

  return false;
}

function isAbnormalDiagnosticReport(dr: Record<string, unknown>): boolean {
  const conclusion = ((dr["conclusion"] as string) || "").toLowerCase();
  const abnormalKeywords = [
    "abnormal",
    "suspicious",
    "malignant",
    "positive",
    "critical",
    "concerning",
    "irregular",
    "mass",
    "lesion",
    "nodule",
    "tumor",
    "carcinoma",
    "neoplasm",
    "bi-rads 4",
    "bi-rads 5",
    "bi-rads 6",
  ];

  if (abnormalKeywords.some((kw) => conclusion.includes(kw))) return true;

  const conclusionCode = dr["conclusionCode"] as
    | Array<{ text?: string; coding?: Array<{ display?: string }> }>
    | undefined;
  if (conclusionCode) {
    for (const cc of conclusionCode) {
      const text = (cc.text || "").toLowerCase();
      if (abnormalKeywords.some((kw) => text.includes(kw))) return true;
    }
  }

  return false;
}

function mapObservationToCandidate(
  obs: Record<string, unknown>,
): AbnormalCandidate | null {
  const id = obs["id"] as string | undefined;
  if (!id) return null;
  const code = obs["code"] as
    | { coding?: Array<{ code?: string; display?: string }>; text?: string }
    | undefined;
  const valueQuantity = obs["valueQuantity"] as
    | { value?: number; unit?: string }
    | undefined;
  const interpretation = obs["interpretation"] as
    | Array<{ coding?: Array<{ code?: string; display?: string }> }>
    | undefined;
  const date = (obs["effectiveDateTime"] as string) || "";

  return {
    reference: `Observation/${id}`,
    date,
    resourceType: "Observation",
    code: code?.coding?.[0]?.code,
    display: code?.text || code?.coding?.[0]?.display,
    value: valueQuantity?.value,
    unit: valueQuantity?.unit,
    interpretation:
      interpretation?.[0]?.coding?.[0]?.display ||
      interpretation?.[0]?.coding?.[0]?.code,
  };
}

function mapDiagnosticReportToCandidate(
  dr: Record<string, unknown>,
): AbnormalCandidate | null {
  const id = dr["id"] as string | undefined;
  if (!id) return null;
  const code = dr["code"] as
    | { coding?: Array<{ code?: string; display?: string }>; text?: string }
    | undefined;
  const date =
    (dr["effectiveDateTime"] as string) || (dr["issued"] as string) || "";

  return {
    reference: `DiagnosticReport/${id}`,
    date,
    resourceType: "DiagnosticReport",
    code: code?.coding?.[0]?.code,
    display: code?.text || code?.coding?.[0]?.display,
    interpretation: dr["conclusion"] as string | undefined,
  };
}

async function computeClosureStatusForCandidate(
  req: Request,
  patientId: string,
  candidate: AbnormalCandidate,
): Promise<ClosureStatus> {
  if (!candidate.date) return "INSUFFICIENT_EVIDENCE";

  let resultContext: ResultContext;
  try {
    const result = await fhirClient.read<Record<string, unknown>>(
      req,
      candidate.reference,
    );
    resultContext = buildResultContext(candidate.reference, result);
  } catch {
    resultContext = buildResultContext(candidate.reference, null);
  }

  let totalLinked = 0;
  let anyError = false;

  for (const resourceType of FOLLOW_UP_RESOURCE_TYPES) {
    try {
      const dateParam = followUpDateParam(resourceType);
      const patientParam =
        resourceType === "Task"
          ? `subject=Patient/${patientId}`
          : `patient=${patientId}`;

      const bundle = await fhirClient.search(req, resourceType, [
        patientParam,
        `${dateParam}=ge${candidate.date}`,
        `_count=10`,
        `_sort=-${dateParam}`,
      ]);

      for (const entry of bundle.entry || []) {
        const resource = entry.resource as unknown as Record<string, unknown>;
        if (!resource) continue;
        if (isLinkedToResult(resource, resultContext)) totalLinked += 1;
      }
    } catch (error) {
      anyError = true;
      logger.warn(
        {
          resourceType,
          reference: candidate.reference,
          error: error instanceof Error ? error.message : "Unknown",
        },
        "Failed to search follow-up resource type for loop history",
      );
    }
  }

  if (totalLinked > 0) return "CLOSED";
  if (anyError) return "INSUFFICIENT_EVIDENCE";
  return "OPEN_LOOP";
}

function followUpDateParam(resourceType: string): string {
  switch (resourceType) {
    case "ServiceRequest":
      return "authored";
    case "Task":
      return "authored-on";
    case "Communication":
      return "sent";
    case "CarePlan":
      return "date";
    case "Encounter":
      return "date";
    default:
      return "date";
  }
}
