import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { z } from "zod";
import {
  draftFollowupTaskResource,
  DraftFollowupTaskInput,
} from "../clinical/draft-followup-task.js";
import { fhirClient } from "../fhir/fhir-client.js";
import { FhirUtilities } from "../fhir/fhir-utilities.js";
import { IMcpTool } from "../tools/IMcpTool.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { logger } from "../util/logger.js";

class DraftFollowupTaskResourceTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "draft_followup_task_resource",
      {
        description:
          "Creates draft-only FHIR R4 Task and AuditEvent JSON for clinician review of an open-loop abnormal result. " +
          "Use only when the user explicitly asks to draft or output FHIR Task/AuditEvent workflow artifacts. " +
          "Do not use this tool for safety worklists, urgency checks, ranking, prioritization, or closure summaries. " +
          "This tool validates that the referenced Observation or DiagnosticReport can be fetched, computes a SHA-256 closure artifact hash, and never writes to the FHIR server.",
        inputSchema: {
          draftIntentConfirmed: z
            .boolean()
            .describe(
              "Must be true only when the user's request explicitly asks to draft, create, prepare, or output FHIR Task/AuditEvent workflow artifacts. Must be false for worklist, ranking, prioritization, or urgency-only requests.",
            ),
          patientId: z
            .string()
            .describe(
              "The patient ID. Optional; Prompt Opinion patient context is authoritative when available.",
            )
            .optional(),
          resultReference: z
            .string()
            .describe(
              "FHIR reference for the abnormal result, e.g. Observation/123 or DiagnosticReport/456.",
            ),
          resultDate: z.string().describe("Date of the abnormal result."),
          resultDisplay: z.string().describe("Human-readable result name."),
          resultValue: z
            .string()
            .describe("Result value or conclusion text.")
            .optional(),
          closureStatus: z
            .enum(["OPEN_LOOP", "CLOSED", "INSUFFICIENT_EVIDENCE"])
            .describe(
              "Closure status from get_result_followup_context or generate_result_closure_summary.",
            ),
          priority: z
            .enum(["routine", "urgent", "asap", "stat"])
            .describe("FHIR Task priority. Defaults to urgent for open loops.")
            .optional(),
          planDescription: z
            .string()
            .describe(
              "Plain-language clinician-review plan for the draft Task.",
            ),
          closureArtifactJson: z
            .string()
            .describe(
              "JSON string of the closure artifact to hash and cite in AuditEvent.entity.what.",
            ),
        },
      },
      async ({
        draftIntentConfirmed,
        patientId,
        resultReference,
        resultDate,
        resultDisplay,
        resultValue,
        closureStatus,
        priority,
        planDescription,
        closureArtifactJson,
      }) => {
        try {
          patientId = FhirUtilities.getPatientIdOrThrow(req, patientId);

          if (draftIntentConfirmed !== true) {
            return McpUtilities.createJsonResponse({
              status: "not_created",
              errorCode: "DRAFT_INTENT_NOT_CONFIRMED",
              message:
                "No draft Task or AuditEvent was created because the tool call did not confirm an explicit user request for draft FHIR workflow artifacts.",
              resultReference,
              safetyNote:
                "Use rank_open_loops_by_severity for worklists, urgency checks, and prioritization. Use draft_followup_task_resource only when the user explicitly asks for draft FHIR Task/AuditEvent artifacts.",
              readOnlyInvariant: {
                fhirWritesPerformed: false,
                requiresHumanApproval: true,
              },
            });
          }

          const resultResource = await fhirClient.read<Record<string, unknown>>(
            req,
            resultReference,
          );

          if (!resultResource) {
            return McpUtilities.createJsonResponse(
              {
                status: "not_created",
                errorCode: "RESULT_REFERENCE_NOT_FOUND",
                message:
                  "The abnormal result reference could not be fetched from the FHIR server, so no draft Task was created.",
                resultReference,
                safetyNote:
                  "ResultLoop does not create workflow artifacts unless the cited FHIR result exists.",
              },
              { isError: true },
            );
          }

          let closureArtifact: Record<string, unknown>;
          try {
            closureArtifact = JSON.parse(closureArtifactJson) as Record<
              string,
              unknown
            >;
          } catch {
            return McpUtilities.createJsonResponse(
              {
                status: "not_created",
                errorCode: "INVALID_CLOSURE_ARTIFACT_JSON",
                message: "closureArtifactJson must be valid JSON.",
              },
              { isError: true },
            );
          }

          const input: DraftFollowupTaskInput = {
            patientId,
            resultReference,
            resultDisplay,
            resultDate,
            resultValue,
            closureStatus,
            priority,
            planDescription,
            closureArtifact,
          };

          const draft = draftFollowupTaskResource(input);

          logger.info(
            {
              patientId,
              resultReference,
              status: draft.status,
              hasTask: !!draft.task,
            },
            "Drafted follow-up Task resource",
          );

          return McpUtilities.createJsonResponse({
            ...draft,
            fetchedResult: {
              resourceType: resultResource["resourceType"],
              id: resultResource["id"],
              reference: resultReference,
            },
            readOnlyInvariant: {
              fhirWritesPerformed: false,
              requiresHumanApproval: true,
            },
          });
        } catch (error) {
          logger.error({ error }, "Failed to draft follow-up Task resource");
          return McpUtilities.createTextResponse(
            `Error drafting follow-up Task resource: ${error instanceof Error ? error.message : "Unknown error"}`,
            { isError: true },
          );
        }
      },
    );
  }
}

export const DraftFollowupTaskResourceToolInstance =
  new DraftFollowupTaskResourceTool();
