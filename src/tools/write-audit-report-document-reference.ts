import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { z } from "zod";
import { fhirClient } from "../fhir/fhir-client.js";
import { FhirUtilities } from "../fhir/fhir-utilities.js";
import { IMcpTool } from "./IMcpTool.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { logger } from "../util/logger.js";
import { getReport } from "./report-store.js";
import { sha256CanonicalJson } from "../clinical/draft-followup-task.js";

/**
 * write_audit_report_document_reference
 *
 * Stores the ResultLoop HTML audit report as a permanent FHIR R4 DocumentReference
 * in the patient's chart. This makes the audit report EHR-native — any downstream
 * system can retrieve it via DocumentReference?patient=X&type=audit.
 *
 * What is written:
 *   - DocumentReference (status=current, docStatus=final) with:
 *       - type: LOINC 11503-0 (Medical records)
 *       - category: clinical-note
 *       - subject: Patient reference
 *       - content: base64-encoded HTML attachment (text/html)
 *       - context: related result references
 *       - description: human-readable audit summary
 *   - Provenance linked to the DocumentReference citing ResultLoop as author
 *
 * Safety:
 *   - Read-only of stored report — no new FHIR reads are triggered
 *   - reportId must match an existing in-memory report from generate_audit_report
 *   - Does not diagnose, treat, or contact patients
 */
class WriteAuditReportDocumentReferenceTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "write_audit_report_document_reference",
      {
        description:
          "Stores the ResultLoop visual audit report as a permanent FHIR R4 DocumentReference " +
          "in the patient's chart. Call this after generate_audit_report to make the audit " +
          "report EHR-native and retrievable by any downstream system. " +
          "Requires the reportId returned by generate_audit_report. " +
          "Does NOT diagnose, treat, or order clinical actions.",
        inputSchema: {
          reportId: z
            .string()
            .describe(
              "The reportId returned by generate_audit_report. Used to retrieve the HTML content.",
            ),
          viewUrl: z
            .string()
            .describe(
              "The viewUrl returned by generate_audit_report. Stored as a URL attachment in the DocumentReference.",
            ),
          patientId: z
            .string()
            .describe(
              "The patient ID. Prompt Opinion patient context is authoritative when available.",
            )
            .optional(),
          auditSummary: z
            .string()
            .describe(
              "Short plain-language summary of the audit, e.g. '2 open-loop abnormal results identified: BI-RADS 4 mammogram and CA-125 (89.5 U/mL)'.",
            ),
          openLoopCount: z
            .number()
            .describe("Number of open-loop results in the audit.")
            .default(0),
          closedCount: z
            .number()
            .describe("Number of closed results in the audit.")
            .default(0),
          resultReferences: z
            .array(z.string())
            .describe(
              "FHIR references to the audited abnormal results, e.g. ['DiagnosticReport/abc', 'Observation/xyz']. Used for chart context linkage.",
            )
            .default([]),
        },
      },
      async ({
        reportId,
        viewUrl,
        patientId,
        auditSummary,
        openLoopCount,
        closedCount,
        resultReferences,
      }) => {
        try {
          patientId = FhirUtilities.getPatientIdOrThrow(req, patientId);

          const html = getReport(reportId);
          if (!html) {
            return McpUtilities.createJsonResponse(
              {
                status: "not_written",
                errorCode: "REPORT_NOT_FOUND",
                message:
                  `Report ID '${reportId}' was not found or has expired. ` +
                  "Call generate_audit_report first, then call this tool in the same session.",
                fhirWritesPerformed: false,
              },
              { isError: true },
            );
          }

          const now = new Date().toISOString();
          const htmlBase64 = Buffer.from(html, "utf-8").toString("base64");

          const artifactHash = sha256CanonicalJson({
            reportId,
            patientId,
            auditSummary,
            openLoopCount,
            resultReferences,
          });

          const relatedReferences = resultReferences.map((ref) => ({
            reference: ref,
          }));

          const documentReference: Record<string, unknown> = {
            resourceType: "DocumentReference",
            status: "current",
            docStatus: "final",
            type: {
              coding: [
                {
                  system: "http://loinc.org",
                  code: "11503-0",
                  display: "Medical records",
                },
              ],
              text: "ResultLoop Abnormal Result Closure Audit",
            },
            category: [
              {
                coding: [
                  {
                    system:
                      "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category",
                    code: "clinical-note",
                    display: "Clinical Note",
                  },
                ],
              },
            ],
            subject: {
              reference: `Patient/${patientId}`,
            },
            date: now,
            description: auditSummary,
            content: [
              {
                attachment: {
                  contentType: "text/html",
                  data: htmlBase64,
                  title: "ResultLoop Closure Audit Report",
                  creation: now,
                },
              },
            ],
            context: {
              related:
                relatedReferences.length > 0 ? relatedReferences : undefined,
            },
            extension: [
              {
                url: "urn:resultloop:audit-metadata",
                extension: [
                  {
                    url: "openLoopCount",
                    valueInteger: openLoopCount,
                  },
                  {
                    url: "closedCount",
                    valueInteger: closedCount,
                  },
                  {
                    url: "artifactHash",
                    valueString: `urn:sha-256:${artifactHash}`,
                  },
                  {
                    url: "generatedBy",
                    valueString:
                      "ResultLoop MCP — Abnormal Result Follow-up Audit",
                  },
                ],
              },
            ],
          };

          const createdDocRef = await fhirClient.create<
            Record<string, unknown>
          >(req, documentReference);
          const docRefId = createdDocRef["id"] as string | undefined;
          const docRefReference = docRefId
            ? `DocumentReference/${docRefId}`
            : "DocumentReference/(id not returned)";

          const provenance: Record<string, unknown> = {
            resourceType: "Provenance",
            target: [{ reference: docRefReference }],
            recorded: now,
            agent: [
              {
                type: {
                  coding: [
                    {
                      system:
                        "http://terminology.hl7.org/CodeSystem/provenance-participant-type",
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
            entity: resultReferences.map((ref) => ({
              role: "source",
              what: { reference: ref },
            })),
          };

          const createdProvenance = await fhirClient.create<
            Record<string, unknown>
          >(req, provenance);
          const provenanceId = createdProvenance["id"] as string | undefined;
          const provenanceRef = provenanceId
            ? `Provenance/${provenanceId}`
            : "Provenance/(id not returned)";

          logger.info(
            { patientId, docRefReference, provenanceRef, reportId },
            "Audit report written to FHIR as DocumentReference",
          );

          return McpUtilities.createJsonResponse({
            status: "written",
            message:
              "The ResultLoop audit report has been stored in the patient's FHIR record as a permanent DocumentReference. " +
              "It can be retrieved by any downstream system via DocumentReference?patient=" +
              patientId +
              "&type=http://loinc.org|11503-0",
            documentReferenceId: docRefReference,
            provenanceReference: provenanceRef,
            viewUrl,
            patientId,
            auditSummary,
            openLoopCount,
            closedCount,
            artifactHash: `urn:sha-256:${artifactHash}`,
            safetyNote:
              "This DocumentReference is a permanent audit record for clinician review. " +
              "It does NOT constitute a diagnosis, treatment recommendation, or clinical order. " +
              "All findings require human verification before any clinical action is taken.",
            fhirWritesPerformed: true,
            resourcesCreated: ["DocumentReference", "Provenance"],
          });
        } catch (error) {
          logger.error(
            { error },
            "Failed to write audit report DocumentReference to FHIR",
          );
          return McpUtilities.createTextResponse(
            `Error writing audit report to FHIR: ${error instanceof Error ? error.message : "Unknown error"}`,
            { isError: true },
          );
        }
      },
    );
  }
}

export const WriteAuditReportDocumentReferenceToolInstance =
  new WriteAuditReportDocumentReferenceTool();
