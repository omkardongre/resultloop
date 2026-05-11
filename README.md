# ResultLoop

**Abnormal Result Follow-Up Closure Audit — SHARP-on-MCP Clinical Safety Server**

ResultLoop audits patient FHIR records for abnormal lab and imaging results lacking documented follow-up — the clinical safety gaps where patients fall through the cracks and cancers progress unchecked.

## The Problem

Follow-up failure is a documented and preventable contributor to diagnostic error:

| Statistic                                                                             | Source                                       |
| ------------------------------------------------------------------------------------- | -------------------------------------------- |
| **35.5% of pulmonary nodule patients** receive no follow-up imaging                   | AHRQ / Brigham & Women's Hospital, 2025      |
| **26% of BI-RADS 3 breast findings** — no documented follow-up (386/1,511 patients)   | AHRQ Lacson Report, 2025                     |
| **1 in 7 radiology recommendations** never achieve documented closure                 | JAMA Network Open, 2022                      |
| **44% of diagnostic errors** involve failure to follow up on a lab or imaging result  | Schiff et al. (cited BMJ Open Quality, 2023) |
| Follow-up and coordination failure = cause in **46% of severe/fatal** adverse events  | PMC / Danish National DB, March 2025         |
| Diagnostic errors cost the US **$870 billion/year** — 17.5% of total healthcare spend | OECD Working Paper, March 2025               |

The problem isn't that clinicians don't care. It's that **no system is watching the loop.** A BI-RADS 4 mammogram gets filed. The radiologist moves on. The referring clinician never gets a callback. The patient never hears back. Sixty-three days later, a suspicious breast finding remains unresolved.

ResultLoop was built to close that loop.

## Solution

ResultLoop scans structured FHIR R4 data to detect **open-loop abnormal results** — findings flagged as abnormal with no corresponding follow-up order, task, communication, or care plan. It generates a structured closure audit artifact, ranks results by clinical severity, and drafts follow-up tasks and patient outreach for clinician review.

Action-oriented writes require explicit clinician approval. Audit report persistence requires a valid generated reportId and writes a DocumentReference + Provenance record.

## Architecture

```
Prompt Opinion Workspace
        ↓
  ResultLoop Auditor (BYO Patient-Safety Agent)
        ↓
  ResultLoop MCP Server  ←  SHARP FHIR context headers
        ↓
  FHIR R4 API (workspace)
        ↓
  Closure Risk Index (deterministic)
        ↓
  Closure Audit Artifact + HTML Report
        ↓
  Clinician Review → FHIR Task + Provenance write
```

## 14 MCP Tools — 4 Workflow Stages

### DISCOVER

| Tool                           | What it does                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `find_recent_abnormal_results` | Scans Observations and DiagnosticReports for abnormal/critical/panic flags                                           |
| `get_result_followup_context`  | Searches ServiceRequest, Task, Communication, CarePlan, Encounter after result date; returns `OPEN_LOOP` or `CLOSED` |
| `get_patient_loop_history`     | Detects longitudinal closure-failure patterns across 24 months                                                       |

### ANALYZE

| Tool                              | What it does                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rank_open_loops_by_severity`     | Deterministic Closure Risk Index (CRI) using BI-RADS, Lung-RADS, HbA1c, eGFR, TSH, potassium, FIT, hemoglobin thresholds + days-since-result timeliness step |
| `generate_result_closure_summary` | Structured clinical safety artifact with evidence matrix and risk assessment                                                                                 |
| `verify_closure_claim`            | Hallucination guardrail — returns `PASS` / `CONTRADICTION` / `INSUFFICIENT_EVIDENCE`                                                                         |

### EVIDENCE

| Tool                     | What it does                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_clinical_guideline` | Searches PubMed E-utilities (esearch → esummary) for cited clinical guidelines by finding type. Returns real PMIDs, journal metadata, and direct PubMed URLs. No patient data sent to NCBI. |

### ACT

| Tool                                    | What it does                                                                                                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft_followup_task_resource`          | Draft-only FHIR R4 Task + AuditEvent with SHA-256 hash; never writes                                                                                                                                                              |
| `write_followup_task`                   | Writes FHIR Task + Provenance to chart; **gated by explicit `clinicianApprovalConfirmed: true` in the same conversation turn**                                                                                                    |
| `draft_outreach_message`                | Multilingual patient outreach draft (English / Spanish / Hindi) with 21st Century Cures Act framing                                                                                                                               |
| `generate_audit_report`                 | Self-contained HTML clinical safety audit report — donut chart, severity cards, evidence matrix                                                                                                                                   |
| `write_audit_report_document_reference` | Stores the HTML audit report as a permanent FHIR `DocumentReference` in the patient chart (base64 + LOINC coded, linked Provenance)                                                                                               |
| `write_detected_issue`                  | Writes a FHIR `DetectedIssue` (CAREGAP / care gap) for open-loop abnormal results; severity mapped from CRI score; gated by explicit clinician approval                                                                           |
| `send_sms_outreach`                     | Sends clinician-approved English patient outreach via Twilio SMS; multilingual drafts are generated separately; **gated by explicit `clinicianApprovalConfirmed: true` in the same conversation turn** — never sends autonomously |

## Closure Risk Index (CRI) — Deterministic Severity Scoring

CRI is a **pure deterministic formula** — no LLM touches the score. Every number traces to a published clinical guideline or AHRQ finding:

```
totalPriorityScore = severityScore + timelinessScore

severityScore (clinical threshold classification — no LLM):
  CRITICAL → 90  (e.g. panic-value lab, BI-RADS 5, Lung-RADS 4B)
  HIGH     → 60  (e.g. BI-RADS 4, Lung-RADS 4A, critical PSA, CA-125 elevated)
  MODERATE → 30
  LOW      → 10

timelinessScore (days since result):
  ≥ 45 days → 30
  ≥ 30 days → 20
  ≥ 14 days → 10
  < 14 days →  0

recommendedQueue:
  CRITICAL or score ≥ 100 → immediate_review
  HIGH     or score ≥ 70  → urgent_review
  MODERATE or score ≥ 40  → routine_review
  else                    → monitor
```

This is similar in spirit to deterministic clinical scoring systems like the Naranjo causality algorithm — deterministic, auditable, citable. Thresholds are grounded in BI-RADS, Lung-RADS, and AHRQ published findings.

## Validation Matrix

100% detection across 17 labeled test scenarios, zero false closures:

| Test | Patient        | Scenario                                                                     | Result                                                             |
| ---- | -------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1    | Maria Lopez    | BI-RADS 4 mammogram + CA-125, both OPEN_LOOP, no follow-up                   | ✅ 2 open loops detected                                           |
| 2    | James Chen     | Critical PSA 12.8, no follow-up                                              | ✅ open loop detected                                              |
| 3    | Sarah Williams | TSH 15.2 High — ServiceRequest + Task + Communication found                  | ✅ correctly CLOSED — no false flag                                |
| 4    | Robert Johnson | CT Chest Lung-RADS 4A — no follow-up                                         | ✅ open loop detected                                              |
| 5    | Priya Patel    | WBC Critical High (OPEN_LOOP) + Hemoglobin Low (CLOSED) — per-result linkage | ✅ correct per-result isolation; Hemoglobin closed, WBC open       |
| 6    | Maria Lopez    | rank_open_loops_by_severity — correct CRI order                              | ✅ BI-RADS 4 mammogram ranked above CA-125                         |
| 7    | Maria Lopez    | Draft FHIR Task + AuditEvent (draft-only, no write)                          | ✅ draft returned, fhirWritesPerformed: false                      |
| 8    | Maria Lopez    | verify_closure_claim — OPEN_LOOP PASS + CLOSED PASS                          | ✅ both verdicts correct                                           |
| 9    | Maria Lopez    | Longitudinal repeat-miss pattern (24 months)                                 | ✅ HIGH pattern, 2 mammogram gaps detected                         |
| 10   | Maria Lopez    | Multilingual outreach EN (mammogram) + ES (mammogram) + HI (CA-125)          | ✅ all 3 languages correct                                         |
| 11   | Maria Lopez    | write_followup_task — approval gate + FHIR Task + Provenance write           | ✅ Task written; blocked without approval; CLOSED blocks re-draft  |
| 12   | Maria Lopez    | generate_audit_report HTML + view_url returned                               | ✅ HTML served with view_url link                                  |
| 13   | Maria Lopez    | evidenceProvenance block in closure summary — all 4 patient variants         | ✅ correct FHIR refs cited; per-result isolation confirmed         |
| 14   | Maria Lopez    | write_audit_report_document_reference — DocumentReference + Provenance       | ✅ written; fake reportId blocked                                  |
| 15   | Robert Johnson | write_detected_issue — FHIR DetectedIssue CAREGAP + approval gate            | ✅ DetectedIssue written; blocked without approval; CLOSED blocked |
| 16   | Robert Johnson | get_clinical_guideline — Lung-RADS 4A PubMed citations                       | ✅ real PMIDs returned; graceful no-results handling               |
| 17   | James Chen     | send_sms_outreach — Twilio SMS delivery + approval gate                      | ✅ SMS delivered (SMce30...); blocked without same-turn approval   |

**50 assertions across 17 scenarios — 50/50 pass. Zero false closures.**

## FHIR Resources

**Reads:** `Patient`, `Observation`, `DiagnosticReport`, `ServiceRequest`, `Task`, `Communication`, `CarePlan`, `Encounter`, `FamilyMemberHistory`

**Writes:** `Task` (status=requested), `Provenance`, `DocumentReference` (LOINC `11503-0`, base64 HTML audit report), `DetectedIssue` (CAREGAP, severity=high/moderate/low, implicated result reference)

## Safety Boundaries

ResultLoop is a **read-audit-draft** tool, not a clinical decision system.

- ✅ Audits structured FHIR data for closure evidence
- ✅ Ranks open loops by deterministic CRI score
- ✅ Generates draft tasks for clinician review
- ✅ Writes Task + Provenance only with explicit `clinicianApprovalConfirmed: true`
- ✅ Stores audit report as permanent EHR `DocumentReference` on clinician request
- ✅ Records open-loop safety concern as FHIR `DetectedIssue` (CAREGAP) surfaceable by downstream CDS
- ✅ Tri-state verification catches AI hallucinations (PASS / CONTRADICTION / INSUFFICIENT_EVIDENCE)
- ✅ Drafts multilingual patient outreach and sends English SMS via Twilio — gated by explicit same-turn clinician approval
- ❌ Does NOT diagnose conditions
- ❌ Does NOT recommend treatments
- ❌ Does NOT autonomously contact patients
- ❌ Does NOT write anything silently

## Setup

```bash
npm install
cp .env.example .env
npm run dev      # development
npm test         # run unit tests (detection logic, fixture validation)
npm run build    # production build
```

**Live endpoint:** `https://resultloop-mcp.onrender.com/mcp`

## Prompt Opinion Agent Setup

For the exact BYO agent configuration used in testing, see [`docs/agent-config.md`](docs/agent-config.md).

## License

Apache-2.0
