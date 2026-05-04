import {
  AbnormalResultLike,
  SeverityLevel,
  SeveritySignal,
  classifyResultSeverity,
} from "./thresholds.js";

export type OpenLoopCandidate = AbnormalResultLike & {
  reference: string;
  date: string;
  closureStatus?: "OPEN_LOOP" | "CLOSED" | "NOT_YET_OVERDUE" | "INSUFFICIENT_EVIDENCE";
  daysSinceResult?: number;
  totalFollowUpEvidenceFound?: number;
};

export type RankedOpenLoop = OpenLoopCandidate & {
  rank: number;
  severityLevel: SeverityLevel;
  severityScore: number;
  timelinessScore: number;
  totalPriorityScore: number;
  recommendedQueue: "immediate_review" | "urgent_review" | "routine_review" | "monitor";
  severitySignals: SeveritySignal[];
  rankingRationale: string[];
};

const SEVERITY_SCORE: Record<SeverityLevel, number> = {
  LOW: 10,
  MODERATE: 30,
  HIGH: 60,
  CRITICAL: 90,
};

export function rankOpenLoopsBySeverity(
  candidates: OpenLoopCandidate[],
  asOfDate = new Date(),
): RankedOpenLoop[] {
  return candidates
    .filter((candidate) => candidate.closureStatus !== "CLOSED")
    .map((candidate) => scoreCandidate(candidate, asOfDate))
    .sort((a, b) => {
      if (b.totalPriorityScore !== a.totalPriorityScore) {
        return b.totalPriorityScore - a.totalPriorityScore;
      }
      return b.daysSinceResultSafe - a.daysSinceResultSafe;
    })
    .map(({ daysSinceResultSafe: _daysSinceResultSafe, ...candidate }, index) => ({
      ...candidate,
      rank: index + 1,
    }));
}

function scoreCandidate(
  candidate: OpenLoopCandidate,
  asOfDate: Date,
): Omit<RankedOpenLoop, "rank"> & { daysSinceResultSafe: number } {
  const severity = classifyResultSeverity(candidate);
  const daysSinceResultSafe = getDaysSinceResult(candidate, asOfDate);
  const severityScore = SEVERITY_SCORE[severity.level];
  const timelinessScore = calculateTimelinessScore(daysSinceResultSafe);
  const totalPriorityScore = severityScore + timelinessScore;

  return {
    ...candidate,
    daysSinceResult: daysSinceResultSafe,
    severityLevel: severity.level,
    severityScore,
    timelinessScore,
    totalPriorityScore,
    recommendedQueue: determineQueue(severity.level, totalPriorityScore),
    severitySignals: severity.signals,
    rankingRationale: buildRankingRationale(
      candidate,
      severity.level,
      severity.signals,
      daysSinceResultSafe,
      severityScore,
      timelinessScore,
    ),
    daysSinceResultSafe,
  };
}

function getDaysSinceResult(candidate: OpenLoopCandidate, asOfDate: Date): number {
  if (typeof candidate.daysSinceResult === "number" && candidate.daysSinceResult >= 0) {
    return Math.floor(candidate.daysSinceResult);
  }

  const resultTime = new Date(candidate.date).getTime();
  if (!Number.isFinite(resultTime)) {
    return 0;
  }

  return Math.max(
    0,
    Math.floor((asOfDate.getTime() - resultTime) / (1000 * 60 * 60 * 24)),
  );
}

function calculateTimelinessScore(daysSinceResult: number): number {
  if (daysSinceResult >= 45) return 30;
  if (daysSinceResult >= 30) return 20;
  if (daysSinceResult >= 14) return 10;
  return 0;
}

function determineQueue(
  severityLevel: SeverityLevel,
  totalPriorityScore: number,
): RankedOpenLoop["recommendedQueue"] {
  if (severityLevel === "CRITICAL" || totalPriorityScore >= 100) {
    return "immediate_review";
  }

  if (severityLevel === "HIGH" || totalPriorityScore >= 70) {
    return "urgent_review";
  }

  if (severityLevel === "MODERATE" || totalPriorityScore >= 40) {
    return "routine_review";
  }

  return "monitor";
}

function buildRankingRationale(
  candidate: OpenLoopCandidate,
  severityLevel: SeverityLevel,
  severitySignals: SeveritySignal[],
  daysSinceResult: number,
  severityScore: number,
  timelinessScore: number,
): string[] {
  const rationale = [
    `${candidate.reference} ranked as ${severityLevel} severity (${severityScore} severity points).`,
    `${daysSinceResult} days since result (${timelinessScore} timeliness points).`,
  ];

  if (candidate.closureStatus === "OPEN_LOOP") {
    rationale.push("No documented follow-up closure evidence was provided for this ranking input.");
  }

  if (severitySignals.length === 0) {
    rationale.push("No source-cited specialty threshold matched; ranking uses timeliness and generic abnormal-result status only.");
  } else {
    for (const signal of severitySignals) {
      rationale.push(`${signal.label}: ${signal.rationale}`);
    }
  }

  return rationale;
}
