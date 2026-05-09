/**
 * In-memory report store for generated HTML audit reports.
 */

import crypto from "crypto";

interface StoredReport {
  html: string;
  createdAt: number;
}

const REPORT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const reports = new Map<string, StoredReport>();

/**
 * Store a generated HTML report and return its unique ID.
 */
export function storeReport(html: string): string {
  const reportId = crypto.randomBytes(16).toString("hex");
  reports.set(reportId, { html, createdAt: Date.now() });

  // Lazy cleanup: remove expired reports
  for (const [key, value] of reports) {
    if (Date.now() - value.createdAt > REPORT_TTL_MS) {
      reports.delete(key);
    }
  }

  return reportId;
}

/**
 * Retrieve a stored report by ID. Returns null if not found or expired.
 */
export function getReport(reportId: string): string | null {
  const entry = reports.get(reportId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > REPORT_TTL_MS) {
    reports.delete(reportId);
    return null;
  }
  return entry.html;
}
