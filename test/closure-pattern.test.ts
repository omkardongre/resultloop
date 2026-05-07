import { describe, expect, it } from "vitest";
import {
  LoopHistoryRecord,
  summarizeLoopHistory,
} from "../src/clinical/closure-pattern.js";

describe("summarizeLoopHistory", () => {
  it("returns LOW pattern severity when no abnormal results exist", () => {
    const summary = summarizeLoopHistory([], 24);

    expect(summary.totalAbnormalInPeriod).toBe(0);
    expect(summary.totalUnfollowed).toBe(0);
    expect(summary.overallClosureRate).toBe(1);
    expect(summary.repeatedTypes).toHaveLength(0);
    expect(summary.patternSeverity).toBe("LOW");
    expect(summary.patternFlags).toHaveLength(0);
    expect(summary.demoLine).toBeUndefined();
  });

  it("returns LOW pattern severity when single abnormal result is closed", () => {
    const records: LoopHistoryRecord[] = [
      {
        reference: "Observation/a1c-1",
        resultType: "Hemoglobin A1c",
        date: "2025-08-01",
        closureStatus: "CLOSED",
        severityLevel: "MODERATE",
      },
    ];

    const summary = summarizeLoopHistory(records, 24);

    expect(summary.totalAbnormalInPeriod).toBe(1);
    expect(summary.totalClosed).toBe(1);
    expect(summary.totalUnfollowed).toBe(0);
    expect(summary.overallClosureRate).toBe(1);
    expect(summary.repeatedTypes).toHaveLength(0);
    expect(summary.patternSeverity).toBe("LOW");
    expect(summary.demoLine).toBeUndefined();
  });

  it("flags HIGH pattern when same high-severity test is repeatedly unfollowed", () => {
    const records: LoopHistoryRecord[] = [
      {
        reference: "DiagnosticReport/mammo-1",
        resultType: "Screening Mammogram",
        date: "2024-08-01",
        closureStatus: "CLOSED",
        severityLevel: "HIGH",
      },
      {
        reference: "DiagnosticReport/mammo-2",
        resultType: "Screening Mammogram",
        date: "2025-04-01",
        closureStatus: "OPEN_LOOP",
        severityLevel: "HIGH",
      },
    ];

    const summary = summarizeLoopHistory(records, 24);

    expect(summary.totalAbnormalInPeriod).toBe(2);
    expect(summary.totalUnfollowed).toBe(1);
    expect(summary.repeatedTypes).toHaveLength(1);
    expect(summary.repeatedTypes[0].resultType).toBe("Screening Mammogram");
    expect(summary.repeatedTypes[0].totalCount).toBe(2);
    expect(summary.repeatedTypes[0].openLoopCount).toBe(1);
    expect(summary.repeatedTypes[0].closureRate).toBeCloseTo(0.5, 5);
    expect(summary.repeatedTypes[0].worstSeverity).toBe("HIGH");
    expect(summary.patternFlags).toContain("repeat-failure");
    expect(summary.patternFlags).toContain("high-severity-repeat");
    expect(summary.patternSeverity).toBe("HIGH");
    expect(summary.demoLine).toMatch(/Screening Mammogram/);
    expect(summary.demoLine).toMatch(/2/);
  });

  it("flags CRITICAL pattern when 3+ abnormal of same type are unfollowed at high severity", () => {
    const records: LoopHistoryRecord[] = [
      {
        reference: "DiagnosticReport/mammo-1",
        resultType: "Screening Mammogram",
        date: "2024-05-01",
        closureStatus: "CLOSED",
        severityLevel: "HIGH",
      },
      {
        reference: "DiagnosticReport/mammo-2",
        resultType: "Screening Mammogram",
        date: "2025-02-01",
        closureStatus: "OPEN_LOOP",
        severityLevel: "HIGH",
      },
      {
        reference: "DiagnosticReport/mammo-3",
        resultType: "Screening Mammogram",
        date: "2026-03-01",
        closureStatus: "OPEN_LOOP",
        severityLevel: "HIGH",
      },
    ];

    const summary = summarizeLoopHistory(records, 24);

    expect(summary.totalAbnormalInPeriod).toBe(3);
    expect(summary.totalUnfollowed).toBe(2);
    expect(summary.patternFlags).toContain("critical-recurrence");
    expect(summary.patternSeverity).toBe("CRITICAL");
    expect(summary.demoLine).toMatch(/3 abnormal Screening Mammogram/);
  });

  it("flags MEDIUM pattern when repeated abnormal but only LOW or MODERATE severity", () => {
    const records: LoopHistoryRecord[] = [
      {
        reference: "Observation/wbc-1",
        resultType: "WBC Count",
        date: "2025-05-01",
        closureStatus: "OPEN_LOOP",
        severityLevel: "MODERATE",
      },
      {
        reference: "Observation/wbc-2",
        resultType: "WBC Count",
        date: "2026-01-01",
        closureStatus: "OPEN_LOOP",
        severityLevel: "LOW",
      },
    ];

    const summary = summarizeLoopHistory(records, 24);

    expect(summary.patternSeverity).toBe("MEDIUM");
    expect(summary.patternFlags).toContain("repeat-failure");
    expect(summary.patternFlags).toContain("low-closure-rate");
    expect(summary.demoLine).toBeDefined();
  });

  it("does not flag a type as repeated when it appears only once", () => {
    const records: LoopHistoryRecord[] = [
      {
        reference: "Observation/wbc-1",
        resultType: "WBC Count",
        date: "2026-01-01",
        closureStatus: "OPEN_LOOP",
        severityLevel: "MODERATE",
      },
      {
        reference: "Observation/a1c-1",
        resultType: "Hemoglobin A1c",
        date: "2026-02-01",
        closureStatus: "CLOSED",
        severityLevel: "MODERATE",
      },
    ];

    const summary = summarizeLoopHistory(records, 24);

    expect(summary.repeatedTypes).toHaveLength(0);
    expect(summary.patternFlags).not.toContain("repeat-failure");
  });

  it("treats result type matching as case-insensitive and trim-tolerant", () => {
    const records: LoopHistoryRecord[] = [
      {
        reference: "DiagnosticReport/m1",
        resultType: "Screening Mammogram",
        date: "2025-01-01",
        closureStatus: "OPEN_LOOP",
        severityLevel: "HIGH",
      },
      {
        reference: "DiagnosticReport/m2",
        resultType: "  screening mammogram  ",
        date: "2026-01-01",
        closureStatus: "OPEN_LOOP",
        severityLevel: "HIGH",
      },
    ];

    const summary = summarizeLoopHistory(records, 24);

    expect(summary.repeatedTypes).toHaveLength(1);
    expect(summary.repeatedTypes[0].totalCount).toBe(2);
  });

  it("orders repeated-types so the highest-severity unfollowed pattern is first", () => {
    const records: LoopHistoryRecord[] = [
      {
        reference: "Observation/wbc-1",
        resultType: "WBC Count",
        date: "2025-05-01",
        closureStatus: "OPEN_LOOP",
        severityLevel: "MODERATE",
      },
      {
        reference: "Observation/wbc-2",
        resultType: "WBC Count",
        date: "2025-09-01",
        closureStatus: "OPEN_LOOP",
        severityLevel: "MODERATE",
      },
      {
        reference: "DiagnosticReport/mammo-1",
        resultType: "Screening Mammogram",
        date: "2025-08-01",
        closureStatus: "OPEN_LOOP",
        severityLevel: "HIGH",
      },
      {
        reference: "DiagnosticReport/mammo-2",
        resultType: "Screening Mammogram",
        date: "2026-01-01",
        closureStatus: "CLOSED",
        severityLevel: "HIGH",
      },
    ];

    const summary = summarizeLoopHistory(records, 24);

    expect(summary.repeatedTypes[0].resultType).toBe("Screening Mammogram");
    expect(summary.repeatedTypes[0].worstSeverity).toBe("HIGH");
  });

  it("computes overall closure rate correctly with mixed statuses", () => {
    const records: LoopHistoryRecord[] = [
      {
        reference: "Observation/x-1",
        resultType: "X",
        date: "2025-01-01",
        closureStatus: "CLOSED",
        severityLevel: "MODERATE",
      },
      {
        reference: "Observation/x-2",
        resultType: "X",
        date: "2025-06-01",
        closureStatus: "OPEN_LOOP",
        severityLevel: "MODERATE",
      },
      {
        reference: "Observation/y-1",
        resultType: "Y",
        date: "2026-02-01",
        closureStatus: "NOT_YET_OVERDUE",
        severityLevel: "LOW",
      },
      {
        reference: "Observation/z-1",
        resultType: "Z",
        date: "2026-03-01",
        closureStatus: "INSUFFICIENT_EVIDENCE",
        severityLevel: "LOW",
      },
    ];

    const summary = summarizeLoopHistory(records, 24);

    expect(summary.totalAbnormalInPeriod).toBe(4);
    expect(summary.totalClosed).toBe(1);
    expect(summary.totalUnfollowed).toBe(1);
    expect(summary.overallClosureRate).toBeCloseTo(0.25, 5);
    expect(summary.patternFlags).toContain("low-closure-rate");
  });
});
