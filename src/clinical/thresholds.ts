export type SeverityLevel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

export type ThresholdCitation = {
  source: string;
  citationUrl: string;
};

export type SeveritySignal = ThresholdCitation & {
  id: string;
  label: string;
  level: SeverityLevel;
  rationale: string;
};

export type AbnormalResultLike = {
  resourceType?: string;
  code?: string;
  display?: string;
  value?: string | number;
  unit?: string;
  interpretation?: string;
};

export const CLINICAL_THRESHOLD_CITATIONS = {
  birads: {
    source: "American College of Radiology BI-RADS Atlas",
    citationUrl:
      "https://www.acr.org/Clinical-Resources/Reporting-and-Data-Systems/Bi-Rads",
  },
  lungRads: {
    source: "American College of Radiology Lung-RADS Assessment Categories",
    citationUrl:
      "https://www.acr.org/Clinical-Resources/Reporting-and-Data-Systems/Lung-Rads",
  },
  diabetes: {
    source: "American Diabetes Association Standards of Care in Diabetes",
    citationUrl: "https://diabetesjournals.org/care/issue",
  },
  kidney: {
    source: "KDIGO CKD Evaluation and Management Guideline",
    citationUrl: "https://kdigo.org/guidelines/ckd-evaluation-and-management/",
  },
  thyroid: {
    source:
      "American Thyroid Association patient thyroid function test guidance",
    citationUrl: "https://www.thyroid.org/thyroid-function-tests/",
  },
  potassium: {
    source: "MedlinePlus potassium blood test reference ranges",
    citationUrl: "https://medlineplus.gov/lab-tests/potassium-blood-test/",
  },
  fit: {
    source: "USPSTF colorectal cancer screening recommendation",
    citationUrl:
      "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/colorectal-cancer-screening",
  },
  hemoglobin: {
    source: "Merck Manual anemia overview and hemoglobin thresholds",
    citationUrl:
      "https://www.merckmanuals.com/professional/hematology-and-oncology/anemias/overview-of-anemia",
  },
} as const;

const HIGH_LEVEL_SCORE: Record<SeverityLevel, number> = {
  LOW: 1,
  MODERATE: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export function classifyResultSeverity(result: AbnormalResultLike): {
  level: SeverityLevel;
  score: number;
  signals: SeveritySignal[];
} {
  const signals = collectSeveritySignals(result);
  const level = signals.reduce<SeverityLevel>(
    (highest, signal) =>
      HIGH_LEVEL_SCORE[signal.level] > HIGH_LEVEL_SCORE[highest]
        ? signal.level
        : highest,
    "LOW",
  );

  return {
    level,
    score: HIGH_LEVEL_SCORE[level],
    signals,
  };
}

export function collectSeveritySignals(
  result: AbnormalResultLike,
): SeveritySignal[] {
  const text = normalizeText([
    result.code,
    result.display,
    typeof result.value === "string" ? result.value : undefined,
    result.interpretation,
    result.unit,
  ]);
  const numericValue = parseNumericValue(result.value);
  const signals: SeveritySignal[] = [];

  signals.push(...classifyImagingSeverity(text));
  signals.push(...classifyA1cSeverity(text, numericValue));
  signals.push(...classifyEgfrSeverity(text, numericValue));
  signals.push(...classifyTshSeverity(text, numericValue));
  signals.push(...classifyPotassiumSeverity(text, numericValue));
  signals.push(...classifyFitSeverity(text));
  signals.push(...classifyHemoglobinSeverity(text, numericValue));

  return dedupeSignals(signals);
}

function classifyImagingSeverity(text: string): SeveritySignal[] {
  const signals: SeveritySignal[] = [];

  if (/bi\s*-?\s*rads\s*(4|5|6)/i.test(text)) {
    signals.push({
      id: "bi-rads-high-suspicion",
      label: "BI-RADS 4-6 result",
      level: "HIGH",
      rationale:
        "BI-RADS 4, 5, or 6 is a high-concern imaging category that should be flagged for clinician review if no follow-up evidence is documented.",
      ...CLINICAL_THRESHOLD_CITATIONS.birads,
    });
  }

  if (/lung\s*-?\s*rads\s*(4a|4b|4x|4)/i.test(text)) {
    signals.push({
      id: "lung-rads-high-suspicion",
      label: "Lung-RADS 4 result",
      level: "HIGH",
      rationale:
        "Lung-RADS category 4 is a high-concern imaging category that should be flagged for clinician review if no follow-up evidence is documented.",
      ...CLINICAL_THRESHOLD_CITATIONS.lungRads,
    });
  }

  return signals;
}

function classifyA1cSeverity(
  text: string,
  value: number | null,
): SeveritySignal[] {
  if (!/(a1c|hba1c|hemoglobin a1c|4548-4)/i.test(text) || value === null) {
    return [];
  }

  if (value >= 9) {
    return [
      {
        id: "a1c-poor-control",
        label: "HbA1c at or above 9%",
        level: "MODERATE",
        rationale:
          "HbA1c at or above 9% is a high abnormal value that should be flagged for clinician review if no follow-up evidence is documented.",
        ...CLINICAL_THRESHOLD_CITATIONS.diabetes,
      },
    ];
  }

  return [];
}

function classifyEgfrSeverity(
  text: string,
  value: number | null,
): SeveritySignal[] {
  if (
    !/(egfr|estimated glomerular filtration|62238-1|33914-3)/i.test(text) ||
    value === null
  ) {
    return [];
  }

  if (value < 30) {
    return [
      {
        id: "egfr-severely-decreased",
        label: "eGFR below 30 mL/min/1.73 m2",
        level: "HIGH",
        rationale:
          "eGFR below 30 is a high-concern kidney-function value that should be flagged for clinician review if no follow-up evidence is documented.",
        ...CLINICAL_THRESHOLD_CITATIONS.kidney,
      },
    ];
  }

  if (value < 60) {
    return [
      {
        id: "egfr-decreased",
        label: "eGFR below 60 mL/min/1.73 m2",
        level: "MODERATE",
        rationale:
          "eGFR below 60 is an abnormal kidney-function value that should be interpreted by a clinician in patient context.",
        ...CLINICAL_THRESHOLD_CITATIONS.kidney,
      },
    ];
  }

  return [];
}

function classifyTshSeverity(
  text: string,
  value: number | null,
): SeveritySignal[] {
  if (
    !/(tsh|thyroid stimulating hormone|3016-3)/i.test(text) ||
    value === null
  ) {
    return [];
  }

  if (value < 0.1 || value > 10) {
    return [
      {
        id: "tsh-extreme",
        label: "TSH outside high-concern range",
        level: "MODERATE",
        rationale:
          "Markedly low or high TSH should be flagged for clinician review if no follow-up evidence is documented.",
        ...CLINICAL_THRESHOLD_CITATIONS.thyroid,
      },
    ];
  }

  return [];
}

function classifyPotassiumSeverity(
  text: string,
  value: number | null,
): SeveritySignal[] {
  if (!/(potassium|serum k|6298-4|2823-3)/i.test(text) || value === null) {
    return [];
  }

  if (value < 3 || value >= 6) {
    return [
      {
        id: "potassium-critical-range",
        label: "Potassium in critical range",
        level: "CRITICAL",
        rationale:
          "Potassium in this range is a high-concern value that should be flagged for clinician review if no follow-up evidence is documented.",
        ...CLINICAL_THRESHOLD_CITATIONS.potassium,
      },
    ];
  }

  return [];
}

function classifyFitSeverity(text: string): SeveritySignal[] {
  if (
    /(fit|fecal immunochemical|fecal occult|occult blood|2335-8|58453-2)/i.test(
      text,
    ) &&
    /positive|abnormal|detected/i.test(text)
  ) {
    return [
      {
        id: "fit-positive",
        label: "Positive stool blood screening test",
        level: "HIGH",
        rationale:
          "Positive colorectal cancer screening stool tests should be flagged for clinician review if no follow-up evidence is documented.",
        ...CLINICAL_THRESHOLD_CITATIONS.fit,
      },
    ];
  }

  return [];
}

function classifyHemoglobinSeverity(
  text: string,
  value: number | null,
): SeveritySignal[] {
  if (!/(hemoglobin|hgb|718-7)/i.test(text) || value === null) {
    return [];
  }

  if (value < 8) {
    return [
      {
        id: "hemoglobin-critical-low",
        label: "Hemoglobin below 8 g/dL",
        level: "HIGH",
        rationale:
          "Very low hemoglobin is a high-concern value that should be flagged for clinician review if no follow-up evidence is documented.",
        ...CLINICAL_THRESHOLD_CITATIONS.hemoglobin,
      },
    ];
  }

  return [];
}

function normalizeText(values: Array<string | number | undefined>): string {
  return values
    .filter((value): value is string | number => value !== undefined)
    .map((value) => String(value))
    .join(" ")
    .toLowerCase();
}

function parseNumericValue(value: string | number | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function dedupeSignals(signals: SeveritySignal[]): SeveritySignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    if (seen.has(signal.id)) {
      return false;
    }
    seen.add(signal.id);
    return true;
  });
}
