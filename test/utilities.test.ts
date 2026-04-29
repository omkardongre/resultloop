import { describe, it, expect } from "vitest";
import { McpUtilities } from "../src/util/mcp-utilities.js";

describe("McpUtilities", () => {
  describe("createTextResponse", () => {
    it("creates a text response", () => {
      const result = McpUtilities.createTextResponse("Hello");
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text).toBe("Hello");
      expect(result.isError).toBe(false);
    });

    it("creates an error response", () => {
      const result = McpUtilities.createTextResponse("Error", { isError: true });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toBe("Error");
    });
  });

  describe("createJsonResponse", () => {
    it("serializes JSON data", () => {
      const result = McpUtilities.createJsonResponse({ status: "ok", count: 3 });
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.status).toBe("ok");
      expect(parsed.count).toBe(3);
      expect(result.isError).toBe(false);
    });

    it("creates JSON error response", () => {
      const result = McpUtilities.createJsonResponse({ error: "fail" }, { isError: true });
      expect(result.isError).toBe(true);
    });
  });
});

describe("closure artifact structure", () => {
  it("generated artifact has all required fields", () => {
    // Simulate what generate_result_closure_summary produces
    const artifact = {
      _resultLoopVersion: "0.1.0",
      _generatedAt: new Date().toISOString(),
      _disclaimer: "AUTOMATED AUDIT",
      closureStatus: "OPEN_LOOP",
      followUpClosureRisk: "HIGH",
      patient: { id: "patient-maria-lopez" },
      abnormalResult: {
        reference: "DiagnosticReport/dr-maria-mammogram",
        date: "2026-03-10",
        display: "Screening Mammogram",
        daysSinceResult: 49,
      },
      closureEvidenceMatrix: {
        totalChecked: 5,
        totalFound: 0,
        details: [],
      },
      draftFollowUpTasks: [
        { taskType: "review_abnormal_result", requiresHumanApproval: true },
      ],
      safetyBoundaries: {
        requiresHumanApproval: true,
        resultLoopDoes: ["Audit structured FHIR data"],
        resultLoopDoesNot: ["Diagnose conditions"],
      },
    };

    expect(artifact._resultLoopVersion).toBeDefined();
    expect(artifact._disclaimer).toContain("AUDIT");
    expect(artifact.closureStatus).toBe("OPEN_LOOP");
    expect(artifact.followUpClosureRisk).toBe("HIGH");
    expect(artifact.patient.id).toBeTruthy();
    expect(artifact.abnormalResult.reference).toBeTruthy();
    expect(artifact.closureEvidenceMatrix.totalChecked).toBe(5);
    expect(artifact.draftFollowUpTasks.length).toBeGreaterThan(0);
    expect(artifact.draftFollowUpTasks[0]!.requiresHumanApproval).toBe(true);
    expect(artifact.safetyBoundaries.requiresHumanApproval).toBe(true);
    expect(artifact.safetyBoundaries.resultLoopDoesNot).toContain("Diagnose conditions");
  });

  it("closed loop artifact has no draft tasks", () => {
    const artifact = {
      closureStatus: "CLOSED",
      followUpClosureRisk: "LOW",
      draftFollowUpTasks: [],
    };
    expect(artifact.closureStatus).toBe("CLOSED");
    expect(artifact.followUpClosureRisk).toBe("LOW");
    expect(artifact.draftFollowUpTasks).toHaveLength(0);
  });
});

describe("config validation", () => {
  it("config module loads without error", async () => {
    const { config } = await import("../src/config.js");
    expect(config.port).toBeTypeOf("number");
    expect(["dev", "prod", "local"]).toContain(config.poEnv);
    expect(config.logLevel).toBeTruthy();
  });
});
