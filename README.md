# ResultLoop

**Abnormal Result Follow-Up Closure Audit MCP Server**

A SHARP-on-MCP compliant server that audits patient records for abnormal lab and imaging results lacking documented follow-up — the clinical safety gaps where patients fall through the cracks.

## Problem

7.1% of abnormal test results have no documented follow-up action (Singh et al., 2014). This leads to delayed cancer diagnoses, missed critical conditions, and preventable patient harm.

## Solution

ResultLoop scans structured FHIR data to detect **open-loop abnormal results** — findings that were flagged as abnormal but have no corresponding follow-up order, task, communication, or care plan. It generates a structured closure audit artifact with draft follow-up tasks for clinician review.

## Architecture

```
Prompt Opinion Workspace
        ↓
  BYO Patient-Safety Agent
        ↓
  ResultLoop MCP Server
        ↓
  FHIR R4 API (workspace)
        ↓
  Closure Audit Artifact
        ↓
  Clinician Review
```

## MCP Tools

| Tool | Purpose |
|------|---------|
| `find_recent_abnormal_results` | Scan Observations and DiagnosticReports for abnormal flags |
| `get_result_followup_context` | Audit ServiceRequest, Task, Communication, CarePlan, Encounter after result date |
| `generate_result_closure_summary` | Generate structured closure audit artifact with draft tasks |

## FHIR Resources Used

- `Patient` — Patient context
- `Observation` — Lab results with interpretation codes
- `DiagnosticReport` — Imaging/pathology results with conclusions
- `ServiceRequest` — Follow-up orders
- `Task` — Follow-up tasks
- `Communication` — Patient/provider notifications
- `CarePlan` — Follow-up care plans

## Safety Boundaries

ResultLoop is an **audit tool**, not a clinical decision system.

- ✅ Audits structured FHIR data for follow-up evidence
- ✅ Flags results with no documented follow-up
- ✅ Generates draft tasks for clinician review
- ❌ Does NOT diagnose conditions
- ❌ Does NOT recommend treatments
- ❌ Does NOT order clinical actions
- ❌ Does NOT contact patients directly

All outputs require clinician approval before action.

## Setup

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env

# Start development server
npm run dev

# Run tests
npm test

# Type check
npm run typecheck

# Build for production
npm run build
```

## License

Apache-2.0
# resultloop
