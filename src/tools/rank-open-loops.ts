import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { z } from "zod";
import {
  OpenLoopCandidate,
  rankOpenLoopsBySeverity,
} from "../clinical/open-loop-ranking.js";
import { fhirClient } from "../fhir/fhir-client.js";
import { IMcpTool } from "../tools/IMcpTool.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { logger } from "../util/logger.js";
import { coerceJsonArray, coerceNumber } from "./schema-coercion.js";

const openLoopCandidateSchema = z.object({
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  reference: z.string(),
  date: z.string(),
  code: z.string().optional(),
  display: z.string().optional(),
  value: z.union([z.string(), z.number()]).optional(),
  unit: z.string().optional(),
  interpretation: z.string().optional(),
  closureStatus: z
    .enum(["OPEN_LOOP", "CLOSED", "NOT_YET_OVERDUE", "INSUFFICIENT_EVIDENCE"])
    .optional(),
  daysSinceResult: coerceNumber.optional(),
  totalFollowUpEvidenceFound: coerceNumber.optional(),
});

class RankOpenLoopsBySeverityTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "rank_open_loops_by_severity",
      {
        description:
          "Ranks abnormal results or confirmed open result loops by deterministic clinical severity and timeliness. " +
          "Uses source-cited thresholds for BI-RADS, Lung-RADS, HbA1c, eGFR, TSH, potassium, positive FIT, and hemoglobin. " +
          "This tool does not diagnose or order care; it prioritizes clinician review queues.",
        inputSchema: {
          openLoops: coerceJsonArray(openLoopCandidateSchema).describe(
            "Abnormal result or open-loop candidates from find_recent_abnormal_results and get_result_followup_context.",
          ),
          asOfDate: z
            .string()
            .describe(
              "Optional ISO date for deterministic ranking in tests or demos.",
            )
            .optional(),
        },
      },
      async ({ openLoops, asOfDate }) => {
        try {
          const parsedAsOfDate = asOfDate ? new Date(asOfDate) : new Date();
          const enrichedOpenLoops = await Promise.all(
            openLoops.map((candidate) =>
              enrichCandidateFromFhir(req, candidate),
            ),
          );
          const ranked = rankOpenLoopsBySeverity(
            enrichedOpenLoops,
            parsedAsOfDate,
          );

          logger.info(
            {
              inputCount: openLoops.length,
              rankedCount: ranked.length,
              topReference: ranked[0]?.reference,
            },
            "Ranked open loops by severity",
          );

          return McpUtilities.createJsonResponse({
            status: "ranked_open_loops",
            rankedCount: ranked.length,
            excludedClosedCount: openLoops.length - ranked.length,
            asOfDate: parsedAsOfDate.toISOString(),
            rankedOpenLoops: ranked,
            safetyNote:
              "Ranking is deterministic review prioritization only. Clinicians must verify all findings before action.",
          });
        } catch (error) {
          logger.error({ error }, "Failed to rank open loops by severity");
          return McpUtilities.createTextResponse(
            `Error ranking open loops: ${error instanceof Error ? error.message : "Unknown error"}`,
            { isError: true },
          );
        }
      },
    );
  }
}

export const RankOpenLoopsBySeverityToolInstance =
  new RankOpenLoopsBySeverityTool();

async function enrichCandidateFromFhir(
  req: Request,
  candidate: OpenLoopCandidate,
): Promise<OpenLoopCandidate> {
  try {
    const resource = await fhirClient.read<Record<string, unknown>>(
      req,
      candidate.reference,
    );

    if (!resource) {
      return candidate;
    }

    if (resource["resourceType"] === "DiagnosticReport") {
      return enrichDiagnosticReportCandidate(candidate, resource);
    }

    if (resource["resourceType"] === "Observation") {
      return enrichObservationCandidate(candidate, resource);
    }

    return candidate;
  } catch (error) {
    logger.warn(
      { error, reference: candidate.reference },
      "Unable to enrich open-loop candidate from FHIR source",
    );
    return candidate;
  }
}

function enrichDiagnosticReportCandidate(
  candidate: OpenLoopCandidate,
  resource: Record<string, unknown>,
): OpenLoopCandidate {
  const code = resource["code"] as
    | { text?: string; coding?: Array<{ code?: string; display?: string }> }
    | undefined;
  const conclusionCode = resource["conclusionCode"] as
    | Array<{
        text?: string;
        coding?: Array<{ display?: string; code?: string }>;
      }>
    | undefined;
  const conclusionText = [
    resource["conclusion"],
    ...(conclusionCode || []).flatMap((item) => [
      item.text,
      ...(item.coding || []).flatMap((coding) => [coding.display, coding.code]),
    ]),
  ]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .join(" ");

  return {
    ...candidate,
    code: candidate.code ?? code?.coding?.[0]?.code,
    display: candidate.display ?? code?.text ?? code?.coding?.[0]?.display,
    interpretation: [candidate.interpretation, conclusionText]
      .filter(Boolean)
      .join(" "),
  };
}

function enrichObservationCandidate(
  candidate: OpenLoopCandidate,
  resource: Record<string, unknown>,
): OpenLoopCandidate {
  const code = resource["code"] as
    | { text?: string; coding?: Array<{ code?: string; display?: string }> }
    | undefined;
  const valueQuantity = resource["valueQuantity"] as
    | { value?: number; unit?: string }
    | undefined;
  const interpretation = resource["interpretation"] as
    | Array<{ coding?: Array<{ code?: string; display?: string }> }>
    | undefined;

  return {
    ...candidate,
    code: candidate.code ?? code?.coding?.[0]?.code,
    display: candidate.display ?? code?.text ?? code?.coding?.[0]?.display,
    value: candidate.value ?? valueQuantity?.value,
    unit: candidate.unit ?? valueQuantity?.unit,
    interpretation:
      candidate.interpretation ??
      interpretation?.[0]?.coding?.[0]?.display ??
      interpretation?.[0]?.coding?.[0]?.code,
  };
}
