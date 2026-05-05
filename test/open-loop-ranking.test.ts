import { describe, expect, it } from "vitest";
import { rankOpenLoopsBySeverity } from "../src/clinical/open-loop-ranking.js";

describe("rankOpenLoopsBySeverity", () => {
  const asOfDate = new Date("2026-05-01T00:00:00.000Z");

  it("ranks source-cited high-risk imaging above routine abnormal labs", () => {
    const ranked = rankOpenLoopsBySeverity(
      [
        {
          reference: "Observation/a1c-1",
          date: "2026-04-20",
          display: "Hemoglobin A1c",
          value: 9.4,
          unit: "%",
          closureStatus: "OPEN_LOOP",
        },
        {
          reference: "DiagnosticReport/mammo-1",
          date: "2026-04-25",
          display: "Screening mammogram",
          interpretation: "BI-RADS 4 suspicious abnormality",
          closureStatus: "OPEN_LOOP",
        },
      ],
      asOfDate,
    );

    expect(ranked[0]?.reference).toBe("DiagnosticReport/mammo-1");
    expect(ranked[0]?.severityLevel).toBe("HIGH");
    expect(ranked[0]?.recommendedQueue).toBe("urgent_review");
    expect(ranked[0]?.rank).toBe(1);
  });

  it("ranks imaging reports as urgent when severity text is in value", () => {
    const ranked = rankOpenLoopsBySeverity(
      [
        {
          reference: "DiagnosticReport/ct-1",
          date: "2026-02-05",
          display: "CT Chest with Contrast",
          value: "12mm solid pulmonary nodule, Lung-RADS 4A: Suspicious",
          closureStatus: "OPEN_LOOP",
        },
      ],
      asOfDate,
    );

    expect(ranked[0]?.severityLevel).toBe("HIGH");
    expect(ranked[0]?.recommendedQueue).toBe("urgent_review");
    expect(ranked[0]?.severitySignals.map((signal) => signal.id)).toContain(
      "lung-rads-high-suspicion",
    );
  });

  it("ranks critical potassium as immediate review", () => {
    const ranked = rankOpenLoopsBySeverity(
      [
        {
          reference: "Observation/k-1",
          date: "2026-04-30",
          display: "Potassium",
          value: 6.4,
          closureStatus: "OPEN_LOOP",
        },
      ],
      asOfDate,
    );

    expect(ranked[0]?.severityLevel).toBe("CRITICAL");
    expect(ranked[0]?.recommendedQueue).toBe("immediate_review");
  });

  it("adds timeliness priority for older open loops", () => {
    const ranked = rankOpenLoopsBySeverity(
      [
        {
          reference: "Observation/old-1",
          date: "2026-03-01",
          display: "Unknown abnormal lab",
          interpretation: "Abnormal",
          closureStatus: "OPEN_LOOP",
        },
        {
          reference: "Observation/new-1",
          date: "2026-04-25",
          display: "Unknown abnormal lab",
          interpretation: "Abnormal",
          closureStatus: "OPEN_LOOP",
        },
      ],
      asOfDate,
    );

    expect(ranked[0]?.reference).toBe("Observation/old-1");
    expect(ranked[0]?.timelinessScore).toBe(30);
    expect(ranked[1]?.timelinessScore).toBe(0);
  });

  it("excludes closed loops from the ranking", () => {
    const ranked = rankOpenLoopsBySeverity(
      [
        {
          reference: "DiagnosticReport/closed-1",
          date: "2026-03-01",
          display: "Mammogram",
          interpretation: "BI-RADS 4",
          closureStatus: "CLOSED",
        },
        {
          reference: "Observation/open-1",
          date: "2026-04-01",
          display: "Hemoglobin",
          value: 7.5,
          closureStatus: "OPEN_LOOP",
        },
      ],
      asOfDate,
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.reference).toBe("Observation/open-1");
  });
});
