/**
 * HTML Audit Report Template Generator
 */

import crypto from "crypto";

export interface AuditReportResult {
  reference: string;
  display: string;
  date: string;
  value: string;
  closureStatus: "OPEN_LOOP" | "CLOSED" | "INSUFFICIENT_EVIDENCE";
  riskLevel: string;
  daysSinceResult: number;
  evidenceMatrix: Array<{
    resourceType: string;
    found: boolean;
    count: number;
    references: string[];
  }>;
}

export interface AuditReportData {
  patientId: string;
  patientDisplay?: string;
  generatedAt: string;
  results: AuditReportResult[];
  longitudinalPattern?: {
    patternSeverity: string;
    closureRate: number;
    totalAbnormal: number;
    totalClosed: number;
    repeatedTypes: Array<{ type: string; count: number; openCount: number }>;
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getStatusColor(status: string, risk: string): string {
  if (status === "CLOSED") return "#16a34a";
  if (risk === "CRITICAL" || risk === "HIGH") return "#dc2626";
  if (risk === "MEDIUM") return "#d97706";
  return "#6b7280";
}

function getStatusLabel(status: string, risk: string): string {
  if (status === "CLOSED") return "CLOSED";
  if (risk === "CRITICAL" || risk === "HIGH") return "OPEN — HIGH RISK";
  if (risk === "MEDIUM") return "OPEN — MEDIUM RISK";
  return "OPEN — LOW RISK";
}

/** Deterministic confidence score based on evidence depth */
function getConfidenceScore(r: AuditReportResult): { score: number; label: string } {
  const found = r.evidenceMatrix.filter((e) => e.found).length;
  const total = r.evidenceMatrix.length;
  if (r.closureStatus === "CLOSED") {
    const score = 60 + Math.round((found / total) * 40);
    return { score, label: "Follow-up documented" };
  }
  const base = found === 0 ? 95 : 60 - found * 8;
  const score = Math.max(40, Math.min(98, base));
  return { score, label: "No follow-up found" };
}

/** Recommended actions for open results */
function getActions(r: AuditReportResult): string[] {
  if (r.closureStatus === "CLOSED") return [];
  const actions: string[] = [];
  if (r.riskLevel === "CRITICAL" || r.riskLevel === "HIGH") {
    actions.push(`Contact patient — ${escapeHtml(r.display)} requires urgent review`);
    actions.push(`Create FHIR Task: urgent follow-up for ${escapeHtml(r.display)}`);
  } else {
    actions.push(`Schedule follow-up appointment for ${escapeHtml(r.display)}`);
  }
  actions.push("Draft patient outreach message (EN/ES/HI available via ResultLoop)");
  actions.push("Document clinical rationale in patient record (FHIR Provenance)");
  return actions;
}

export function generateAuditReportHtml(data: AuditReportData): string {
  const auditHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(data))
    .digest("hex")
    .substring(0, 16);

  const openCount = data.results.filter((r) => r.closureStatus !== "CLOSED").length;
  const closedCount = data.results.filter((r) => r.closureStatus === "CLOSED").length;
  const criticalCount = data.results.filter(
    (r) => r.closureStatus !== "CLOSED" && (r.riskLevel === "CRITICAL" || r.riskLevel === "HIGH"),
  ).length;

  const resultCards = data.results
    .map((r, idx) => {
      const color = getStatusColor(r.closureStatus, r.riskLevel);
      const statusLabel = getStatusLabel(r.closureStatus, r.riskLevel);
      const conf = getConfidenceScore(r);
      const foundItems = r.evidenceMatrix.filter((e) => e.found);
      const notFoundTypes = r.evidenceMatrix.filter((e) => !e.found).map((e) => e.resourceType);
      const actions = getActions(r);
      const isClosed = r.closureStatus === "CLOSED";

      const evidenceHtml = isClosed
        ? `<div class="ev-found">
             <div class="ev-found-title">Follow-up Evidence</div>
             ${foundItems.map((e) => `
               <div class="ev-item">
                 <span class="ev-resource">${escapeHtml(e.resourceType)}</span>
                 <span class="ev-count">${e.count} record${e.count !== 1 ? "s" : ""} found</span>
                 ${e.references.length > 0 ? `<div class="ev-refs">${e.references.map((ref) => `<span class="ev-ref-code">${escapeHtml(ref)}</span>`).join("")}</div>` : ""}
               </div>`).join("")}
           </div>`
        : `<div class="ev-missing">
             <div class="ev-missing-title">Follow-up Evidence Search</div>
             <div class="ev-missing-body">
               Searched ${r.evidenceMatrix.length} FHIR resource types &mdash; no follow-up documentation found.
               <span class="ev-types">(${r.evidenceMatrix.map((e) => escapeHtml(e.resourceType)).join(", ")})</span>
             </div>
           </div>`;

      const actionsHtml = actions.length > 0
        ? `<div class="action-list">
             <div class="action-list-title">Recommended Actions</div>
             <ol>
               ${actions.map((a) => `<li>${a}</li>`).join("")}
             </ol>
           </div>`
        : "";

      return `
    <div class="result-card ${isClosed ? "card-closed" : "card-open"}" id="result-${idx + 1}">
      <div class="card-left-bar" style="background:${color}"></div>
      <div class="card-body">
        <div class="card-header-row">
          <div class="card-title-group">
            <span class="card-num">${idx + 1}</span>
            <h3 class="card-name">${escapeHtml(r.display)}</h3>
          </div>
          <span class="status-pill" style="background:${color}15;color:${color};border:1px solid ${color}40">${statusLabel}</span>
        </div>
        <div class="card-meta-row">
          <span class="meta-chip">Result date: <strong>${escapeHtml(r.date)}</strong></span>
          <span class="meta-chip">${r.daysSinceResult} days elapsed</span>
          <span class="meta-chip">Confidence: <strong>${conf.score}%</strong> &mdash; ${conf.label}</span>
        </div>
        <div class="finding-row">
          <span class="finding-label">Result value</span>
          <span class="finding-value">${escapeHtml(r.value)}</span>
        </div>
        ${evidenceHtml}
        ${actionsHtml}
        <div class="card-fhir-ref">FHIR: <code>${escapeHtml(r.reference)}</code></div>
      </div>
    </div>`;
    })
    .join("");

  const longitudinalSection = data.longitudinalPattern
    ? `<div class="section" id="longitudinal">
        <h2 class="section-title">Longitudinal Pattern</h2>
        <div class="longi-grid">
          <div class="longi-stat">
            <div class="longi-val">${(data.longitudinalPattern.closureRate <= 1 ? data.longitudinalPattern.closureRate * 100 : data.longitudinalPattern.closureRate).toFixed(0)}%</div>
            <div class="longi-label">Closure Rate</div>
          </div>
          <div class="longi-stat">
            <div class="longi-val">${data.longitudinalPattern.totalAbnormal}</div>
            <div class="longi-label">Total Abnormal</div>
          </div>
          <div class="longi-stat">
            <div class="longi-val">${data.longitudinalPattern.totalClosed}</div>
            <div class="longi-label">Followed Up</div>
          </div>
          <div class="longi-stat longi-severity">
            <div class="longi-val">${escapeHtml(data.longitudinalPattern.patternSeverity)}</div>
            <div class="longi-label">Pattern Risk</div>
          </div>
        </div>
        ${data.longitudinalPattern.repeatedTypes.length > 0 ? `
        <div class="repeat-section">
          <div class="repeat-title">Repeated Failures</div>
          ${data.longitudinalPattern.repeatedTypes.map((t) => `
            <div class="repeat-row">
              <span class="repeat-type">${escapeHtml(t.type)}</span>
              <span class="repeat-detail">${t.count} occurrences &mdash; ${t.openCount} without follow-up</span>
            </div>`).join("")}
        </div>` : ""}
      </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ResultLoop &mdash; Clinical Safety Audit</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f1f5f9;
      color: #0f172a;
      line-height: 1.6;
      min-height: 100vh;
      font-size: 14px;
    }

    .page {
      max-width: 860px;
      margin: 0 auto;
      padding: 32px 24px 64px;
    }

    /* ── Report Header ── */
    .report-header {
      background: #0f172a;
      border-radius: 12px;
      padding: 32px 36px;
      margin-bottom: 24px;
      color: white;
      position: relative;
      overflow: hidden;
    }
    .report-header::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: linear-gradient(90deg, #dc2626, #f97316, #16a34a);
    }
    .header-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }
    .header-brand {
      font-size: 11px;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: #94a3b8;
      margin-bottom: 6px;
    }
    .header-title {
      font-size: 22px;
      font-weight: 700;
      color: white;
      margin-bottom: 4px;
    }
    .header-subtitle {
      font-size: 13px;
      color: #94a3b8;
    }

    /* Donut chart */
    .header-right {
      display: flex;
      align-items: center;
      gap: 20px;
    }
    .donut-wrap {
      position: relative;
      width: 96px;
      height: 96px;
      flex-shrink: 0;
    }
    .donut-wrap canvas { display: block; }
    .donut-center-label {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      pointer-events: none;
    }
    .donut-center-pct { font-size: 18px; font-weight: 700; color: white; line-height: 1; }
    .donut-center-sub { font-size: 9px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }

    .header-stats {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .hstat {
      background: rgba(255,255,255,0.07);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      padding: 12px 18px;
      text-align: center;
      min-width: 80px;
    }
    .hstat-val {
      font-size: 26px;
      font-weight: 700;
      line-height: 1.1;
    }
    .hstat-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: #94a3b8;
      margin-top: 2px;
    }
    .hstat-open .hstat-val  { color: #f87171; }
    .hstat-closed .hstat-val { color: #4ade80; }
    .hstat-total .hstat-val  { color: #60a5fa; }
    .hstat-critical .hstat-val { color: #fb923c; }

    .header-meta {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      font-size: 11px;
      color: #64748b;
      padding-top: 16px;
      border-top: 1px solid rgba(255,255,255,0.08);
    }
    .header-meta code {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 10px;
      background: rgba(255,255,255,0.06);
      padding: 1px 5px;
      border-radius: 3px;
      color: #94a3b8;
    }

    /* ── Alert Banner ── */
    .alert-banner {
      background: #fff7ed;
      border: 1px solid #fed7aa;
      border-left: 4px solid #ea580c;
      border-radius: 8px;
      padding: 14px 18px;
      margin-bottom: 20px;
      font-size: 13px;
      color: #9a3412;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .alert-banner.alert-ok {
      background: #f0fdf4;
      border-color: #bbf7d0;
      border-left-color: #16a34a;
      color: #14532d;
    }
    .alert-icon { font-size: 16px; flex-shrink: 0; }

    /* ── Sections ── */
    .section {
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 24px 28px;
      margin-bottom: 16px;
    }
    .section-title {
      font-size: 15px;
      font-weight: 600;
      color: #0f172a;
      margin-bottom: 18px;
      padding-bottom: 12px;
      border-bottom: 1px solid #f1f5f9;
    }

    /* ── Result Cards ── */
    .result-card {
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      margin-bottom: 14px;
      display: flex;
      overflow: hidden;
      transition: box-shadow 0.2s;
    }
    .result-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
    .card-left-bar { width: 4px; flex-shrink: 0; }
    .card-body { flex: 1; padding: 20px 22px; }

    .card-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .card-title-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .card-num {
      width: 24px; height: 24px;
      background: #f1f5f9;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700;
      color: #64748b;
      flex-shrink: 0;
    }
    .card-name { font-size: 16px; font-weight: 700; color: #0f172a; }

    .status-pill {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.4px;
      padding: 4px 12px;
      border-radius: 20px;
      white-space: nowrap;
    }

    .card-meta-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .meta-chip {
      font-size: 11px;
      color: #64748b;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 4px;
      padding: 3px 9px;
    }

    .finding-row {
      display: flex;
      align-items: baseline;
      gap: 10px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 14px;
    }
    .finding-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: #94a3b8;
      flex-shrink: 0;
      font-weight: 600;
    }
    .finding-value { font-size: 14px; font-weight: 600; color: #0f172a; }

    /* Evidence */
    .ev-missing {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 14px;
      font-size: 12px;
    }
    .ev-missing-title { font-weight: 600; color: #991b1b; margin-bottom: 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
    .ev-missing-body { color: #7f1d1d; line-height: 1.5; }
    .ev-types { color: #b91c1c; font-style: italic; }

    .ev-found { margin-bottom: 14px; }
    .ev-found-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; color: #64748b; margin-bottom: 8px; }
    .ev-item {
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 6px;
    }
    .ev-resource { font-weight: 600; color: #166534; font-size: 12px; }
    .ev-count { font-size: 11px; color: #16a34a; margin-left: 8px; }
    .ev-refs { margin-top: 4px; }
    .ev-ref-code {
      display: inline-block;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 10px;
      background: #dcfce7;
      color: #15803d;
      padding: 2px 6px;
      border-radius: 3px;
      margin-right: 4px;
      word-break: break-all;
    }

    /* Action list */
    .action-list {
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 14px 16px;
      margin-bottom: 12px;
      background: #fafbff;
    }
    .action-list-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      font-weight: 600;
      color: #64748b;
      margin-bottom: 10px;
    }
    .action-list ol {
      padding-left: 18px;
    }
    .action-list li {
      font-size: 13px;
      color: #1e293b;
      margin-bottom: 6px;
      line-height: 1.5;
    }

    .card-fhir-ref {
      font-size: 10px;
      color: #cbd5e1;
      margin-top: 8px;
    }
    .card-fhir-ref code {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 9px;
    }

    /* Longitudinal */
    .longi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .longi-stat {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 14px;
      text-align: center;
    }
    .longi-val { font-size: 28px; font-weight: 700; color: #0f172a; }
    .longi-label { font-size: 11px; color: #64748b; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.5px; }
    .repeat-section { margin-top: 12px; }
    .repeat-title { font-size: 12px; font-weight: 600; color: #64748b; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.4px; }
    .repeat-row {
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 8px 12px;
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 6px;
      margin-bottom: 4px;
      font-size: 12px;
    }
    .repeat-type { font-weight: 600; color: #991b1b; }
    .repeat-detail { color: #7f1d1d; }

    /* Disclaimer */
    .disclaimer-box {
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-left: 4px solid #f59e0b;
      border-radius: 8px;
      padding: 16px 20px;
      font-size: 12px;
      color: #78350f;
      line-height: 1.6;
      margin-bottom: 16px;
    }
    .disclaimer-box strong { color: #92400e; }

    .citations-box {
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 16px 20px;
      font-size: 11px;
      color: #64748b;
      line-height: 1.7;
    }
    .citations-box strong { color: #0f172a; font-size: 12px; display: block; margin-bottom: 6px; }
    .citations-box p { margin-bottom: 4px; }

    /* Footer */
    .report-footer {
      text-align: center;
      padding: 24px 0 0;
      font-size: 11px;
      color: #94a3b8;
    }
    .report-footer .hash-badge {
      display: inline-block;
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      border-radius: 4px;
      padding: 4px 12px;
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 10px;
      margin-top: 6px;
      color: #64748b;
    }

    @media print {
      body { background: white; }
      .page { padding: 16px; }
      .report-header { background: #0f172a !important; -webkit-print-color-adjust: exact; }
      .result-card:hover { box-shadow: none; }
    }

    @media (max-width: 600px) {
      .page { padding: 16px 12px; }
      .report-header { padding: 20px; }
      .header-top { flex-direction: column; }
      .header-stats { gap: 8px; }
    }
  </style>
</head>
<body>
<div class="page">

  <!-- Report Header -->
  <div class="report-header">
    <div class="header-top">
      <div>
        <div class="header-brand">ResultLoop &mdash; Clinical Safety Audit</div>
        <div class="header-title">Abnormal Result Follow-Up Audit</div>
        <div class="header-subtitle">${data.patientDisplay ? `Patient: ${escapeHtml(data.patientDisplay)}` : "Patient Audit Report"}</div>
      </div>
      <div class="header-right">
        <div class="donut-wrap">
          <canvas id="statusDonut" width="96" height="96"></canvas>
          <div class="donut-center-label">
            <div class="donut-center-pct">${closedCount > 0 ? Math.round((closedCount / data.results.length) * 100) : 0}%</div>
            <div class="donut-center-sub">closed</div>
          </div>
        </div>
        <div class="header-stats">
        <div class="hstat hstat-total">
          <div class="hstat-val">${data.results.length}</div>
          <div class="hstat-label">Audited</div>
        </div>
        <div class="hstat hstat-open">
          <div class="hstat-val">${openCount}</div>
          <div class="hstat-label">Open Loops</div>
        </div>
        <div class="hstat hstat-critical">
          <div class="hstat-val">${criticalCount}</div>
          <div class="hstat-label">High Risk</div>
        </div>
        <div class="hstat hstat-closed">
          <div class="hstat-val">${closedCount}</div>
          <div class="hstat-label">Closed</div>
        </div>
        </div>
      </div>
    </div>
    <div class="header-meta">
      <span>Generated: <strong style="color:#cbd5e1">${escapeHtml(data.generatedAt)}</strong></span>
      <span>Patient ID: <code>${escapeHtml(data.patientId)}</code></span>
      <span>Audit hash: <code>sha256:${auditHash}</code></span>
      <span>Tool: ResultLoop MCP v0.1.0</span>
    </div>
  </div>

  <!-- Alert Banner -->
  ${openCount > 0
    ? `<div class="alert-banner">
         <span class="alert-icon">&#9888;</span>
         <span><strong>${openCount} open loop${openCount > 1 ? "s" : ""} detected</strong>${criticalCount > 0 ? ` &mdash; ${criticalCount} flagged HIGH RISK` : ""}. Review and action required before dismissing this report.</span>
       </div>`
    : `<div class="alert-banner alert-ok">
         <span class="alert-icon">&#10003;</span>
         <span><strong>All results closed.</strong> No outstanding follow-up required at this time.</span>
       </div>`}

  <!-- Audit Results -->
  <div class="section">
    <h2 class="section-title">Audit Results (${data.results.length})</h2>
    ${resultCards}
  </div>

  ${longitudinalSection}

  <!-- Disclaimer -->
  <div class="disclaimer-box">
    <strong>&#9888; Automated Audit &mdash; Not a Clinical Diagnosis</strong><br>
    This report is generated by ResultLoop for clinician review. It does NOT constitute a medical diagnosis, treatment recommendation, or clinical order. All findings require human verification before any clinical action is taken. ResultLoop identifies and audits &mdash; it never diagnoses, never treats, never overrides clinical judgment.
  </div>

  <!-- Citations -->
  <div class="citations-box">
    <strong>Clinical References</strong>
    <p>&bull; AHRQ Patient Safety Network: &ldquo;7.1% of abnormal test results lack documented follow-up&rdquo; (Singh et al., Annals of Internal Medicine, 2014).</p>
    <p>&bull; BMJ Quality &amp; Safety 2025: &ldquo;33&ndash;46% of fatal diagnostic errors involve follow-up failure.&rdquo;</p>
    <p>&bull; AHRQ Diagnostic Safety Issue Brief #19: Patients with repeatedly unfollowed abnormal results have significantly higher odds of delayed diagnosis.</p>
  </div>

  <!-- Footer -->
  <div class="report-footer">
    <div>ResultLoop &mdash; Abnormal Result Follow-Up Closure Audit MCP Server</div>
    <div>Generated for clinician review only. Synthetic patient data &mdash; not for clinical use.</div>
    <div class="hash-badge">Audit Hash: sha256:${auditHash}</div>
  </div>

</div>

<script>
(function() {
  var ctx = document.getElementById('statusDonut');
  if (!ctx) return;
  new Chart(ctx, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [${openCount}, ${closedCount}],
        backgroundColor: ['#dc2626', '#16a34a'],
        borderWidth: 0,
        hoverOffset: 0
      }]
    },
    options: {
      cutout: '72%',
      animation: { duration: 600 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    }
  });
})();
</script>
</body>
</html>`;
}
