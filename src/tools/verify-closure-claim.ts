import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { z } from "zod";
import {
  extractFhirReferences,
  verifyClosureClaim,
} from "../clinical/verify-closure-claim.js";
import { fhirClient } from "../fhir/fhir-client.js";
import { FhirUtilities } from "../fhir/fhir-utilities.js";
import { IMcpTool } from "../tools/IMcpTool.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { logger } from "../util/logger.js";
import { coerceBoolean } from "./schema-coercion.js";

class VerifyClosureClaimTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "verify_closure_claim",
      {
        description:
          "Verifies that a ResultLoop closure audit artifact is grounded in cited FHIR evidence. " +
          "Checks closureStatus consistency, cited FHIR references, OPEN_LOOP/CLOSED evidence rules, " +
          "and optional follow-up context. Returns PASS, INSUFFICIENT_EVIDENCE, or CONTRADICTION. " +
          "Use this after generate_result_closure_summary when the user asks to verify, validate, audit, or check the closure claim.",
        inputSchema: {
          patientId: z
            .string()
            .describe(
              "The patient ID. Optional; Prompt Opinion patient context is authoritative when available.",
            )
            .optional(),
          closureArtifactJson: z
            .string()
            .describe(
              "JSON string returned by generate_result_closure_summary.",
            ),
          followUpContextJson: z
            .string()
            .describe(
              "Optional JSON string returned by get_result_followup_context for the same result.",
            )
            .optional(),
          fetchCitedReferences: coerceBoolean
            .describe(
              "When true, ResultLoop attempts to read cited FHIR references from the current FHIR context before verification. Defaults to true.",
            )
            .optional(),
        },
      },
      async ({
        patientId,
        closureArtifactJson,
        followUpContextJson,
        fetchCitedReferences,
      }) => {
        try {
          patientId = FhirUtilities.getPatientIdOrThrow(req, patientId);

          const closureArtifact = parseJsonObject(
            closureArtifactJson,
            "closureArtifactJson",
          );
          const followUpContext = followUpContextJson
            ? parseJsonObject(followUpContextJson, "followUpContextJson")
            : undefined;

          const shouldFetchReferences = fetchCitedReferences ?? true;
          const fetchedReferences: string[] = [];
          const missingFetchedReferences: string[] = [];

          if (shouldFetchReferences) {
            const references = extractFhirReferences({
              closureArtifact,
              followUpContext,
            }).filter((reference) => !reference.startsWith("Patient/"));

            for (const reference of references) {
              const resource = await fhirClient.read<Record<string, unknown>>(
                req,
                reference,
              );
              if (resource) {
                fetchedReferences.push(reference);
              } else {
                missingFetchedReferences.push(reference);
              }
            }
          }

          const verification = verifyClosureClaim({
            closureArtifact,
            followUpContext,
            fetchedReferences: shouldFetchReferences
              ? fetchedReferences
              : undefined,
            missingFetchedReferences,
          });

          logger.info(
            {
              patientId,
              status: verification.status,
              auditedResult: verification.auditedResult,
              missingReferences: verification.missingReferences.length,
              contradictions: verification.contradictions.length,
            },
            "Verified closure claim",
          );

          return McpUtilities.createJsonResponse({
            ...verification,
            patientId,
            readOnlyInvariant: {
              fhirWritesPerformed: false,
              requiresHumanApproval: true,
            },
          });
        } catch (error) {
          logger.error({ error }, "Failed to verify closure claim");
          return McpUtilities.createTextResponse(
            `Error verifying closure claim: ${error instanceof Error ? error.message : "Unknown error"}`,
            { isError: true },
          );
        }
      },
    );
  }
}

function parseJsonObject(value: string, fieldName: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${fieldName} must be a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${fieldName} must be valid JSON.`);
    }
    throw error;
  }
}

export const VerifyClosureClaimToolInstance = new VerifyClosureClaimTool();
