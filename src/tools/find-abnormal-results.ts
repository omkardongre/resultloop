import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { IMcpTool } from "../tools/IMcpTool.js";
import { z } from "zod";
import { FhirUtilities } from "../fhir/fhir-utilities.js";
import { fhirClient } from "../fhir/fhir-client.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { logger } from "../util/logger.js";

/**
 * Abnormal result interpretation for FHIR Observation.
 */
interface AbnormalResult {
  resourceType: string;
  resourceId: string;
  date: string;
  code: string;
  display: string;
  value?: string;
  unit?: string;
  interpretation?: string;
  status: string;
  reference: string;
}

/**
 * Tool 1: find_recent_abnormal_results
 *
 * Scans a patient's Observations and DiagnosticReports to find results
 * flagged as abnormal (via interpretation codes or abnormal status).
 *
 * This is the entry point of the ResultLoop audit workflow.
 */
class FindRecentAbnormalResultsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "find_recent_abnormal_results",
      {
        description:
          "Finds recent abnormal lab and imaging results for a patient. " +
          "Scans Observations and DiagnosticReports for results flagged as " +
          "abnormal, critical, or outside normal range. Use this tool first " +
          "to identify results that may need follow-up closure auditing.",
        inputSchema: {
          patientId: z
            .string()
            .describe(
              "The patient ID. Optional if patient context already exists.",
            )
            .optional(),
          lookbackDays: z
            .number()
            .describe(
              "Number of days to look back for abnormal results. Defaults to 90.",
            )
            .optional(),
        },
      },
      async ({ patientId, lookbackDays }) => {
        try {
          // Resolve patient ID from context if not provided
          if (!patientId) {
            patientId = FhirUtilities.getPatientIdOrThrow(req);
          }

          const days = lookbackDays ?? 90;
          const lookbackDate = new Date();
          lookbackDate.setDate(lookbackDate.getDate() - days);
          const dateFilter = lookbackDate.toISOString().split("T")[0];

          logger.info(
            { patientId, lookbackDays: days },
            "Scanning for abnormal results",
          );

          const abnormalResults: AbnormalResult[] = [];

          // Search Observations for abnormal interpretations
          const obsBundle = await fhirClient.search(req, "Observation", [
            `patient=${patientId}`,
            `date=ge${dateFilter}`,
            `_count=100`,
            `_sort=-date`,
          ]);

          if (obsBundle.entry) {
            for (const entry of obsBundle.entry) {
              const obs = entry.resource as unknown as Record<string, unknown>;
              if (obs?.resourceType !== "Observation") continue;

              if (this.isAbnormalObservation(obs)) {
                abnormalResults.push(this.mapObservation(obs));
              }
            }
          }

          // Search DiagnosticReports for abnormal conclusions
          const drBundle = await fhirClient.search(req, "DiagnosticReport", [
            `patient=${patientId}`,
            `date=ge${dateFilter}`,
            `_count=100`,
            `_sort=-date`,
          ]);

          if (drBundle.entry) {
            for (const entry of drBundle.entry) {
              const dr = entry.resource as unknown as Record<string, unknown>;
              if (dr?.resourceType !== "DiagnosticReport") continue;

              if (this.isAbnormalDiagnosticReport(dr)) {
                abnormalResults.push(this.mapDiagnosticReport(dr));
              }
            }
          }

          logger.info(
            { patientId, abnormalCount: abnormalResults.length },
            "Abnormal result scan complete",
          );

          if (abnormalResults.length === 0) {
            return McpUtilities.createJsonResponse({
              status: "no_abnormal_results",
              patientId,
              lookbackDays: days,
              message:
                "No abnormal lab or imaging results found in the specified timeframe.",
              results: [],
            });
          }

          return McpUtilities.createJsonResponse({
            status: "abnormal_results_found",
            patientId,
            lookbackDays: days,
            totalAbnormal: abnormalResults.length,
            message: `Found ${abnormalResults.length} abnormal result(s) that may require follow-up closure auditing.`,
            results: abnormalResults,
            nextStep:
              "Use 'get_result_followup_context' for each abnormal result to check if documented follow-up exists.",
          });
        } catch (error) {
          logger.error({ error }, "Failed to scan abnormal results");
          return McpUtilities.createTextResponse(
            `Error scanning for abnormal results: ${error instanceof Error ? error.message : "Unknown error"}`,
            { isError: true },
          );
        }
      },
    );
  }

  /**
   * Detect if an Observation is abnormal based on interpretation codes,
   * reference ranges, or abnormal value flags.
   */
  private isAbnormalObservation(obs: Record<string, unknown>): boolean {
    // Check interpretation coding
    const interpretation = obs["interpretation"] as
      | Array<{ coding?: Array<{ code?: string }> }>
      | undefined;
    if (interpretation) {
      for (const interp of interpretation) {
        if (interp.coding) {
          for (const coding of interp.coding) {
            const code = coding.code?.toUpperCase();
            if (
              code &&
              ["A", "AA", "H", "HH", "L", "LL", "HU", "LU", "CR"].includes(
                code,
              )
            ) {
              return true;
            }
          }
        }
      }
    }

    // Check if value is outside reference range
    const valueQuantity = obs["valueQuantity"] as
      | { value?: number }
      | undefined;
    const referenceRange = obs["referenceRange"] as
      | Array<{
          low?: { value?: number };
          high?: { value?: number };
        }>
      | undefined;

    if (valueQuantity?.value !== undefined && referenceRange?.[0]) {
      const range = referenceRange[0];
      const val = valueQuantity.value;
      if (range.low?.value !== undefined && val < range.low.value) return true;
      if (range.high?.value !== undefined && val > range.high.value) return true;
    }

    return false;
  }

  /**
   * Detect if a DiagnosticReport is abnormal based on conclusion or status.
   */
  private isAbnormalDiagnosticReport(dr: Record<string, unknown>): boolean {
    const conclusion = (dr["conclusion"] as string)?.toLowerCase() || "";
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

    for (const keyword of abnormalKeywords) {
      if (conclusion.includes(keyword)) return true;
    }

    // Check conclusionCode
    const conclusionCode = dr["conclusionCode"] as
      | Array<{
          coding?: Array<{ code?: string; display?: string }>;
          text?: string;
        }>
      | undefined;
    if (conclusionCode) {
      for (const cc of conclusionCode) {
        const text = cc.text?.toLowerCase() || "";
        for (const keyword of abnormalKeywords) {
          if (text.includes(keyword)) return true;
        }
      }
    }

    return false;
  }

  private mapObservation(obs: Record<string, unknown>): AbnormalResult {
    const code = obs["code"] as {
      coding?: Array<{ code?: string; display?: string; system?: string }>;
      text?: string;
    };
    const valueQuantity = obs["valueQuantity"] as {
      value?: number;
      unit?: string;
    };
    const interpretation = obs["interpretation"] as
      | Array<{ coding?: Array<{ code?: string; display?: string }> }>
      | undefined;
    const effectiveDateTime = (obs["effectiveDateTime"] as string) || "";

    return {
      resourceType: "Observation",
      resourceId: obs["id"] as string,
      date: effectiveDateTime,
      code: code?.coding?.[0]?.code || "unknown",
      display: code?.text || code?.coding?.[0]?.display || "Unknown Test",
      value: valueQuantity?.value?.toString(),
      unit: valueQuantity?.unit,
      interpretation:
        interpretation?.[0]?.coding?.[0]?.display ||
        interpretation?.[0]?.coding?.[0]?.code,
      status: obs["status"] as string,
      reference: `Observation/${obs["id"]}`,
    };
  }

  private mapDiagnosticReport(dr: Record<string, unknown>): AbnormalResult {
    const code = dr["code"] as {
      coding?: Array<{ code?: string; display?: string }>;
      text?: string;
    };
    const effectiveDateTime = (dr["effectiveDateTime"] as string) || "";

    return {
      resourceType: "DiagnosticReport",
      resourceId: dr["id"] as string,
      date: effectiveDateTime,
      code: code?.coding?.[0]?.code || "unknown",
      display: code?.text || code?.coding?.[0]?.display || "Unknown Report",
      interpretation: dr["conclusion"] as string,
      status: dr["status"] as string,
      reference: `DiagnosticReport/${dr["id"]}`,
    };
  }
}

export const FindRecentAbnormalResultsToolInstance =
  new FindRecentAbnormalResultsTool();
