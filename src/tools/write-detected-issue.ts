import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { z } from "zod";
import { fhirClient } from "../fhir/fhir-client.js";
import { FhirUtilities } from "../fhir/fhir-utilities.js";
import { IMcpTool } from "./IMcpTool.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { logger } from "../util/logger.js";
import { sha256CanonicalJson } from "../clinical/draft-followup-task.js";

/**
 * write_detected_issue
 *
 * Writes a FHIR R4 DetectedIssue resource to the patient chart for each
 * open-loop abnormal result flagged as HIGH or MODERATE risk by the
 * Closure Risk Index (CRI). This makes the patient safety concern
 * EHR-native and surfaceable by any downstream CDS system.
 *
 * Per HL7 FHIR R4 spec, DetectedIssue covers:
 *   "the lack of an action which should be planned" and "gaps in care"
 *   — both of which are exactly what an open-loop abnormal result represents.
 *
 * What is written:
 *   - DetectedIssue (status=final, severity=high/moderate/low)
 *       - code: CAREGAP (HL7 ActCode) — care gap / follow-up failure
 *       - patient: subject reference
 *       - implicated: references to the abnormal result FHIR resources
 *       - detail: human-readable description with CRI score and days elapsed
 *       - identified: when the gap was detected
 *   - Provenance linked to the DetectedIssue
 *
 * Safety:
 *   - Only written for OPEN_LOOP results — blocked for CLOSED
 *   - Requires clinicianApprovalConfirmed: true
 *   - Does not diagnose, treat, or order clinical actions
 */
class WriteDetectedIssueTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "write_detected_issue",
      {
        description:
          "Writes a FHIR R4 DetectedIssue resource to the patient chart for an open-loop abnormal " +
          "result flagged by ResultLoop. A DetectedIssue formally records a patient safety concern — " +
          "'lack of documented follow-up for an abnormal result' — in the EHR, making it surfaceable " +
          "by any downstream clinical decision support system. " +
          "Only valid for OPEN_LOOP results. Requires explicit clinician approval. " +
          "Does NOT diagnose, treat, or order clinical actions.",
        inputSchema: {
          clinicianApprovalConfirmed: z
            .boolean()
            .describe(
              "Must be true. The clinician must explicitly approve writing the DetectedIssue to FHIR. " +
              "Never set to true without explicit clinician confirmation in the same conversation turn.",
            ),
          patientId: z
            .string()
            .describe(
              "The patient ID. Prompt Opinion patient context is authoritative when available.",
            )
            .optional(),
          resultReference: z
            .string()
            .describe(
              "FHIR reference to the abnormal result, e.g. 'DiagnosticReport/abc' or 'Observation/xyz'.",
            ),
          resultDisplay: z
            .string()
            .describe(
              "Human-readable name of the abnormal result, e.g. 'BI-RADS 4 Screening Mammogram'.",
            ),
          resultDate: z
            .string()
            .describe("Date the result was issued (ISO 8601)."),
          closureStatus: z
            .enum(["OPEN_LOOP", "CLOSED", "INSUFFICIENT_EVIDENCE"])
            .describe("Closure status from generate_result_closure_summary. Must be OPEN_LOOP."),
          criScore: z
            .number()
            .describe(
              "Closure Risk Index score (0–100) from rank_open_loops_by_severity.",
            )
            .optional(),
          criSeverity: z
            .enum(["HIGH", "MODERATE", "LOW", "CRITICAL"])
            .describe("CRI severity tier from rank_open_loops_by_severity.")
            .optional(),
          daysElapsed: z
            .number()
            .describe("Number of days since the result was issued with no follow-up.")
            .optional(),
          issueDetail: z
            .string()
            .describe(
              "Plain-language description of the open-loop concern, " +
              "e.g. 'BI-RADS 4 mammogram on 2026-03-10 — no documented follow-up in 62 days. CRI 87/100 HIGH RISK.'",
            ),
        },
      },
      async ({
        clinicianApprovalConfirmed,
        patientId,
        resultReference,
        resultDisplay,
        resultDate,
        closureStatus,
        criScore,
        criSeverity,
        daysElapsed,
        issueDetail,
      }) => {
        try {
          patientId = FhirUtilities.getPatientIdOrThrow(req, patientId);

          if (clinicianApprovalConfirmed !== true) {
            return McpUtilities.createJsonResponse({
              status: "not_written",
              errorCode: "CLINICIAN_APPROVAL_NOT_CONFIRMED",
              message:
                "No DetectedIssue was written. Clinician approval was not confirmed in this conversation. " +
                "Call write_detected_issue again with clinicianApprovalConfirmed=true to proceed.",
              resultReference,
              fhirWritesPerformed: false,
              safetyNote:
                "ResultLoop never writes to FHIR without explicit clinician approval.",
            });
          }

          if (closureStatus !== "OPEN_LOOP") {
            return McpUtilities.createJsonResponse({
              status: "not_written",
              errorCode: "RESULT_NOT_OPEN_LOOP",
              message:
                `DetectedIssue not written: result is ${closureStatus}, not OPEN_LOOP. ` +
                "A DetectedIssue for a non-open result is clinically inappropriate.",
              resultReference,
              fhirWritesPerformed: false,
            });
          }

          const now = new Date().toISOString();

          const fhirSeverity = mapCriSeverityToFhir(criSeverity);

          const detectedIssue: Record<string, unknown> = {
            resourceType: "DetectedIssue",
            status: "final",
            code: {
              coding: [
                {
                  system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
                  code: "CAREGAP",
                  display: "Care Gap",
                },
              ],
              text: "Abnormal result follow-up gap — no documented clinical action found",
            },
            severity: fhirSeverity,
            patient: {
              reference: `Patient/${patientId}`,
            },
            identifiedDateTime: now,
            author: {
              display: "ResultLoop MCP — Abnormal Result Follow-up Audit",
            },
            implicated: [
              {
                reference: resultReference,
                display: resultDisplay,
              },
            ],
            detail: issueDetail,
            extension: [
              {
                url: "urn:resultloop:detected-issue-metadata",
                extension: [
                  ...(criScore !== undefined
                    ? [{ url: "criScore", valueInteger: Math.round(criScore) }]
                    : []),
                  ...(criSeverity !== undefined
                    ? [{ url: "criSeverity", valueString: criSeverity }]
                    : []),
                  ...(daysElapsed !== undefined
                    ? [{ url: "daysElapsed", valueInteger: daysElapsed }]
                    : []),
                  {
                    url: "resultDate",
                    valueDate: resultDate,
                  },
                  {
                    url: "detectedBy",
                    valueString: "ResultLoop MCP — Abnormal Result Follow-up Audit",
                  },
                  {
                    url: "artifactHash",
                    valueString: `urn:sha-256:${sha256CanonicalJson({ resultReference, resultDate, closureStatus, patientId })}`,
                  },
                ],
              },
            ],
          };

          const createdIssue = await fhirClient.create<Record<string, unknown>>(
            req,
            detectedIssue,
          );
          const issueId = createdIssue["id"] as string | undefined;
          const issueRef = issueId
            ? `DetectedIssue/${issueId}`
            : "DetectedIssue/(id not returned)";

          const provenance: Record<string, unknown> = {
            resourceType: "Provenance",
            target: [{ reference: issueRef }],
            recorded: now,
            agent: [
              {
                type: {
                  coding: [
                    {
                      system: "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
                      code: "author",
                      display: "Author",
                    },
                  ],
                },
                who: {
                  display: "ResultLoop MCP — Abnormal Result Follow-up Audit",
                },
              },
            ],
            entity: [
              {
                role: "source",
                what: {
                  reference: resultReference,
                  display: resultDisplay,
                },
              },
            ],
          };

          const createdProvenance = await fhirClient.create<Record<string, unknown>>(
            req,
            provenance,
          );
          const provenanceId = createdProvenance["id"] as string | undefined;
          const provenanceRef = provenanceId
            ? `Provenance/${provenanceId}`
            : "Provenance/(id not returned)";

          logger.info(
            { patientId, resultReference, issueRef, provenanceRef, fhirSeverity },
            "DetectedIssue written by ResultLoop for open-loop abnormal result",
          );

          return McpUtilities.createJsonResponse({
            status: "written",
            message:
              `A DetectedIssue has been written to the patient's FHIR chart formally recording the open-loop safety concern for ${resultDisplay}. ` +
              "It can be retrieved by any downstream clinical decision support system via DetectedIssue?patient=" +
              patientId,
            detectedIssueId: issueRef,
            provenanceReference: provenanceRef,
            resultReference,
            patientId,
            fhirSeverity,
            criScore,
            criSeverity,
            daysElapsed,
            safetyNote:
              "This DetectedIssue is a formal patient safety record for clinician review. " +
              "It does NOT constitute a diagnosis or clinical order. " +
              "All findings require human verification before any clinical action is taken.",
            fhirWritesPerformed: true,
            resourcesCreated: ["DetectedIssue", "Provenance"],
          });
        } catch (error) {
          logger.error({ error }, "Failed to write DetectedIssue to FHIR");
          return McpUtilities.createTextResponse(
            `Error writing DetectedIssue to FHIR: ${error instanceof Error ? error.message : "Unknown error"}`,
            { isError: true },
          );
        }
      },
    );
  }
}

function mapCriSeverityToFhir(
  criSeverity: "HIGH" | "MODERATE" | "LOW" | "CRITICAL" | undefined,
): "high" | "moderate" | "low" {
  switch (criSeverity) {
    case "CRITICAL":
    case "HIGH":
      return "high";
    case "MODERATE":
      return "moderate";
    case "LOW":
      return "low";
    default:
      return "moderate";
  }
}

export const WriteDetectedIssueToolInstance = new WriteDetectedIssueTool();
