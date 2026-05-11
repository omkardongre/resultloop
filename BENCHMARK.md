# ResultLoop — Accuracy Benchmark

## Methodology

ResultLoop's pipeline is deterministic: no LLM touches the open-loop detection logic or the Closure Risk Index score. Every detection decision traces to a rule grounded in a published clinical guideline or AHRQ finding. The benchmark therefore measures **precision and recall** — does the system correctly identify open loops and correctly leave closed results alone — rather than probabilistic accuracy.

### Eval corpus

| Dimension          | Value                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| Synthetic patients | 5 (Maria Lopez, James Chen, Sarah Williams, Robert Johnson, Priya Patel) |
| Clinical domains   | Oncology, pulmonology, nephrology, endocrinology, cardiology             |
| Labeled scenarios  | 17                                                                       |
| Total assertions   | 50                                                                       |
| Test runs          | Manual end-to-end on live Prompt Opinion + FHIR server                   |

Scenarios span open-loop detection, false-close resistance, severity ranking, longitudinal pattern detection, hallucination guardrail, FHIR write-back gates, multilingual outreach, and safety boundary enforcement.

---

## Detection Benchmark

| Metric                                                       | Corpus                    | Result           |
| ------------------------------------------------------------ | ------------------------- | ---------------- |
| **True Positive Rate** — open loop correctly flagged         | 11 open-loop scenarios    | **11/11 = 100%** |
| **True Negative Rate** — closed result not falsely flagged   | 4 closed-result scenarios | **4/4 = 100%**   |
| **False Closure Rate** — open loop incorrectly marked closed | 11 open-loop scenarios    | **0/11 = 0%**    |
| **False Alarm Rate** — closed result incorrectly flagged     | 4 closed-result scenarios | **0/4 = 0%**     |

---

## Hallucination Guardrail Benchmark (`verify_closure_claim`)

`verify_closure_claim` is a tri-state self-check that audits closure claims against raw FHIR evidence. It exists specifically because a hallucinated closure is more dangerous than no answer at all.

| Verdict                 | Scenario                                         | Result         |
| ----------------------- | ------------------------------------------------ | -------------- |
| `CONTRADICTION`         | Agent-supplied evidence contradicts FHIR record  | **1/1 = 100%** |
| `INSUFFICIENT_EVIDENCE` | Evidence present but below threshold for closure | **1/1 = 100%** |
| `PASS`                  | Evidence matches and is current                  | **1/1 = 100%** |

---

## Severity Ranking Benchmark (Closure Risk Index)

CRI is a pure deterministic formula — no LLM, no randomness:

```
totalPriorityScore = severityScore + timelinessScore

severityScore (from clinical threshold classification):
  CRITICAL → 90  (e.g. panic-value lab, BI-RADS 5)
  HIGH     → 60  (e.g. BI-RADS 4, Lung-RADS 4A, critical PSA)
  MODERATE → 30
  LOW      → 10

timelinessScore (days since result):
  ≥ 45 days → 30
  ≥ 30 days → 20
  ≥ 14 days → 10
  < 14 days → 0

recommendedQueue:
  CRITICAL or score ≥ 100 → immediate_review
  HIGH     or score ≥ 70  → urgent_review
  MODERATE or score ≥ 40  → routine_review
  else                    → monitor
```

| Scenario                                              | Expected rank order        | Result     |
| ----------------------------------------------------- | -------------------------- | ---------- |
| BI-RADS 4 mammogram vs CA-125 elevated (same patient) | BI-RADS 4 ranked higher    | ✅ correct |
| Lung-RADS 4A vs normal TSH (different patients)       | Lung-RADS 4A ranked higher | ✅ correct |

---

## FHIR Write Safety Gate Benchmark

Action-oriented write tools are gated by `clinicianApprovalConfirmed: true` enforced at the **parameter level**, not just the system prompt. Audit report persistence is gated by a valid generated reportId. Tested with adversarial prompts designed to trigger unsafe writes.

| Tool                                    | Gate condition                                  | Blocked without approval    | Writes with approval |
| --------------------------------------- | ----------------------------------------------- | --------------------------- | -------------------- |
| `write_followup_task`                   | `clinicianApprovalConfirmed: true` in same turn | ✅ 3/3                      | ✅ 2/2               |
| `write_detected_issue`                  | `clinicianApprovalConfirmed: true` in same turn | ✅ 1/1                      | ✅ 1/1               |
| `write_detected_issue`                  | Result must be `OPEN_LOOP` (not CLOSED)         | ✅ blocked on CLOSED result | —                    |
| `write_audit_report_document_reference` | Requires valid generated reportId               | ✅ fake reportId blocked    | ✅ 1/1               |

---

## Longitudinal Pattern Detection Benchmark

`get_patient_loop_history` detects repeat closure-failure patterns across a 24-month window.

| Scenario                                              | Expected                               | Result     |
| ----------------------------------------------------- | -------------------------------------- | ---------- |
| Maria Lopez — 2nd mammogram gap within 24 months      | Pattern flagged, `repeatMissCount ≥ 2` | ✅ correct |
| Robert Johnson — single HbA1c event, follow-up exists | No pattern, `closureRate > 0`          | ✅ correct |

---

## Multilingual Outreach Benchmark

`draft_outreach_message` generates patient outreach in English, Spanish, and Hindi with 21st Century Cures Act framing.

| Language | Scenario                          | Result     |
| -------- | --------------------------------- | ---------- |
| English  | Maria Lopez — BI-RADS 4 mammogram | ✅ correct |
| Spanish  | Maria Lopez — BI-RADS 4 mammogram | ✅ correct |
| Hindi    | Maria Lopez — abnormal CA-125     | ✅ correct |

---

---

## PubMed Evidence Retrieval Benchmark (`get_clinical_guideline`)

`get_clinical_guideline` calls the NCBI E-utilities two-step pipeline (esearch → esummary) and returns real PMID-cited publications. No patient data is sent to NCBI.

| Scenario                                                      | Expected                              | Result                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Lung-RADS 4A query — Robert Johnson CT chest (120-day window) | Real PMIDs, on-topic journal articles | ✅ PMID 36326760 (_JAMA Network Open_) and PMID 34419477 (_J Am Coll Radiol_) — both verified on PubMed |
| Non-existent condition query                                  | `status: "no_results"`, graceful      | ✅ correct                                                                                              |

---

## Summary

| Benchmark                                       | Score          |
| ----------------------------------------------- | -------------- |
| Open-loop detection (TPR)                       | **100%**       |
| False closure rate                              | **0%**         |
| Hallucination guardrail accuracy                | **100%**       |
| CRI ranking correctness                         | **100%**       |
| Write gate integrity                            | **100%**       |
| Multilingual outreach                           | **100%**       |
| PubMed evidence retrieval                       | **100%**       |
| **Overall — 50 assertions across 17 scenarios** | **50/50 pass** |

All scenarios run on a live Prompt Opinion workspace against a deployed FHIR R4 server using synthetic patient data. Results are reproducible — the pipeline is deterministic end-to-end.

---

## SMS Outreach Benchmark (`send_sms_outreach`)

`send_sms_outreach` sends a Twilio SMS only when `clinicianApprovalConfirmed: true` is provided in the same conversation turn. English (`en`) only on current Twilio trial account.

| Scenario                                             | Expected                                                 | Result                                      |
| ---------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| Approved English outreach — James Chen PSA OPEN_LOOP | `status: "sent"`, `messageSid` starts with `SM`          | ✅ `SMce30...` delivered to verified number |
| Send blocked without same-turn approval              | `status: "not_sent"`, `CLINICIAN_APPROVAL_NOT_CONFIRMED` | ✅ blocked; no Twilio API call made         |
