import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { z } from "zod";
import { IMcpTool } from "./IMcpTool.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { FhirUtilities } from "../fhir/fhir-utilities.js";
import { logger } from "../util/logger.js";
import { storeReport } from "./report-store.js";
import { config } from "../config.js";
import {
  generateAuditReportHtml,
  AuditReportData,
  AuditReportResult,
} from "./report-template.js";

const evidenceItemSchema = z.object({
  resourceType: z.string(),
  found: z.boolean(),
  count: z.number(),
  references: z.array(z.string()).default([]),
});

const resultSchema = z.object({
  reference: z.string().describe("FHIR reference e.g. 'Observation/123'"),
  display: z
    .string()
    .describe("Human-readable name e.g. 'Screening Mammogram'"),
  date: z.string().describe("ISO date of the result"),
  value: z.string().describe("Result value or finding text"),
  closureStatus: z
    .enum(["OPEN_LOOP", "CLOSED", "INSUFFICIENT_EVIDENCE"])
    .describe("Closure status from audit"),
  riskLevel: z
    .string()
    .describe("Risk level: HIGH, MEDIUM, LOW")
    .default("LOW"),
  daysSinceResult: z.number().describe("Days since the result was recorded"),
  evidenceMatrix: z
    .array(evidenceItemSchema)
    .describe("Evidence checked per FHIR resource type")
    .default([]),
});

const longitudinalSchema = z
  .object({
    patternSeverity: z.string().default("LOW"),
    closureRate: z.number().default(0),
    totalAbnormal: z.number().default(0),
    totalClosed: z.number().default(0),
    repeatedTypes: z
      .array(
        z.object({
          type: z.string(),
          count: z.number(),
          openCount: z.number(),
        }),
      )
      .default([]),
  })
  .optional();

class GenerateAuditReportTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "generate_audit_report",
      {
        description:
          "Generates a visual HTML clinical safety audit report from the audit data collected by " +
          "other ResultLoop tools (find_recent_abnormal_results, get_result_followup_context, " +
          "generate_result_closure_summary, rank_open_loops_by_severity, get_patient_loop_history). " +
          "Returns a view_url where the clinician can view the beautifully formatted report in " +
          "their browser with severity cards, timeline charts, evidence matrices, and clinical " +
          "disclaimers. IMPORTANT: This tool only renders an audit report — it does NOT diagnose " +
          "or order care.",
        inputSchema: {
          patientId: z
            .string()
            .describe(
              "The patient ID. Prompt Opinion patient context is authoritative when available.",
            ),
          patientDisplay: z
            .string()
            .describe(
              "Patient display name for the report header (e.g., 'Maria Lopez'). Optional.",
            )
            .optional(),
          results: z
            .array(resultSchema)
            .describe(
              "Array of audit results to include in the report. Each result should contain " +
                "reference, display, date, value, closureStatus, riskLevel, daysSinceResult, " +
                "and evidenceMatrix from previous tool calls.",
            ),
          longitudinalPattern: longitudinalSchema.describe(
            "Optional longitudinal pattern data from get_patient_loop_history.",
          ),
        },
      },
      async ({ patientId, patientDisplay, results, longitudinalPattern }) => {
        try {
          patientId = FhirUtilities.getPatientIdOrThrow(req, patientId);

          logger.info(
            {
              patientId,
              resultCount: results.length,
              hasLongitudinal: !!longitudinalPattern,
            },
            "Generating visual audit report",
          );

          const reportData: AuditReportData = {
            patientId,
            patientDisplay,
            generatedAt: new Date().toISOString(),
            results: results as AuditReportResult[],
            longitudinalPattern: longitudinalPattern
              ? {
                  patternSeverity: longitudinalPattern.patternSeverity,
                  closureRate: longitudinalPattern.closureRate,
                  totalAbnormal: longitudinalPattern.totalAbnormal,
                  totalClosed: longitudinalPattern.totalClosed,
                  repeatedTypes: longitudinalPattern.repeatedTypes,
                }
              : undefined,
          };

          // Generate the HTML report
          const html = generateAuditReportHtml(reportData);

          // Store it and get a reportId
          const reportId = storeReport(html);

          // Build the view URL using the configured public base URL
          const viewUrl = `${config.publicBaseUrl}/report/${reportId}`;

          logger.info(
            { patientId, reportId, viewUrl },
            "Audit report generated and stored",
          );

          const openCount = results.filter(
            (r) => r.closureStatus !== "CLOSED",
          ).length;
          const closedCount = results.filter(
            (r) => r.closureStatus === "CLOSED",
          ).length;

          return McpUtilities.createJsonResponse({
            status: "report_generated",
            reportId,
            viewUrl,
            summary: {
              totalResults: results.length,
              openLoops: openCount,
              closed: closedCount,
              patientId,
            },
            safetyNote:
              "This visual report is generated for clinician review only. " +
              "It does NOT constitute a diagnosis, treatment recommendation, " +
              "or clinical order. All findings require human verification.",
          });
        } catch (error) {
          logger.error({ error }, "Failed to generate audit report");
          return McpUtilities.createTextResponse(
            `Error generating audit report: ${error instanceof Error ? error.message : "Unknown error"}`,
            { isError: true },
          );
        }
      },
    );
  }
}

export const GenerateAuditReportToolInstance = new GenerateAuditReportTool();
