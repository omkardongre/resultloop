import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { IMcpTool } from "../tools/IMcpTool.js";
import { z } from "zod";
import { FhirUtilities } from "../fhir/fhir-utilities.js";
import { fhirClient } from "../fhir/fhir-client.js";
import {
  buildResultContext,
  isLinkedToResult,
  ResultContext,
} from "../fhir/result-linkage.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { logger } from "../util/logger.js";

/**
 * Evidence record for a single resource type check.
 */
interface FollowUpEvidence {
  resourceType: string;
  found: number;
  references: string[];
  unlinkedFound: number;
  unlinkedReferences: string[];
  searchError?: string;
}

/**
 * Tool 2: get_result_followup_context
 *
 * Given an abnormal result reference and its date, searches for downstream
 * follow-up evidence: ServiceRequest, Task, Communication, CarePlan, and
 * Encounter resources created AFTER the abnormal result date.
 *
 * This is the core audit logic that detects "open loops" — abnormal results
 * with no documented follow-up action in the patient record.
 */
class GetResultFollowupContextTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "get_result_followup_context",
      {
        description:
          "Checks whether documented follow-up exists for a specific abnormal result. " +
          "Searches for ServiceRequest, Task, Communication, CarePlan, and " +
          "Encounter resources created after the result date to determine if " +
          "the clinical team acted on that abnormal finding. Returns closure " +
          "status: OPEN_LOOP (no follow-up evidence) or CLOSED (follow-up found).",
        inputSchema: {
          patientId: z
            .string()
            .describe(
              "The patient ID. Optional if patient context already exists.",
            )
            .optional(),
          resultReference: z
            .string()
            .describe(
              "The FHIR reference of the abnormal result (e.g., 'Observation/123' or 'DiagnosticReport/456').",
            ),
          resultDate: z
            .string()
            .describe(
              "The date of the abnormal result in ISO format (e.g., '2026-01-15'). " +
                "Follow-up evidence is searched AFTER this date.",
            ),
        },
      },
      async ({ patientId, resultReference, resultDate }) => {
        try {
          if (!patientId) {
            patientId = FhirUtilities.getPatientIdOrThrow(req);
          }

          logger.info(
            { patientId, resultReference, resultDate },
            "Auditing follow-up closure for abnormal result",
          );

          const evidenceChecked: FollowUpEvidence[] = [];
          let totalFollowUpFound = 0;
          const searchErrors: string[] = [];
          const resultContext = await this.getResultContext(
            req,
            resultReference,
          );

          // Search each follow-up resource type AFTER the result date
          const resourceTypesToCheck = [
            "ServiceRequest",
            "Task",
            "Communication",
            "CarePlan",
            "Encounter",
          ];

          for (const resourceType of resourceTypesToCheck) {
            const evidence = await this.searchFollowUp(
              req,
              patientId,
              resourceType,
              resultDate,
              resultContext,
            );
            evidenceChecked.push(evidence);
            totalFollowUpFound += evidence.found;
            if (evidence.searchError) {
              searchErrors.push(`${resourceType}: ${evidence.searchError}`);
            }
          }

          const closureStatus =
            totalFollowUpFound === 0 ? "OPEN_LOOP" : "CLOSED";
          const riskLevel = totalFollowUpFound === 0 ? "HIGH" : "LOW";
          // If any search errored, we cannot assert a clean CLOSED/OPEN_LOOP verdict.
          const shouldAbstain = searchErrors.length > 0;

          const daysSinceResult = Math.floor(
            (Date.now() - new Date(resultDate).getTime()) /
              (1000 * 60 * 60 * 24),
          );

          logger.info(
            {
              patientId,
              resultReference,
              closureStatus,
              totalFollowUpFound,
              daysSinceResult,
            },
            "Follow-up closure audit complete",
          );

          return McpUtilities.createJsonResponse({
            closureStatus,
            riskLevel,
            shouldAbstain,
            patientId,
            auditedResult: resultReference,
            resultDate,
            daysSinceResult,
            totalFollowUpEvidenceFound: totalFollowUpFound,
            evidenceChecked,
            searchErrors: searchErrors.length > 0 ? searchErrors : undefined,
            abstainReason: shouldAbstain
              ? "One or more FHIR search queries failed. The closure verdict may be incomplete; a clinician should not rely solely on this report."
              : undefined,
            summary:
              closureStatus === "OPEN_LOOP"
                ? `OPEN LOOP DETECTED: Abnormal result (${resultReference}) from ${resultDate} ` +
                  `(${daysSinceResult} days ago) has NO documented follow-up. ` +
                  `Checked ${resourceTypesToCheck.length} resource types: ` +
                  `${resourceTypesToCheck.join(", ")}. Zero follow-up evidence found.`
                : `CLOSED: Abnormal result (${resultReference}) from ${resultDate} ` +
                  `has ${totalFollowUpFound} documented follow-up action(s).`,
            nextStep:
              closureStatus === "OPEN_LOOP"
                ? "Use 'generate_result_closure_summary' to create a structured closure audit report with draft follow-up tasks."
                : "No further action needed. Follow-up evidence exists for this result.",
            safetyNote:
              "This is an automated audit. All findings require clinician review before action.",
          });
        } catch (error) {
          logger.error({ error }, "Failed to audit follow-up context");
          return McpUtilities.createTextResponse(
            `Error auditing follow-up context: ${error instanceof Error ? error.message : "Unknown error"}`,
            { isError: true },
          );
        }
      },
    );
  }

  /**
   * Search for follow-up resources of a given type created after the result date.
   */
  private async searchFollowUp(
    req: Request,
    patientId: string,
    resourceType: string,
    afterDate: string,
    resultContext: ResultContext,
  ): Promise<FollowUpEvidence> {
    try {
      // Build date parameter based on resource type
      const dateParam = this.getDateParamName(resourceType);
      // FHIR R4 Task does not support `patient` as a standard search parameter —
      // it must be queried via `subject=Patient/<id>`. All other resources
      // (ServiceRequest, Communication, CarePlan, Encounter) support `patient=<id>`.
      const patientParam =
        resourceType === "Task"
          ? `subject=Patient/${patientId}`
          : `patient=${patientId}`;

      const bundle = await fhirClient.search(req, resourceType, [
        patientParam,
        `${dateParam}=ge${afterDate}`,
        `_count=10`,
        `_sort=-${dateParam}`,
      ]);

      const entries = bundle.entry || [];
      const linkedReferences: string[] = [];
      const unlinkedReferences: string[] = [];

      for (const entry of entries) {
        const resource = entry.resource as unknown as Record<string, unknown>;
        if (!resource) continue;

        const reference = `${resource["resourceType"]}/${resource["id"]}`;
        if (isLinkedToResult(resource, resultContext)) {
          linkedReferences.push(reference);
        } else {
          unlinkedReferences.push(reference);
        }
      }

      return {
        resourceType,
        found: linkedReferences.length,
        references: linkedReferences.slice(0, 5), // Cap at 5 references for readability
        unlinkedFound: unlinkedReferences.length,
        unlinkedReferences: unlinkedReferences.slice(0, 5),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.warn(
        { resourceType, error: message },
        "Failed to search follow-up resource type",
      );

      return {
        resourceType,
        found: 0,
        references: [],
        unlinkedFound: 0,
        unlinkedReferences: [],
        searchError: message,
      };
    }
  }

  /**
   * Get the appropriate date search parameter for each resource type.
   */
  private getDateParamName(resourceType: string): string {
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

  private async getResultContext(
    req: Request,
    resultReference: string,
  ): Promise<ResultContext> {
    const result = await fhirClient.read<Record<string, unknown>>(
      req,
      resultReference,
    );

    return buildResultContext(resultReference, result);
  }
}

export const GetResultFollowupContextToolInstance =
  new GetResultFollowupContextTool();
