export type ClosureClaimVerificationStatus =
  | "PASS"
  | "INSUFFICIENT_EVIDENCE"
  | "CONTRADICTION";

export type VerifyClosureClaimInput = {
  closureArtifact: Record<string, unknown>;
  followUpContext?: Record<string, unknown>;
  fetchedReferences?: string[];
  missingFetchedReferences?: string[];
};

export type VerifyClosureClaimOutput = {
  status: ClosureClaimVerificationStatus;
  verificationSummary: string;
  auditedResult?: string;
  closureStatus?: string;
  verifiedReferences: string[];
  missingReferences: string[];
  contradictions: string[];
  warnings: string[];
  evidenceRules: string[];
  safetyNote: string;
};

const FHIR_REFERENCE_PATTERN =
  /\b(?:Patient|Observation|DiagnosticReport|ServiceRequest|Task|Communication|CarePlan|Encounter|DocumentReference|AuditEvent)\/[A-Za-z0-9\-.]{1,128}\b/g;
const EXACT_FHIR_REFERENCE_PATTERN =
  /^(?:Patient|Observation|DiagnosticReport|ServiceRequest|Task|Communication|CarePlan|Encounter|DocumentReference|AuditEvent)\/[A-Za-z0-9\-.]{1,128}$/;

const FOLLOW_UP_RESOURCE_TYPES = new Set([
  "ServiceRequest",
  "Task",
  "Communication",
  "CarePlan",
  "Encounter",
]);

export function verifyClosureClaim(
  input: VerifyClosureClaimInput,
): VerifyClosureClaimOutput {
  const artifact = input.closureArtifact;
  const followUpContext = input.followUpContext;
  const contradictions: string[] = [];
  const warnings: string[] = [];
  const evidenceRules: string[] = [];

  const closureStatus = getString(artifact, ["closureStatus"]);
  const auditedResult = getString(artifact, ["abnormalResult", "reference"]);
  const matrix = getRecord(artifact, ["closureEvidenceMatrix"]);
  const matrixTotalFound = getNumber(matrix, ["totalFound"]);
  const matrixDetails = getArray(matrix, ["details"]);
  const evidenceReferences = extractEvidenceReferences(matrixDetails);
  const artifactReferences = extractFhirReferences(artifact);
  const followUpReferences = followUpContext
    ? extractFhirReferences(followUpContext)
    : [];
  const citedReferences = unique([
    ...artifactReferences,
    ...followUpReferences,
  ]).filter((reference) => !reference.startsWith("Patient/"));
  const fetchedReferences = new Set(input.fetchedReferences ?? []);
  const missingFetchedReferences = input.missingFetchedReferences ?? [];

  if (!closureStatus) {
    contradictions.push("closureArtifact.closureStatus is missing.");
  }

  if (!auditedResult) {
    contradictions.push("closureArtifact.abnormalResult.reference is missing.");
  }

  if (auditedResult && !citedReferences.includes(auditedResult)) {
    contradictions.push(
      "The audited abnormal result is not present in the cited FHIR references.",
    );
  }

  if (typeof matrixTotalFound !== "number") {
    contradictions.push(
      "closureEvidenceMatrix.totalFound is missing or not numeric.",
    );
  }

  const evidenceReferenceCount = evidenceReferences.length;
  if (
    typeof matrixTotalFound === "number" &&
    matrixTotalFound > 0 &&
    evidenceReferenceCount === 0
  ) {
    contradictions.push(
      "closureEvidenceMatrix.totalFound is greater than zero but no evidence references are cited.",
    );
  }

  if (
    typeof matrixTotalFound === "number" &&
    matrixTotalFound === 0 &&
    evidenceReferenceCount > 0
  ) {
    contradictions.push(
      "closureEvidenceMatrix.totalFound is zero but follow-up evidence references are cited.",
    );
  }

  if (closureStatus === "OPEN_LOOP" && typeof matrixTotalFound === "number") {
    if (matrixTotalFound !== 0 || evidenceReferenceCount > 0) {
      contradictions.push(
        "Artifact claims OPEN_LOOP but follow-up evidence is present.",
      );
    }
  }

  if (closureStatus === "CLOSED" && typeof matrixTotalFound === "number") {
    if (matrixTotalFound <= 0 || evidenceReferenceCount === 0) {
      contradictions.push(
        "Artifact claims CLOSED but no follow-up evidence references are present.",
      );
    }
  }

  const contextStatus = getString(followUpContext, ["closureStatus"]);
  if (contextStatus && closureStatus && contextStatus !== closureStatus) {
    contradictions.push(
      `Closure artifact status ${closureStatus} conflicts with follow-up context status ${contextStatus}.`,
    );
  }

  const contextTotalFound = getNumber(followUpContext, [
    "totalFollowUpEvidenceFound",
  ]);
  if (
    typeof contextTotalFound === "number" &&
    typeof matrixTotalFound === "number" &&
    contextTotalFound !== matrixTotalFound
  ) {
    contradictions.push(
      `Closure artifact totalFound ${matrixTotalFound} conflicts with follow-up context totalFollowUpEvidenceFound ${contextTotalFound}.`,
    );
  }

  if (getBoolean(followUpContext, ["shouldAbstain"])) {
    warnings.push(
      "Follow-up context requested abstention because one or more FHIR searches failed.",
    );
  }

  const searchErrors = getArray(followUpContext, ["searchErrors"]);
  if (searchErrors.length > 0) {
    warnings.push("Follow-up context contains FHIR search errors.");
  }

  for (const reference of evidenceReferences) {
    const resourceType = reference.split("/")[0];
    if (!FOLLOW_UP_RESOURCE_TYPES.has(resourceType ?? "")) {
      contradictions.push(
        `Evidence reference ${reference} is not an allowed follow-up resource type.`,
      );
    }
  }

  const missingReferences = unique([
    ...missingFetchedReferences,
    ...(input.fetchedReferences
      ? citedReferences.filter((reference) => !fetchedReferences.has(reference))
      : []),
  ]);

  if (missingReferences.length > 0) {
    warnings.push(
      "One or more cited FHIR references could not be fetched from the FHIR server.",
    );
  }

  evidenceRules.push(
    "Every cited abnormal-result or follow-up FHIR reference must be present in the closure artifact or follow-up context.",
  );
  evidenceRules.push(
    "OPEN_LOOP requires zero linked follow-up evidence references.",
  );
  evidenceRules.push(
    "CLOSED requires at least one linked follow-up evidence reference.",
  );
  evidenceRules.push(
    "FHIR search errors or unfetched references downgrade the verdict to INSUFFICIENT_EVIDENCE.",
  );

  const status = determineStatus(contradictions, warnings, missingReferences);

  return {
    status,
    verificationSummary: buildSummary(status, contradictions, warnings),
    auditedResult,
    closureStatus,
    verifiedReferences: citedReferences.filter(
      (reference) => !missingReferences.includes(reference),
    ),
    missingReferences,
    contradictions,
    warnings,
    evidenceRules,
    safetyNote:
      "This verification checks closure-claim consistency against cited FHIR evidence. It does not determine diagnosis, treatment, or clinical action. Clinician verification is required.",
  };
}

function determineStatus(
  contradictions: string[],
  warnings: string[],
  missingReferences: string[],
): ClosureClaimVerificationStatus {
  if (contradictions.length > 0) {
    return "CONTRADICTION";
  }

  if (warnings.length > 0 || missingReferences.length > 0) {
    return "INSUFFICIENT_EVIDENCE";
  }

  return "PASS";
}

function buildSummary(
  status: ClosureClaimVerificationStatus,
  contradictions: string[],
  warnings: string[],
): string {
  if (status === "PASS") {
    return "Closure claim is internally consistent with the cited FHIR evidence.";
  }

  if (status === "CONTRADICTION") {
    return `Closure claim has ${contradictions.length} contradiction(s) that require review.`;
  }

  return `Closure claim could not be fully verified because ${warnings.length} warning(s) require review.`;
}

function extractEvidenceReferences(details: unknown[]): string[] {
  return unique(
    details.flatMap((detail) => {
      if (!isRecord(detail)) return [];
      const references = detail["references"];
      if (!Array.isArray(references)) return [];
      return references.filter((reference): reference is string =>
        isFhirReference(reference),
      );
    }),
  );
}

export function extractFhirReferences(value: unknown): string[] {
  return unique(extractReferenceCandidates(value).filter(isFhirReference));
}

function extractReferenceCandidates(value: unknown): string[] {
  if (typeof value === "string") {
    return value.match(FHIR_REFERENCE_PATTERN) ?? [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(extractReferenceCandidates);
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap(extractReferenceCandidates);
  }

  return [];
}

function isFhirReference(value: string): boolean {
  return EXACT_FHIR_REFERENCE_PATTERN.test(value);
}

function getRecord(
  value: unknown,
  path: string[],
): Record<string, unknown> | undefined {
  const result = getPath(value, path);
  return isRecord(result) ? result : undefined;
}

function getString(value: unknown, path: string[]): string | undefined {
  const result = getPath(value, path);
  return typeof result === "string" ? result : undefined;
}

function getNumber(value: unknown, path: string[]): number | undefined {
  const result = getPath(value, path);
  return typeof result === "number" && Number.isFinite(result)
    ? result
    : undefined;
}

function getBoolean(value: unknown, path: string[]): boolean | undefined {
  const result = getPath(value, path);
  return typeof result === "boolean" ? result : undefined;
}

function getArray(value: unknown, path: string[]): unknown[] {
  const result = getPath(value, path);
  return Array.isArray(result) ? result : [];
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
