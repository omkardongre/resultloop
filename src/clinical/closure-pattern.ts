import { SeverityLevel } from "./thresholds.js";

/**
 * F4 Longitudinal Loop Memory — pure deterministic closure-failure pattern detection.
 *
 * Unlike value-trend detection (e.g., ClinicalMem eGFR 60 → 30), this module answers
 * a different question: across a patient's history window, how many abnormal results
 * of the SAME TYPE went unfollowed? It surfaces systemic closure-failure patterns
 * such as "3 abnormal mammograms in 24 months, only 1 has documented follow-up."
 *
 * Inputs are FHIR-derived records produced by the tool layer. The function performs
 * no I/O and contains no LLM calls. All severity decisions are source-cited and
 * deterministic so they can be defended in clinical review.
 */

export type ClosureStatus =
  | "OPEN_LOOP"
  | "CLOSED"
  | "NOT_YET_OVERDUE"
  | "INSUFFICIENT_EVIDENCE";

export type PatternSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface LoopHistoryRecord {
  reference: string;
  resultType: string;
  date: string;
  closureStatus: ClosureStatus;
  severityLevel?: SeverityLevel;
}

export interface RepeatedTypeStat {
  resultType: string;
  totalCount: number;
  closedCount: number;
  openLoopCount: number;
  closureRate: number;
  references: string[];
  worstSeverity?: SeverityLevel;
  earliestDate?: string;
  latestDate?: string;
}

export interface LoopHistorySummary {
  windowMonths: number;
  totalAbnormalInPeriod: number;
  totalClosed: number;
  totalUnfollowed: number;
  overallClosureRate: number;
  repeatedTypes: RepeatedTypeStat[];
  patternSeverity: PatternSeverity;
  patternFlags: string[];
  demoLine?: string;
  rationale: string[];
}

const SEVERITY_RANK: Record<SeverityLevel, number> = {
  LOW: 1,
  MODERATE: 2,
  HIGH: 3,
  CRITICAL: 4,
};

/**
 * Summarize closure-failure patterns across a list of historical abnormal results.
 * Deterministic. No LLM. No external calls.
 */
export function summarizeLoopHistory(
  records: LoopHistoryRecord[],
  windowMonths: number,
): LoopHistorySummary {
  const totalAbnormalInPeriod = records.length;
  const totalClosed = records.filter((r) => r.closureStatus === "CLOSED").length;
  const totalUnfollowed = records.filter(
    (r) => r.closureStatus === "OPEN_LOOP",
  ).length;
  const overallClosureRate =
    totalAbnormalInPeriod === 0 ? 1 : totalClosed / totalAbnormalInPeriod;

  const grouped = groupByResultType(records);
  const repeatedTypes = buildRepeatedTypeStats(grouped);

  const patternFlags = buildPatternFlags(repeatedTypes, overallClosureRate);
  const patternSeverity = classifyPatternSeverity(repeatedTypes, overallClosureRate);
  const demoLine = buildDemoLine(repeatedTypes, patternSeverity, windowMonths);
  const rationale = buildRationale(
    totalAbnormalInPeriod,
    totalClosed,
    totalUnfollowed,
    overallClosureRate,
    repeatedTypes,
    patternSeverity,
    patternFlags,
  );

  return {
    windowMonths,
    totalAbnormalInPeriod,
    totalClosed,
    totalUnfollowed,
    overallClosureRate,
    repeatedTypes,
    patternSeverity,
    patternFlags,
    demoLine,
    rationale,
  };
}

function groupByResultType(
  records: LoopHistoryRecord[],
): Map<string, LoopHistoryRecord[]> {
  const grouped = new Map<string, LoopHistoryRecord[]>();
  for (const record of records) {
    const key = normalizeResultType(record.resultType);
    if (!key) continue;
    const existing = grouped.get(key) ?? [];
    existing.push(record);
    grouped.set(key, existing);
  }
  return grouped;
}

function normalizeResultType(raw: string | undefined): string {
  if (!raw) return "";
  return raw.trim().toLowerCase();
}

function buildRepeatedTypeStats(
  grouped: Map<string, LoopHistoryRecord[]>,
): RepeatedTypeStat[] {
  const stats: RepeatedTypeStat[] = [];
  for (const [, items] of grouped) {
    if (items.length < 2) continue;

    const totalCount = items.length;
    const closedCount = items.filter((r) => r.closureStatus === "CLOSED").length;
    const openLoopCount = items.filter(
      (r) => r.closureStatus === "OPEN_LOOP",
    ).length;
    const references = items.map((r) => r.reference);
    const worstSeverity = pickWorstSeverity(items);
    const sortedDates = items
      .map((r) => r.date)
      .filter((d): d is string => typeof d === "string" && d.length > 0)
      .sort();

    stats.push({
      resultType: prettifyResultType(items[0].resultType),
      totalCount,
      closedCount,
      openLoopCount,
      closureRate: totalCount === 0 ? 1 : closedCount / totalCount,
      references,
      worstSeverity,
      earliestDate: sortedDates[0],
      latestDate: sortedDates[sortedDates.length - 1],
    });
  }

  stats.sort((a, b) => {
    const sevA = a.worstSeverity ? SEVERITY_RANK[a.worstSeverity] : 0;
    const sevB = b.worstSeverity ? SEVERITY_RANK[b.worstSeverity] : 0;
    if (sevA !== sevB) return sevB - sevA;
    if (a.openLoopCount !== b.openLoopCount) return b.openLoopCount - a.openLoopCount;
    return b.totalCount - a.totalCount;
  });

  return stats;
}

function prettifyResultType(raw: string): string {
  return raw.trim();
}

function pickWorstSeverity(
  items: LoopHistoryRecord[],
): SeverityLevel | undefined {
  let worst: SeverityLevel | undefined;
  for (const item of items) {
    if (!item.severityLevel) continue;
    if (!worst || SEVERITY_RANK[item.severityLevel] > SEVERITY_RANK[worst]) {
      worst = item.severityLevel;
    }
  }
  return worst;
}

function buildPatternFlags(
  repeatedTypes: RepeatedTypeStat[],
  overallClosureRate: number,
): string[] {
  const flags: string[] = [];

  const anyRepeatFailure = repeatedTypes.some((t) => t.openLoopCount >= 1);
  if (anyRepeatFailure) flags.push("repeat-failure");

  if (overallClosureRate < 0.5) flags.push("low-closure-rate");

  const criticalRecurrence = repeatedTypes.some(
    (t) => t.totalCount >= 3 && t.openLoopCount >= 2,
  );
  if (criticalRecurrence) flags.push("critical-recurrence");

  const highSeverityRepeat = repeatedTypes.some(
    (t) =>
      t.openLoopCount >= 1 &&
      t.worstSeverity &&
      SEVERITY_RANK[t.worstSeverity] >= SEVERITY_RANK.HIGH,
  );
  if (highSeverityRepeat) flags.push("high-severity-repeat");

  return flags;
}

function classifyPatternSeverity(
  repeatedTypes: RepeatedTypeStat[],
  overallClosureRate: number,
): PatternSeverity {
  const criticalRecurrence = repeatedTypes.some(
    (t) =>
      t.totalCount >= 3 &&
      t.openLoopCount >= 2 &&
      t.worstSeverity &&
      SEVERITY_RANK[t.worstSeverity] >= SEVERITY_RANK.HIGH,
  );
  if (criticalRecurrence) return "CRITICAL";

  const highRepeat = repeatedTypes.some(
    (t) =>
      t.totalCount >= 2 &&
      t.openLoopCount >= 1 &&
      t.worstSeverity &&
      SEVERITY_RANK[t.worstSeverity] >= SEVERITY_RANK.HIGH,
  );
  if (highRepeat) return "HIGH";

  const anyRepeatFailure = repeatedTypes.some(
    (t) => t.totalCount >= 2 && t.openLoopCount >= 1,
  );
  if (anyRepeatFailure || overallClosureRate < 0.5) return "MEDIUM";

  return "LOW";
}

function buildDemoLine(
  repeatedTypes: RepeatedTypeStat[],
  patternSeverity: PatternSeverity,
  windowMonths: number,
): string | undefined {
  if (patternSeverity === "LOW") return undefined;

  const focus = repeatedTypes.find(
    (t) =>
      t.openLoopCount >= 1 &&
      (!t.worstSeverity ||
        SEVERITY_RANK[t.worstSeverity] >= SEVERITY_RANK.MODERATE),
  );
  if (!focus) return undefined;

  const wasOrWere = focus.closedCount === 1 ? "has" : "have";
  const followUp =
    focus.closedCount === 0
      ? "none have documented follow-up"
      : `only ${focus.closedCount} ${wasOrWere} documented follow-up`;

  return `This patient has had ${focus.totalCount} abnormal ${focus.resultType} result${
    focus.totalCount === 1 ? "" : "s"
  } in the past ${windowMonths} months — ${followUp}.`;
}

function buildRationale(
  totalAbnormalInPeriod: number,
  totalClosed: number,
  totalUnfollowed: number,
  overallClosureRate: number,
  repeatedTypes: RepeatedTypeStat[],
  patternSeverity: PatternSeverity,
  patternFlags: string[],
): string[] {
  const rationale: string[] = [];

  rationale.push(
    `Pattern severity: ${patternSeverity} based on ${totalAbnormalInPeriod} abnormal result(s) in window, ${totalClosed} closed and ${totalUnfollowed} open-loop.`,
  );

  rationale.push(
    `Overall closure rate: ${(overallClosureRate * 100).toFixed(0)}% (${totalClosed}/${totalAbnormalInPeriod}).`,
  );

  if (repeatedTypes.length === 0) {
    rationale.push("No abnormal result type was repeated within the window.");
  } else {
    for (const stat of repeatedTypes) {
      rationale.push(
        `${stat.resultType}: ${stat.totalCount} abnormal in window, ${stat.openLoopCount} unfollowed (${(
          stat.closureRate * 100
        ).toFixed(0)}% closure rate)${
          stat.worstSeverity ? `, worst severity ${stat.worstSeverity}` : ""
        }.`,
      );
    }
  }

  if (patternFlags.length > 0) {
    rationale.push(`Pattern flags: ${patternFlags.join(", ")}.`);
  }

  return rationale;
}
