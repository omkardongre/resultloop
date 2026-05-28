import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { z } from "zod";
import { fhirClient } from "../fhir/fhir-client.js";
import { FhirUtilities } from "../fhir/fhir-utilities.js";
import { IMcpTool } from "../tools/IMcpTool.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { logger } from "../util/logger.js";
import { sha256CanonicalJson } from "../clinical/draft-followup-task.js";
import { coerceBoolean } from "./schema-coercion.js";

/**
 * write_followup_task
 *
 * Writes a FHIR R4 Task + Provenance to the workspace FHIR server for an open-loop
 * abnormal result. This is the only ResultLoop tool that POSTs to FHIR.
 *
 * Safety gates (all must pass before any FHIR write):
 *   1. clinicianApprovalConfirmed must be explicitly true — the clinician has reviewed
 *      and approved the write in the same conversation turn.
 *   2. closureStatus must be OPEN_LOOP — writing a Task for a closed result is harmful.
 *   3. The result reference (Observation or DiagnosticReport) must exist on the FHIR server.
 *
 * What is written:
 *   - Task (status=requested, intent=order, priority) linked to the result via Task.focus
 *   - Provenance linked to the Task, citing ResultLoop MCP as agent
 *
 * What is NOT done:
 *   - No MedicationRequest, no ClinicalImpression, no patient contact
 *   - No write if any safety gate fails
 */
class WriteFollowupTaskTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "write_followup_task",
      {
        description:
          "Writes a FHIR R4 Task (status=requested) and linked Provenance record to the workspace FHIR server " +
          "for a confirmed open-loop abnormal result. Requires explicit clinician approval in the same conversation. " +
          "This is the only ResultLoop tool that writes to FHIR. " +
          "Do NOT call unless the clinician has explicitly approved the write in this conversation turn. " +
          "Do NOT call for closed results, worklists, ranking, or draft-only requests — use draft_followup_task_resource instead.",
        inputSchema: {
          clinicianApprovalConfirmed: coerceBoolean.describe(
            "Must be true only when the clinician has explicitly approved writing this Task to the FHIR server in this conversation. Must be false for draft-only, preview, or worklist requests.",
          ),
          patientId: z
            .string()
            .describe(
              "The patient ID. Optional; Prompt Opinion patient context is authoritative.",
            )
            .optional(),
          resultReference: z
            .string()
            .describe(
              "FHIR reference for the open-loop abnormal result, e.g. DiagnosticReport/cb94f0b2 or Observation/abc123.",
            ),
          resultDisplay: z
            .string()
            .describe("Human-readable result name, e.g. 'Screening Mammogram (BI-RADS 4)'."),
          resultDate: z
            .string()
            .describe("ISO date of the abnormal result."),
          resultValue: z
            .string()
            .describe("Result value or conclusion text.")
            .optional(),
          closureStatus: z
            .enum(["OPEN_LOOP", "CLOSED", "INSUFFICIENT_EVIDENCE"])
            .describe(
              "Closure status confirmed by get_result_followup_context. Must be OPEN_LOOP to proceed.",
            ),
          priority: z
            .enum(["routine", "urgent", "asap", "stat"])
            .describe("FHIR Task priority. Use urgent for imaging/critical results, routine otherwise.")
            .optional(),
          taskDescription: z
            .string()
            .describe(
              "Plain-language description of the follow-up action required, e.g. 'Review BI-RADS 4 mammogram from 2026-03-10. No documented follow-up in 58 days.'",
            ),
        },
      },
      async ({
        clinicianApprovalConfirmed,
        patientId,
        resultReference,
        resultDisplay,
        resultDate,
        resultValue,
        closureStatus,
        priority,
        taskDescription,
      }) => {
        try {
          patientId = FhirUtilities.getPatientIdOrThrow(req, patientId);

          if (clinicianApprovalConfirmed !== true) {
            return McpUtilities.createJsonResponse({
              status: "not_written",
              errorCode: "CLINICIAN_APPROVAL_NOT_CONFIRMED",
              message:
                "No Task was written to FHIR. Clinician approval was not confirmed in this conversation. " +
                "Use draft_followup_task_resource to preview the Task JSON before approving.",
              resultReference,
              safetyNote:
                "ResultLoop never writes to FHIR without explicit clinician approval. " +
                "Call write_followup_task again with clinicianApprovalConfirmed=true to proceed.",
              fhirWritesPerformed: false,
            });
          }

          if (closureStatus !== "OPEN_LOOP") {
            return McpUtilities.createJsonResponse({
              status: "not_written",
              errorCode: "RESULT_NOT_OPEN_LOOP",
              message: `Task not written: result is ${closureStatus}, not OPEN_LOOP. Writing a follow-up Task for a non-open result is a patient safety risk.`,
              resultReference,
              fhirWritesPerformed: false,
            });
          }

          const resultResource = await fhirClient.read<Record<string, unknown>>(req, resultReference);
          if (!resultResource) {
            return McpUtilities.createJsonResponse(
              {
                status: "not_written",
                errorCode: "RESULT_REFERENCE_NOT_FOUND",
                message: `The result reference ${resultReference} could not be found on the FHIR server. No Task was written.`,
                fhirWritesPerformed: false,
              },
              { isError: true },
            );
          }

          const now = new Date().toISOString();
          const artifactHash = sha256CanonicalJson({ resultReference, resultDate, closureStatus, patientId });

          const task: Record<string, unknown> = {
            resourceType: "Task",
            status: "requested",
            intent: "order",
            priority: priority ?? "urgent",
            code: {
              coding: [
                {
                  system: "http://loinc.org",
                  code: "72133-0",
                  display: "Follow-up requested",
                },
              ],
              text: "Abnormal result follow-up required",
            },
            description: taskDescription,
            focus: {
              reference: resultReference,
              display: resultDisplay,
            },
            for: {
              reference: `Patient/${patientId}`,
            },
            authoredOn: now,
            lastModified: now,
            requester: {
              display: "ResultLoop MCP",
            },
            reasonReference: {
              reference: resultReference,
              display: `${resultDisplay}${resultValue ? `: ${resultValue}` : ""}`,
            },
            note: [
              {
                time: now,
                text: `ResultLoop follow-up Task. Abnormal result date: ${resultDate}. Closure status: ${closureStatus}. ` +
                  "Written after explicit clinician approval. Clinician must verify and complete this task.",
              },
            ],
          };

          const createdTask = await fhirClient.create<Record<string, unknown>>(req, task);
          const taskId = createdTask["id"] as string | undefined;
          const taskRef = taskId ? `Task/${taskId}` : "Task/(id not returned)";

          const provenance: Record<string, unknown> = {
            resourceType: "Provenance",
            target: [{ reference: taskRef }],
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
              {
                role: "derivation",
                what: {
                  identifier: {
                    system: "urn:ietf:rfc:3986",
                    value: `urn:sha-256:${artifactHash}`,
                  },
                  display: "ResultLoop closure audit artifact hash",
                },
              },
            ],
          };

          const createdProvenance = await fhirClient.create<Record<string, unknown>>(req, provenance);
          const provenanceId = createdProvenance["id"] as string | undefined;
          const provenanceRef = provenanceId ? `Provenance/${provenanceId}` : "Provenance/(id not returned)";

          logger.info(
            { patientId, resultReference, taskRef, provenanceRef },
            "FHIR Task + Provenance written by ResultLoop",
          );

          return McpUtilities.createJsonResponse({
            status: "written",
            message: `Follow-up Task and Provenance have been written to the FHIR server for clinician review.`,
            taskReference: taskRef,
            provenanceReference: provenanceRef,
            resultReference,
            patientId,
            closureArtifactHash: artifactHash,
            safetyNote:
              "Task status is 'requested'. A clinician must review, update, and complete this Task in the EHR. " +
              "ResultLoop does not diagnose, treat, contact patients, or order clinical actions.",
            fhirWritesPerformed: true,
            resourcesCreated: ["Task", "Provenance"],
          });
        } catch (error) {
          logger.error({ error }, "Failed to write follow-up Task to FHIR");
          return McpUtilities.createTextResponse(
            `Error writing follow-up Task: ${error instanceof Error ? error.message : "Unknown error"}`,
            { isError: true },
          );
        }
      },
    );
  }
}

export const WriteFollowupTaskToolInstance = new WriteFollowupTaskTool();
