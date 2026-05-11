/**
 * ResultLoop — get_clinical_guideline tool
 *
 * Searches PubMed E-utilities for clinical guidelines and published evidence
 * relevant to a specific finding type or clinical condition.
 *
 * External API: NCBI PubMed E-utilities (free, no API key required < 3 req/s)
 * Rate limits:  3 requests/sec without key, 10/sec with NCBI API key
 * Docs:         https://www.ncbi.nlm.nih.gov/books/NBK25501/
 * Last verified: 2026-05-11 (API reviewed Feb 2026 per NLM Data Guide)
 *
 * Two-step pipeline:
 *  1. esearch.fcgi → retrieve ranked PMIDs for query
 *  2. esummary.fcgi → retrieve JSON document summaries for those PMIDs
 *
 * No FHIR reads or writes. No patient data sent to NCBI.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { z } from "zod";
import { IMcpTool } from "../tools/IMcpTool.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { logger } from "../util/logger.js";

// ─── NCBI configuration ───────────────────────────────────────────────────────
const NCBI_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
/** Tool identifier sent to NCBI per usage guidelines */
const NCBI_TOOL = "ResultLoop-MCP";
/** Contact email sent to NCBI per usage guidelines */
const NCBI_EMAIL = "resultloop@healthcareai.dev";
/** Timeout for each NCBI request (ms) */
const NCBI_TIMEOUT_MS = 10_000;

// ─── NCBI response types ──────────────────────────────────────────────────────
interface NcbiESearchResponse {
  esearchresult: {
    count: string;
    retmax: string;
    idlist: string[];
  };
}

interface NcbiAuthor {
  name: string;
}

interface NcbiDocSummary {
  uid: string;
  title: string;
  source: string;  // journal name
  pubdate: string; // e.g. "2026 Apr"
  authors: NcbiAuthor[];
  fulljournalname: string;
}

interface NcbiESummaryResponse {
  result: Record<string, NcbiDocSummary | string[]>;
}

// ─── PubMed search implementation ────────────────────────────────────────────

/**
 * Step 1: Search PubMed and retrieve PMIDs sorted by relevance.
 */
async function esearch(query: string, maxResults: number): Promise<string[]> {
  const url = new URL(`${NCBI_BASE}/esearch.fcgi`);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("term", query);
  url.searchParams.set("retmax", String(maxResults));
  url.searchParams.set("retmode", "json");
  url.searchParams.set("sort", "relevance");
  url.searchParams.set("tool", NCBI_TOOL);
  url.searchParams.set("email", NCBI_EMAIL);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": `${NCBI_TOOL}/1.0` },
    signal: AbortSignal.timeout(NCBI_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `PubMed esearch HTTP ${response.status}: ${response.statusText}`
    );
  }

  const data = (await response.json()) as NcbiESearchResponse;
  return data.esearchresult?.idlist ?? [];
}

/**
 * Step 2: Retrieve JSON document summaries for a list of PMIDs.
 * esummary returns richer structured data than efetch text mode
 * and does not require XML parsing.
 */
async function esummary(pmids: string[]): Promise<NcbiDocSummary[]> {
  const url = new URL(`${NCBI_BASE}/esummary.fcgi`);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("id", pmids.join(","));
  url.searchParams.set("retmode", "json");
  url.searchParams.set("tool", NCBI_TOOL);
  url.searchParams.set("email", NCBI_EMAIL);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": `${NCBI_TOOL}/1.0` },
    signal: AbortSignal.timeout(NCBI_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `PubMed esummary HTTP ${response.status}: ${response.statusText}`
    );
  }

  const data = (await response.json()) as NcbiESummaryResponse;
  const result = data.result ?? {};

  // "uids" is a special array key in the result, skip it
  return pmids
    .filter(
      (id) =>
        result[id] !== undefined &&
        !Array.isArray(result[id]) &&
        typeof result[id] === "object"
    )
    .map((id) => result[id] as NcbiDocSummary);
}

// ─── Tool class ───────────────────────────────────────────────────────────────

class GetClinicalGuidelineTool implements IMcpTool {
  registerTool(server: McpServer, _req: Request): void {
    server.registerTool(
      "get_clinical_guideline",
      {
        description:
          "Searches PubMed (NCBI) for clinical guidelines and published evidence relevant to a " +
          "specific finding type or clinical condition. Returns PMID-cited article titles, journal " +
          "names, publication years, first authors, and direct PubMed links. " +
          "Use when the clinician asks for guideline-based follow-up timing, evidence behind a " +
          "severity ranking, or a citation for a specific clinical finding such as BI-RADS 4, " +
          "Lung-RADS 4A, elevated CA-125, or critical PSA. " +
          "Does NOT access patient FHIR records. No patient data is sent to NCBI. " +
          "No FHIR writes performed. Citation is for clinician reference only.",
        inputSchema: {
          query: z
            .string()
            .min(3)
            .max(200)
            .describe(
              "The clinical finding or condition to search for. " +
                "Examples: 'birads 4 mammogram follow-up guidelines', " +
                "'lung-rads 4a ct pulmonary nodule fleischner society', " +
                "'elevated ca-125 ovarian cancer follow-up timing', " +
                "'critical psa prostate biopsy recommendation'. " +
                "Construct the query from the finding type returned by prior audit tools."
            ),
          maxResults: z
            .number()
            .int()
            .min(1)
            .max(5)
            .optional()
            .describe(
              "Maximum number of PubMed results to return. Defaults to 3. Increase to 5 " +
                "only when the clinician asks for a comprehensive evidence review."
            ),
        },
      },
      async ({ query, maxResults = 3 }) => {
        try {
          logger.info({ query, maxResults }, "get_clinical_guideline: searching PubMed");

          // Step 1 — retrieve PMIDs
          const pmids = await esearch(query, maxResults);

          if (pmids.length === 0) {
            logger.info({ query }, "get_clinical_guideline: no PubMed results");
            return McpUtilities.createJsonResponse({
              status: "no_results",
              query,
              resultsFound: 0,
              guidelines: [],
              searchSource: "PubMed E-utilities (NCBI National Library of Medicine)",
              safetyNote:
                "No matching guidelines found for this query. Clinical decisions must be " +
                "based on institutional protocols and clinician judgment.",
              readOnlyInvariant: { fhirWritesPerformed: false },
            });
          }

          // Step 2 — retrieve document summaries
          const articles = await esummary(pmids);

          const guidelines = articles.map((article) => {
            const year = article.pubdate?.split(" ")[0] ?? "";
            const firstAuthor = article.authors?.[0]?.name ?? "Unknown";
            const journal =
              article.fulljournalname?.trim() ||
              article.source?.trim() ||
              "Unknown journal";

            return {
              pmid: article.uid,
              title: article.title,
              journal,
              year,
              firstAuthor,
              pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${article.uid}/`,
              citation: `${firstAuthor} et al. ${journal} (${year}). PMID: ${article.uid}.`,
            };
          });

          logger.info(
            {
              query,
              resultsFound: guidelines.length,
              pmids: guidelines.map((g) => g.pmid),
            },
            "get_clinical_guideline: PubMed search complete"
          );

          return McpUtilities.createJsonResponse({
            status: "results_found",
            query,
            resultsFound: guidelines.length,
            guidelines,
            searchSource: "PubMed E-utilities (NCBI National Library of Medicine)",
            safetyNote:
              "These citations are for clinician reference only. Clinical decisions must be " +
              "verified by a qualified healthcare provider against current institutional guidelines " +
              "and the patient's full clinical context. ResultLoop does not interpret or apply " +
              "guideline recommendations — that judgment belongs to the clinician.",
            readOnlyInvariant: { fhirWritesPerformed: false },
          });
        } catch (error) {
          logger.error({ error, query }, "get_clinical_guideline: PubMed request failed");

          // Return a graceful degradation — do not break the agent session
          return McpUtilities.createTextResponse(
            `PubMed guideline search failed: ${
              error instanceof Error ? error.message : "Unknown error"
            }. Please consult institutional clinical guidelines directly. ` +
              "ResultLoop audit results remain valid independently of this citation lookup.",
            { isError: true }
          );
        }
      }
    );
  }
}

export const GetClinicalGuidelineToolInstance = new GetClinicalGuidelineTool();
