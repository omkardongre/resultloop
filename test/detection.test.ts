import { describe, it, expect } from "vitest";

/**
 * Unit tests for abnormal result detection logic.
 */

function isAbnormalObservation(obs: Record<string, unknown>): boolean {
  const interpretation = obs["interpretation"] as
    | Array<{ coding?: Array<{ code?: string }> }>
    | undefined;
  if (interpretation) {
    for (const interp of interpretation) {
      if (interp.coding) {
        for (const coding of interp.coding) {
          const code = coding.code?.toUpperCase();
          if (code && ["A","AA","H","HH","L","LL","HU","LU","CR"].includes(code)) return true;
        }
      }
    }
  }
  const vq = obs["valueQuantity"] as { value?: number } | undefined;
  const rr = obs["referenceRange"] as Array<{ low?: { value?: number }; high?: { value?: number } }> | undefined;
  if (vq?.value !== undefined && rr?.[0]) {
    if (rr[0].low?.value !== undefined && vq.value < rr[0].low.value) return true;
    if (rr[0].high?.value !== undefined && vq.value > rr[0].high.value) return true;
  }
  return false;
}

function isAbnormalDiagnosticReport(dr: Record<string, unknown>): boolean {
  const conclusion = (dr["conclusion"] as string)?.toLowerCase() || "";
  const keywords = ["abnormal","suspicious","malignant","positive","critical","concerning","irregular","mass","lesion","nodule","tumor","carcinoma","neoplasm","bi-rads 4","bi-rads 5","bi-rads 6"];
  for (const kw of keywords) { if (conclusion.includes(kw)) return true; }
  const cc = dr["conclusionCode"] as Array<{ text?: string }> | undefined;
  if (cc) { for (const c of cc) { const t = c.text?.toLowerCase() || ""; for (const kw of keywords) { if (t.includes(kw)) return true; } } }
  return false;
}

describe("isAbnormalObservation", () => {
  it("detects H code", () => expect(isAbnormalObservation({ interpretation: [{ coding: [{ code: "H" }] }] })).toBe(true));
  it("detects HH code", () => expect(isAbnormalObservation({ interpretation: [{ coding: [{ code: "HH" }] }] })).toBe(true));
  it("detects L code", () => expect(isAbnormalObservation({ interpretation: [{ coding: [{ code: "L" }] }] })).toBe(true));
  it("detects LL code", () => expect(isAbnormalObservation({ interpretation: [{ coding: [{ code: "LL" }] }] })).toBe(true));
  it("detects A code", () => expect(isAbnormalObservation({ interpretation: [{ coding: [{ code: "A" }] }] })).toBe(true));
  it("detects CR code", () => expect(isAbnormalObservation({ interpretation: [{ coding: [{ code: "CR" }] }] })).toBe(true));
  it("case-insensitive", () => expect(isAbnormalObservation({ interpretation: [{ coding: [{ code: "hh" }] }] })).toBe(true));
  it("value above high", () => expect(isAbnormalObservation({ valueQuantity: { value: 12.8 }, referenceRange: [{ low: { value: 0 }, high: { value: 4.0 } }] })).toBe(true));
  it("value below low", () => expect(isAbnormalObservation({ valueQuantity: { value: 0.2 }, referenceRange: [{ low: { value: 0.4 }, high: { value: 4.0 } }] })).toBe(true));
  it("normal N code returns false", () => expect(isAbnormalObservation({ interpretation: [{ coding: [{ code: "N" }] }] })).toBe(false));
  it("value in range returns false", () => expect(isAbnormalObservation({ valueQuantity: { value: 2.5 }, referenceRange: [{ low: { value: 0 }, high: { value: 4.0 } }] })).toBe(false));
  it("no interpretation or range returns false", () => expect(isAbnormalObservation({ valueQuantity: { value: 120 } })).toBe(false));
  it("empty obs returns false", () => expect(isAbnormalObservation({})).toBe(false));
  it("at boundary returns false", () => expect(isAbnormalObservation({ valueQuantity: { value: 4.0 }, referenceRange: [{ low: { value: 0 }, high: { value: 4.0 } }] })).toBe(false));
  it("only high bound", () => expect(isAbnormalObservation({ valueQuantity: { value: 50 }, referenceRange: [{ high: { value: 35 } }] })).toBe(true));
  it("only low bound", () => expect(isAbnormalObservation({ valueQuantity: { value: 3.0 }, referenceRange: [{ low: { value: 12.0 } }] })).toBe(true));
});

describe("isAbnormalDiagnosticReport", () => {
  it("detects suspicious", () => expect(isAbnormalDiagnosticReport({ conclusion: "BI-RADS 4: Suspicious" })).toBe(true));
  it("detects malignant", () => expect(isAbnormalDiagnosticReport({ conclusion: "malignant process" })).toBe(true));
  it("detects nodule", () => expect(isAbnormalDiagnosticReport({ conclusion: "pulmonary nodule" })).toBe(true));
  it("detects mass", () => expect(isAbnormalDiagnosticReport({ conclusion: "irregular mass" })).toBe(true));
  it("detects bi-rads 5", () => expect(isAbnormalDiagnosticReport({ conclusion: "bi-rads 5" })).toBe(true));
  it("detects tumor", () => expect(isAbnormalDiagnosticReport({ conclusion: "tumor growth" })).toBe(true));
  it("detects carcinoma", () => expect(isAbnormalDiagnosticReport({ conclusion: "ductal carcinoma" })).toBe(true));
  it("detects in conclusionCode", () => expect(isAbnormalDiagnosticReport({ conclusion: "Normal", conclusionCode: [{ text: "Abnormal result" }] })).toBe(true));
  it("normal returns false", () => expect(isAbnormalDiagnosticReport({ conclusion: "No findings. Normal." })).toBe(false));
  it("bi-rads 1 returns false", () => expect(isAbnormalDiagnosticReport({ conclusion: "BI-RADS 1: Negative" })).toBe(false));
  it("bi-rads 2 returns false", () => expect(isAbnormalDiagnosticReport({ conclusion: "BI-RADS 2: Benign" })).toBe(false));
  it("empty returns false", () => expect(isAbnormalDiagnosticReport({ conclusion: "" })).toBe(false));
  it("missing returns false", () => expect(isAbnormalDiagnosticReport({})).toBe(false));
  it("case-insensitive", () => expect(isAbnormalDiagnosticReport({ conclusion: "SUSPICIOUS" })).toBe(true));
});
