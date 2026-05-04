import { describe, expect, it } from "vitest";
import {
  classifyResultSeverity,
  collectSeveritySignals,
} from "../src/clinical/thresholds.js";

describe("clinical severity thresholds", () => {
  it("classifies BI-RADS 4 as high severity", () => {
    const result = classifyResultSeverity({
      display: "Screening Mammogram",
      interpretation: "BI-RADS 4: suspicious abnormality",
    });

    expect(result.level).toBe("HIGH");
    expect(result.signals.map((signal) => signal.id)).toContain(
      "bi-rads-high-suspicion",
    );
  });

  it("classifies Lung-RADS 4A as high severity", () => {
    const signals = collectSeveritySignals({
      display: "Low dose chest CT",
      interpretation: "Lung-RADS 4A pulmonary nodule",
    });

    expect(signals.map((signal) => signal.id)).toContain(
      "lung-rads-high-suspicion",
    );
  });

  it("classifies HbA1c at or above 9 as moderate severity", () => {
    const result = classifyResultSeverity({
      code: "4548-4",
      display: "Hemoglobin A1c/Hemoglobin.total in Blood",
      value: "9.2",
      unit: "%",
    });

    expect(result.level).toBe("MODERATE");
    expect(result.signals[0]?.id).toBe("a1c-poor-control");
  });

  it("classifies eGFR below 30 as high severity", () => {
    const result = classifyResultSeverity({
      display: "Estimated glomerular filtration rate",
      value: 24,
      unit: "mL/min/1.73 m2",
    });

    expect(result.level).toBe("HIGH");
    expect(result.signals[0]?.id).toBe("egfr-severely-decreased");
  });

  it("classifies eGFR below 60 as moderate severity", () => {
    const result = classifyResultSeverity({
      display: "eGFR",
      value: 52,
    });

    expect(result.level).toBe("MODERATE");
    expect(result.signals[0]?.id).toBe("egfr-decreased");
  });

  it("classifies marked TSH abnormalities as moderate severity", () => {
    const high = classifyResultSeverity({ display: "TSH", value: 18.4 });
    const low = classifyResultSeverity({ display: "TSH", value: 0.04 });

    expect(high.level).toBe("MODERATE");
    expect(low.level).toBe("MODERATE");
  });

  it("classifies critical potassium as critical severity", () => {
    const high = classifyResultSeverity({ display: "Potassium", value: 6.2 });
    const low = classifyResultSeverity({ display: "Potassium", value: 2.8 });

    expect(high.level).toBe("CRITICAL");
    expect(low.level).toBe("CRITICAL");
  });

  it("classifies positive FIT as high severity", () => {
    const result = classifyResultSeverity({
      display: "Fecal immunochemical test",
      interpretation: "Positive",
    });

    expect(result.level).toBe("HIGH");
    expect(result.signals[0]?.id).toBe("fit-positive");
  });

  it("classifies hemoglobin below 8 as high severity", () => {
    const result = classifyResultSeverity({
      code: "718-7",
      display: "Hemoglobin",
      value: 7.4,
      unit: "g/dL",
    });

    expect(result.level).toBe("HIGH");
    expect(result.signals[0]?.id).toBe("hemoglobin-critical-low");
  });

  it("returns low severity when no source-cited threshold is matched", () => {
    const result = classifyResultSeverity({
      display: "Unknown abnormal lab",
      interpretation: "Abnormal",
      value: 12,
    });

    expect(result.level).toBe("LOW");
    expect(result.signals).toHaveLength(0);
  });
});
