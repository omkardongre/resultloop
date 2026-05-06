import { describe, expect, it } from "vitest";
import {
  extractFhirReferences,
  verifyClosureClaim,
} from "../src/clinical/verify-closure-claim.js";

function openLoopArtifact() {
  return {
    closureStatus: "OPEN_LOOP",
    patient: { id: "patient-maria" },
    abnormalResult: {
      reference: "DiagnosticReport/mammo-1",
      date: "2026-03-10",
      display: "Screening Mammogram",
    },
    closureEvidenceMatrix: {
      totalChecked: 5,
      totalFound: 0,
      details: [
        {
          resourceType: "ServiceRequest",
          evidenceFound: false,
          count: 0,
          references: [] as string[],
        },
        {
          resourceType: "Task",
          evidenceFound: false,
          count: 0,
          references: [] as string[],
        },
      ],
    },
  };
}

function closedLoopArtifact() {
  return {
    closureStatus: "CLOSED",
    patient: { id: "patient-sarah" },
    abnormalResult: {
      reference: "Observation/tsh-1",
      date: "2026-03-01",
      display: "TSH",
    },
    closureEvidenceMatrix: {
      totalChecked: 5,
      totalFound: 2,
      details: [
        {
          resourceType: "ServiceRequest",
          evidenceFound: true,
          count: 1,
          references: ["ServiceRequest/tsh-followup-1"],
        },
        {
          resourceType: "Task",
          evidenceFound: true,
          count: 1,
          references: ["Task/tsh-task-1"],
        },
      ],
    },
  };
}

describe("verifyClosureClaim", () => {
  it("passes an open-loop artifact with zero follow-up evidence", () => {
    const result = verifyClosureClaim({
      closureArtifact: openLoopArtifact(),
    });

    expect(result.status).toBe("PASS");
    expect(result.auditedResult).toBe("DiagnosticReport/mammo-1");
    expect(result.verifiedReferences).toContain("DiagnosticReport/mammo-1");
    expect(result.contradictions).toHaveLength(0);
  });

  it("passes a closed-loop artifact with cited follow-up evidence", () => {
    const result = verifyClosureClaim({
      closureArtifact: closedLoopArtifact(),
    });

    expect(result.status).toBe("PASS");
    expect(result.verifiedReferences).toContain("Observation/tsh-1");
    expect(result.verifiedReferences).toContain(
      "ServiceRequest/tsh-followup-1",
    );
    expect(result.verifiedReferences).toContain("Task/tsh-task-1");
  });

  it("flags contradiction when OPEN_LOOP cites follow-up evidence", () => {
    const artifact = openLoopArtifact();
    artifact.closureEvidenceMatrix.totalFound = 1;
    artifact.closureEvidenceMatrix.details[0]!.references = [
      "ServiceRequest/mammo-followup-1",
    ];

    const result = verifyClosureClaim({ closureArtifact: artifact });

    expect(result.status).toBe("CONTRADICTION");
    expect(result.contradictions.join(" ")).toContain("OPEN_LOOP");
  });

  it("flags contradiction when CLOSED has no follow-up references", () => {
    const artifact = closedLoopArtifact();
    artifact.closureEvidenceMatrix.totalFound = 0;
    artifact.closureEvidenceMatrix.details = [];

    const result = verifyClosureClaim({ closureArtifact: artifact });

    expect(result.status).toBe("CONTRADICTION");
    expect(result.contradictions.join(" ")).toContain("CLOSED");
  });

  it("flags contradiction when artifact and follow-up context disagree", () => {
    const result = verifyClosureClaim({
      closureArtifact: openLoopArtifact(),
      followUpContext: {
        closureStatus: "CLOSED",
        totalFollowUpEvidenceFound: 1,
      },
    });

    expect(result.status).toBe("CONTRADICTION");
    expect(result.contradictions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("conflicts with follow-up context status"),
      ]),
    );
  });

  it("returns insufficient evidence when cited references cannot be fetched", () => {
    const result = verifyClosureClaim({
      closureArtifact: closedLoopArtifact(),
      fetchedReferences: ["Observation/tsh-1", "ServiceRequest/tsh-followup-1"],
      missingFetchedReferences: ["Task/tsh-task-1"],
    });

    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.missingReferences).toContain("Task/tsh-task-1");
  });

  it("returns insufficient evidence when follow-up context asks to abstain", () => {
    const result = verifyClosureClaim({
      closureArtifact: openLoopArtifact(),
      followUpContext: {
        closureStatus: "OPEN_LOOP",
        totalFollowUpEvidenceFound: 0,
        shouldAbstain: true,
        searchErrors: ["Task: 403"],
      },
    });

    expect(result.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.warnings.join(" ")).toContain("abstention");
  });
});

describe("extractFhirReferences", () => {
  it("extracts unique FHIR references from nested text and objects", () => {
    const references = extractFhirReferences({
      result: "Reviewed DiagnosticReport/mammo-1 and Observation/a1c-1.",
      nested: [{ reference: "DiagnosticReport/mammo-1" }],
    });

    expect(references).toEqual([
      "DiagnosticReport/mammo-1",
      "Observation/a1c-1",
    ]);
  });
});
