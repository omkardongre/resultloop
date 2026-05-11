/**
 * ResultLoop CDS Hooks Service
 *
 * Implements the CDS Hooks 3.0 (Normative, March 2026) specification:
 *   https://cds-hooks.hl7.org/
 *
 * Service: result-loop-open-loop-detector
 * Hook:    patient-view
 *
 * When a clinician opens any patient's chart, this service silently scans for
 * abnormal results lacking documented follow-up (open loops). If any are found,
 * it returns a non-interruptive warning card with a pre-built follow-up Task
 * suggestion and a link to the full ResultLoop audit.
 *
 * Architecture:
 *   - GET  /cds-services         → discovery endpoint (service manifest)
 *   - POST /cds-services/result-loop-open-loop-detector → hook execution
 *
 * The hook execution reuses the same clinical logic as T1 (abnormal result
 * scan) and T2 (follow-up context audit), but runs inline for speed.
 * Target response time: < 500ms per CDS Hooks best practices.
 */

import { Request, Response } from "express";
import axios from "axios";
import { fhirR4 } from "@smile-cdr/fhirts";
import {
  classifyResultSeverity,
  AbnormalResultLike,
} from "../clinical/thresholds.js";
import {
  rankOpenLoopsBySeverity,
  OpenLoopCandidate,
} from "../clinical/open-loop-ranking.js";
import { logger } from "../util/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CdsHooksContext {
  patientId?: string;
  userId?: string;
  encounterId?: string;
}

interface CdsPrefetch {
  recentObservations?: fhirR4.Bundle | null;
  recentDiagnosticReports?: fhirR4.Bundle | null;
}

interface CdsFhirAuthorization {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  subject: string;
}

interface CdsHooksRequest {
  hook: string;
  hookInstance: string;
  fhirServer?: string;
  fhirAuthorization?: CdsFhirAuthorization;
  context: CdsHooksContext;
  prefetch?: CdsPrefetch;
}

interface CdsCard {
  summary: string;
  indicator: "info" | "warning" | "critical";
  detail?: string;
  source: {
    label: string;
    url?: string;
    icon?: string;
  };
  suggestions?: CdsSuggestion[];
  links?: CdsLink[];
  selectionBehavior?: "at-most-one";
}

interface CdsSuggestion {
  label: string;
  uuid?: string;
  actions?: CdsAction[];
}

interface CdsAction {
  type: "create" | "update" | "delete";
  description: string;
  resource?: Record<string, unknown>;
}

interface CdsLink {
  label: string;
  url: string;
  type: "absolute" | "smart";
  appContext?: string;
}

interface OpenLoopSummary {
  reference: string;
  display: string;
  daysElapsed: number;
  severityLevel: string;
  totalPriorityScore: number;
  recommendation: string;
}

// ─── Discovery Manifest ───────────────────────────────────────────────────────

export const CDS_HOOKS_DISCOVERY = {
  services: [
    {
      hook: "patient-view",
      title: "ResultLoop — Abnormal Result Follow-Up Safety Net",
      description:
        "Silently scans the patient chart for abnormal lab or imaging results " +
        "lacking documented follow-up. Returns a non-interruptive warning card " +
        "if any open loops are found. Implements AHRQ SAFER closed-loop " +
        "communication guidance and Joint Commission NPSG.02.03.01.",
      id: "result-loop-open-loop-detector",
      version: "STU3",
      usageRequirements:
        "Requires FHIR R4 access to Observation and DiagnosticReport resources " +
        "for the selected patient. Works best with prefetch populated.",
      prefetch: {
        recentObservations:
          "Observation?patient={{context.patientId}}&_sort=-date&_count=50",
        recentDiagnosticReports:
          "DiagnosticReport?patient={{context.patientId}}&_sort=-date&_count=25",
      },
    },
  ],
};

// ─── Hook Handler ─────────────────────────────────────────────────────────────

export async function handlePatientViewHook(
  req: Request,
  res: Response,
): Promise<void> {
  const body = req.body as CdsHooksRequest;

  if (!body || body.hook !== "patient-view") {
    res.status(400).json({ error: "Invalid hook or missing body" });
    return;
  }

  const patientId = body.context?.patientId;
  if (!patientId) {
    res.json({ cards: [] });
    return;
  }

  try {
    const openLoops = await detectOpenLoops(body, patientId);

    if (openLoops.length === 0) {
      logger.info({ patientId }, "CDS Hooks: no open loops found");
      res.json({ cards: [] });
      return;
    }

    const cards = buildCards(openLoops, patientId, body.fhirServer);
    logger.info(
      { patientId, openLoopCount: openLoops.length, cardCount: cards.length },
      "CDS Hooks: returning warning cards",
    );

    res.json({ cards });
  } catch (error) {
    logger.error({ error, patientId }, "CDS Hooks hook execution failed");
    res.json({ cards: [] });
  }
}

// ─── Core Detection Logic ─────────────────────────────────────────────────────

async function detectOpenLoops(
  body: CdsHooksRequest,
  patientId: string,
): Promise<OpenLoopSummary[]> {
  const fhirBaseUrl = body.fhirServer;
  const bearerToken = body.fhirAuthorization?.access_token;

  const lookbackDays = 120;
  const lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);
  const dateFilter = lookbackDate.toISOString().split("T")[0];

  const abnormalCandidates: OpenLoopCandidate[] = [];

  // Step 1: Gather abnormal results from prefetch (fast path) or direct FHIR call (fallback)
  const observations = await resolveBundle(
    body.prefetch?.recentObservations,
    fhirBaseUrl,
    bearerToken,
    `Observation?patient=${patientId}&date=ge${dateFilter}&_sort=-date&_count=50`,
  );

  const diagnosticReports = await resolveBundle(
    body.prefetch?.recentDiagnosticReports,
    fhirBaseUrl,
    bearerToken,
    `DiagnosticReport?patient=${patientId}&date=ge${dateFilter}&_sort=-date&_count=25`,
  );

  // Scan Observations for abnormal interpretations
  for (const entry of observations.entry ?? []) {
    const obs = entry.resource as unknown as Record<string, unknown>;
    if (obs?.resourceType !== "Observation") continue;
    if (!isAbnormalObservation(obs)) continue;

    const date = extractDate(obs);
    if (!date) continue;

    const candidate = mapObservationToCandidate(obs, date);
    abnormalCandidates.push(candidate);
  }

  // Scan DiagnosticReports for abnormal conclusions
  for (const entry of diagnosticReports.entry ?? []) {
    const dr = entry.resource as unknown as Record<string, unknown>;
    if (dr?.resourceType !== "DiagnosticReport") continue;
    if (!isAbnormalDiagnosticReport(dr)) continue;

    const date = extractDate(dr);
    if (!date) continue;

    const candidate = mapDiagnosticReportToCandidate(dr, date);
    abnormalCandidates.push(candidate);
  }

  if (abnormalCandidates.length === 0) return [];

  // Step 2: Check each abnormal result for follow-up evidence (parallel)
  const openLoopChecks = await Promise.all(
    abnormalCandidates.map((candidate) =>
      checkFollowUpExists(candidate, patientId, fhirBaseUrl, bearerToken),
    ),
  );

  const openLoopCandidates = abnormalCandidates.filter(
    (_c, i) => !openLoopChecks[i],
  );

  if (openLoopCandidates.length === 0) return [];

  // Step 3: Rank by severity
  const ranked = rankOpenLoopsBySeverity(openLoopCandidates, new Date());

  return ranked.map((r) => ({
    reference: r.reference,
    display: r.display ?? r.code ?? "Abnormal result",
    daysElapsed: r.daysSinceResult ?? 0,
    severityLevel: r.severityLevel,
    totalPriorityScore: r.totalPriorityScore,
    recommendation: r.rankingRationale?.[0] ?? "Review and document follow-up.",
  }));
}

// ─── Follow-up Check ─────────────────────────────────────────────────────────

async function checkFollowUpExists(
  candidate: OpenLoopCandidate,
  patientId: string,
  fhirBaseUrl: string | undefined,
  bearerToken: string | undefined,
): Promise<boolean> {
  if (!fhirBaseUrl) return false;

  const afterDate = candidate.date;

  // FHIR R4 date search parameter names vary by resource type
  const followUpQueries = [
    `ServiceRequest?patient=${patientId}&authored=ge${afterDate}&_count=1`,
    `Task?patient=${patientId}&authored-on=ge${afterDate}&_count=1`,
    `Communication?patient=${patientId}&sent=ge${afterDate}&_count=1`,
  ];

  for (const query of followUpQueries) {
    try {
      const url = `${fhirBaseUrl}/${query}`;
      const response = await fetchFhir<fhirR4.Bundle>(url, bearerToken);
      const count = response?.total ?? response?.entry?.length ?? 0;
      if (count > 0) return true;
    } catch {
      // Partial failure — continue checking other types
    }
  }

  return false;
}

// ─── Card Builder ─────────────────────────────────────────────────────────────

function buildCards(
  openLoops: OpenLoopSummary[],
  patientId: string,
  fhirBaseUrl: string | undefined,
): CdsCard[] {
  const top = openLoops[0];
  const othersCount = openLoops.length - 1;

  const indicatorMap: Record<string, CdsCard["indicator"]> = {
    CRITICAL: "critical",
    HIGH: "warning",
    MODERATE: "warning",
    LOW: "info",
  };

  const indicator: CdsCard["indicator"] =
    indicatorMap[top.severityLevel] ?? "warning";

  const summaryLine =
    openLoops.length === 1
      ? `ResultLoop: 1 open-loop abnormal result — ${top.display} (${top.daysElapsed} days without documented follow-up)`
      : `ResultLoop: ${openLoops.length} open-loop abnormal results — top: ${top.display} (${top.daysElapsed} days)`;

  const detailLines: string[] = [
    `**Highest priority:** ${top.display}`,
    `**Severity:** ${top.severityLevel} (Priority score: ${top.totalPriorityScore}/100)`,
    `**Days without follow-up:** ${top.daysElapsed}`,
    `**Recommendation:** ${top.recommendation}`,
  ];

  if (othersCount > 0) {
    detailLines.push(
      `\n**${othersCount} additional open loop(s)** also detected. Open the full ResultLoop audit for details.`,
    );
  }

  detailLines.push(
    "\n*ResultLoop is an automated safety audit. All findings require clinician review. " +
      "This does not constitute a diagnosis or clinical order.*",
  );

  const prefilledTask: Record<string, unknown> = {
    resourceType: "Task",
    status: "requested",
    intent: "proposal",
    priority: top.severityLevel === "CRITICAL" ? "urgent" : "routine",
    code: {
      coding: [
        {
          system: "http://hl7.org/fhir/CodeSystem/task-code",
          code: "fulfill",
          display: "Fulfill the focal request",
        },
      ],
      text: `Follow-up required: ${top.display}`,
    },
    description: `ResultLoop detected no documented follow-up for: ${top.display} (${top.daysElapsed} days elapsed). Clinician review required.`,
    for: { reference: `Patient/${patientId}` },
    focus: { reference: top.reference },
    authoredOn: new Date().toISOString(),
    note: [
      {
        text: `Auto-generated by ResultLoop CDS Hooks service. Clinician must review and update status.`,
      },
    ],
  };

  const suggestions: CdsSuggestion[] = [
    {
      label: `Create follow-up Task for ${top.display}`,
      uuid: `resultloop-task-${patientId}-${Date.now()}`,
      actions: [
        {
          type: "create",
          description: `Create a follow-up Task for the open-loop ${top.display} finding`,
          resource: prefilledTask,
        },
      ],
    },
  ];

  const links: CdsLink[] = [
    {
      label: "Open ResultLoop Full Audit",
      url: `https://resultloop-mcp.onrender.com/health`,
      type: "absolute",
    },
  ];

  if (fhirBaseUrl) {
    links.push({
      label: "View in FHIR",
      url: `${fhirBaseUrl}/${top.reference}`,
      type: "absolute",
    });
  }

  return [
    {
      summary: summaryLine,
      indicator,
      detail: detailLines.join("\n"),
      source: {
        label: "ResultLoop — Abnormal Result Follow-Up Audit",
        url: "https://resultloop-mcp.onrender.com",
        icon: "https://resultloop-mcp.onrender.com/health",
      },
      suggestions,
      links,
      selectionBehavior: "at-most-one",
    },
  ];
}

// ─── FHIR Helpers ─────────────────────────────────────────────────────────────

async function resolveBundle(
  prefetchValue: fhirR4.Bundle | null | undefined,
  fhirBaseUrl: string | undefined,
  bearerToken: string | undefined,
  fallbackQuery: string,
): Promise<fhirR4.Bundle> {
  if (prefetchValue && prefetchValue.resourceType === "Bundle") {
    return prefetchValue;
  }

  if (!fhirBaseUrl) {
    return { resourceType: "Bundle", type: "searchset", entry: [] };
  }

  try {
    const result = await fetchFhir<fhirR4.Bundle>(
      `${fhirBaseUrl}/${fallbackQuery}`,
      bearerToken,
    );
    return result ?? { resourceType: "Bundle", type: "searchset", entry: [] };
  } catch {
    return { resourceType: "Bundle", type: "searchset", entry: [] };
  }
}

async function fetchFhir<T>(
  url: string,
  bearerToken?: string,
): Promise<T | null> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/fhir+json",
    };
    if (bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`;
    }
    const response = await axios.get<T>(url, { headers, timeout: 3000 });
    return response.data;
  } catch {
    return null;
  }
}

// ─── Abnormality Detection (mirrors T1 logic) ─────────────────────────────────

function isAbnormalObservation(obs: Record<string, unknown>): boolean {
  const interpretation = obs["interpretation"] as
    | Array<{ coding?: Array<{ code?: string }> }>
    | undefined;

  if (interpretation) {
    for (const interp of interpretation) {
      for (const coding of interp.coding ?? []) {
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
    | Array<{ low?: { value?: number }; high?: { value?: number } }>[]
    | undefined;

  if (valueQuantity?.value !== undefined && referenceRange?.[0]) {
    const range = referenceRange[0] as unknown as {
      low?: { value?: number };
      high?: { value?: number };
    };
    const val = valueQuantity.value;
    if (range.low?.value !== undefined && val < range.low.value) return true;
    if (range.high?.value !== undefined && val > range.high.value) return true;
  }

  return false;
}

function isAbnormalDiagnosticReport(dr: Record<string, unknown>): boolean {
  const conclusion = (dr["conclusion"] as string)?.toLowerCase() ?? "";
  const abnormalKeywords = [
    "abnormal",
    "suspicious",
    "malignant",
    "positive",
    "critical",
    "concerning",
    "irregular",
    "bi-rads",
    "birads",
    "lung-rads",
    "lungrads",
    "high risk",
    "moderate risk",
    "needs follow",
    "follow-up required",
    "further evaluation",
    "recommended",
  ];
  return abnormalKeywords.some((kw) => conclusion.includes(kw));
}

// ─── Mapping Helpers ─────────────────────────────────────────────────────────

function mapObservationToCandidate(
  obs: Record<string, unknown>,
  date: string,
): OpenLoopCandidate {
  const id = (obs["id"] as string) ?? "unknown";
  const code = extractCode(obs);
  const display = extractDisplay(obs);
  const value = extractValue(obs);
  const unit = extractUnit(obs);
  const interpretation = extractInterpretationCode(obs);

  const resultLike: AbnormalResultLike = {
    code,
    display,
    value,
    unit,
    interpretation,
  };
  const severity = classifyResultSeverity(resultLike);

  return {
    resourceType: "Observation",
    resourceId: id,
    reference: `Observation/${id}`,
    date,
    code,
    display,
    value,
    unit,
    interpretation,
    closureStatus: "OPEN_LOOP",
    severityLevel: severity.level,
    severityScore: undefined,
  } as unknown as OpenLoopCandidate;
}

function mapDiagnosticReportToCandidate(
  dr: Record<string, unknown>,
  date: string,
): OpenLoopCandidate {
  const id = (dr["id"] as string) ?? "unknown";
  const code = extractCode(dr);
  const display = extractDisplay(dr);
  const conclusion = (dr["conclusion"] as string) ?? "";

  const resultLike: AbnormalResultLike = { code, display, value: conclusion };
  const severity = classifyResultSeverity(resultLike);

  return {
    resourceType: "DiagnosticReport",
    resourceId: id,
    reference: `DiagnosticReport/${id}`,
    date,
    code,
    display,
    value: conclusion.substring(0, 100),
    closureStatus: "OPEN_LOOP",
    severityLevel: severity.level,
    severityScore: undefined,
  } as unknown as OpenLoopCandidate;
}

function extractDate(resource: Record<string, unknown>): string | null {
  const effectiveDateTime = resource["effectiveDateTime"] as string | undefined;
  if (effectiveDateTime) return effectiveDateTime.split("T")[0];

  const issued = resource["issued"] as string | undefined;
  if (issued) return issued.split("T")[0];

  const authored = resource["authoredOn"] as string | undefined;
  if (authored) return authored.split("T")[0];

  return null;
}

function extractCode(resource: Record<string, unknown>): string | undefined {
  const code = resource["code"] as
    | { coding?: Array<{ code?: string }> }
    | undefined;
  return code?.coding?.[0]?.code;
}

function extractDisplay(resource: Record<string, unknown>): string | undefined {
  const code = resource["code"] as
    | { coding?: Array<{ display?: string }>; text?: string }
    | undefined;
  return code?.coding?.[0]?.display ?? code?.text;
}

function extractValue(
  resource: Record<string, unknown>,
): string | number | undefined {
  const vq = resource["valueQuantity"] as { value?: number } | undefined;
  if (vq?.value !== undefined) return vq.value;
  const vs = resource["valueString"] as string | undefined;
  return vs;
}

function extractUnit(resource: Record<string, unknown>): string | undefined {
  const vq = resource["valueQuantity"] as { unit?: string } | undefined;
  return vq?.unit;
}

function extractInterpretationCode(
  resource: Record<string, unknown>,
): string | undefined {
  const interpretation = resource["interpretation"] as
    | Array<{ coding?: Array<{ code?: string }> }>
    | undefined;
  return interpretation?.[0]?.coding?.[0]?.code;
}
