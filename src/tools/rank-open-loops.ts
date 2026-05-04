import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { z } from "zod";
import { rankOpenLoopsBySeverity } from "../clinical/open-loop-ranking.js";
import { IMcpTool } from "../tools/IMcpTool.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { logger } from "../util/logger.js";

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
  daysSinceResult: z.number().optional(),
  totalFollowUpEvidenceFound: z.number().optional(),
});

class RankOpenLoopsBySeverityTool implements IMcpTool {
  registerTool(server: McpServer, _req: Request) {
    server.registerTool(
      "rank_open_loops_by_severity",
      {
        description:
          "Ranks abnormal results or confirmed open result loops by deterministic clinical severity and timeliness. " +
          "Uses source-cited thresholds for BI-RADS, Lung-RADS, HbA1c, eGFR, TSH, potassium, positive FIT, and hemoglobin. " +
          "This tool does not diagnose or order care; it prioritizes clinician review queues.",
        inputSchema: {
          openLoops: z
            .array(openLoopCandidateSchema)
            .describe(
              "Abnormal result or open-loop candidates from find_recent_abnormal_results and get_result_followup_context.",
            ),
          asOfDate: z
            .string()
            .describe("Optional ISO date for deterministic ranking in tests or demos.")
            .optional(),
        },
      },
      async ({ openLoops, asOfDate }) => {
        try {
          const parsedAsOfDate = asOfDate ? new Date(asOfDate) : new Date();
          const ranked = rankOpenLoopsBySeverity(openLoops, parsedAsOfDate);

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
