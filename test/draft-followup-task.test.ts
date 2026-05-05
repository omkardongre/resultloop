import { describe, expect, it } from "vitest";
import {
  draftFollowupTaskResource,
  sha256CanonicalJson,
} from "../src/clinical/draft-followup-task.js";

describe("draftFollowupTaskResource", () => {
  const closureArtifact = {
    closureStatus: "OPEN_LOOP",
    patient: { id: "patient-maria" },
    abnormalResult: {
      reference: "DiagnosticReport/mammo-1",
      display: "Screening Mammogram",
    },
  };

  it("creates draft FHIR Task and AuditEvent for an open loop", () => {
    const result = draftFollowupTaskResource({
      patientId: "patient-maria",
      resultReference: "DiagnosticReport/mammo-1",
      resultDisplay: "Screening Mammogram",
      resultDate: "2026-03-10",
      resultValue: "BI-RADS 4",
      closureStatus: "OPEN_LOOP",
      priority: "asap",
      planDescription: "Clinician review of suspicious mammogram follow-up gap.",
      closureArtifact,
      authoredOn: "2026-05-01T00:00:00.000Z",
    });

    expect(result.status).toBe("draft_resources_created");
    expect(result.closureArtifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.task?.resourceType).toBe("Task");
    expect(result.task?.status).toBe("draft");
    expect(result.task?.intent).toBe("proposal");
    expect(result.task?.priority).toBe("asap");
    expect(result.task?.focus).toEqual({
      reference: "DiagnosticReport/mammo-1",
      display: "Screening Mammogram",
    });
    expect(result.task?.for).toEqual({ reference: "Patient/patient-maria" });
    expect(result.task?.requester).toEqual({ display: "ResultLoop MCP" });
    expect(result.task?.reasonReference).toEqual({
      reference: "DiagnosticReport/mammo-1",
      display: "Screening Mammogram: BI-RADS 4",
    });
    expect(result.auditEvent?.resourceType).toBe("AuditEvent");
    expect(result.auditEvent?.action).toBe("E");
    expect(result.auditEvent?.outcome).toBe("0");
  });

  it("does not create Task for closed loop results", () => {
    const result = draftFollowupTaskResource({
      patientId: "patient-sarah",
      resultReference: "Observation/tsh-1",
      resultDisplay: "TSH",
      resultDate: "2026-03-01",
      closureStatus: "CLOSED",
      planDescription: "Review closed result.",
      closureArtifact: { closureStatus: "CLOSED" },
    });

    expect(result.status).toBe("not_created");
    expect(result.task).toBeUndefined();
    expect(result.auditEvent).toBeUndefined();
    expect(result.closureArtifactHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes canonical JSON independent of object key order", () => {
    const left = sha256CanonicalJson({ b: 2, a: { d: 4, c: 3 } });
    const right = sha256CanonicalJson({ a: { c: 3, d: 4 }, b: 2 });

    expect(left).toBe(right);
  });
});
