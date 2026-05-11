import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { FindRecentAbnormalResultsToolInstance } from "./find-abnormal-results.js";
import { GetResultFollowupContextToolInstance } from "./get-followup-context.js";
import { GenerateResultClosureSummaryToolInstance } from "./generate-closure-summary.js";
import { RankOpenLoopsBySeverityToolInstance } from "./rank-open-loops.js";
import { DraftFollowupTaskResourceToolInstance } from "./draft-followup-task.js";
import { VerifyClosureClaimToolInstance } from "./verify-closure-claim.js";
import { GetPatientLoopHistoryToolInstance } from "./get-patient-loop-history.js";
import { DraftOutreachMessageToolInstance } from "./draft-outreach-message.js";
import { WriteFollowupTaskToolInstance } from "./write-followup-task.js";
import { GenerateAuditReportToolInstance } from "./generate-audit-report.js";
import { WriteAuditReportDocumentReferenceToolInstance } from "./write-audit-report-document-reference.js";

/**
 * Register all ResultLoop MCP tools with the server.
 *
 * Tools are registered in audit workflow order:
 * 1. find_recent_abnormal_results    → Scan for abnormal findings
 * 2. get_result_followup_context     → Check if follow-up exists
 * 3. generate_result_closure_summary → Create audit artifact
 * 4. rank_open_loops_by_severity     → Prioritize for clinician review
 * 5. draft_followup_task_resource    → Build draft FHIR Task + AuditEvent
 * 6. verify_closure_claim            → Audit a closure claim deterministically
 * 7. get_patient_loop_history        → Detect longitudinal closure-failure patterns
 * 8. draft_outreach_message          → Draft multilingual patient outreach messages
 * 9. write_followup_task             → Write approved Task + Provenance to FHIR (only tool that POSTs)
 * 10. generate_audit_report          → Generate visual HTML audit report with charts and severity cards
 * 11. write_audit_report_document_reference → Store the audit report as a permanent FHIR DocumentReference in the patient chart
 */
export function registerAllTools(server: McpServer, req: Request): void {
  FindRecentAbnormalResultsToolInstance.registerTool(server, req);
  GetResultFollowupContextToolInstance.registerTool(server, req);
  GenerateResultClosureSummaryToolInstance.registerTool(server, req);
  RankOpenLoopsBySeverityToolInstance.registerTool(server, req);
  DraftFollowupTaskResourceToolInstance.registerTool(server, req);
  VerifyClosureClaimToolInstance.registerTool(server, req);
  DraftOutreachMessageToolInstance.registerTool(server, req);
  GetPatientLoopHistoryToolInstance.registerTool(server, req);
  WriteFollowupTaskToolInstance.registerTool(server, req);
  GenerateAuditReportToolInstance.registerTool(server, req);
  WriteAuditReportDocumentReferenceToolInstance.registerTool(server, req);
}
