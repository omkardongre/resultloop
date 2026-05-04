import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { FindRecentAbnormalResultsToolInstance } from "./find-abnormal-results.js";
import { GetResultFollowupContextToolInstance } from "./get-followup-context.js";
import { GenerateResultClosureSummaryToolInstance } from "./generate-closure-summary.js";
import { RankOpenLoopsBySeverityToolInstance } from "./rank-open-loops.js";

/**
 * Register all ResultLoop MCP tools with the server.
 *
 * Tools are registered in audit workflow order:
 * 1. find_recent_abnormal_results    → Scan for abnormal findings
 * 2. get_result_followup_context     → Check if follow-up exists
 * 3. generate_result_closure_summary → Create audit artifact
 */
export function registerAllTools(server: McpServer, req: Request): void {
  FindRecentAbnormalResultsToolInstance.registerTool(server, req);
  GetResultFollowupContextToolInstance.registerTool(server, req);
  GenerateResultClosureSummaryToolInstance.registerTool(server, req);
  RankOpenLoopsBySeverityToolInstance.registerTool(server, req);
}
