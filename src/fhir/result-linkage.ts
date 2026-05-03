export type ResultContext = {
  resultReference: string;
  resultId: string;
  terms: string[];
};

export function buildResultContext(
  resultReference: string,
  result: Record<string, unknown> | null,
): ResultContext {
  return {
    resultReference,
    resultId: resultReference.split("/").at(-1) || resultReference,
    terms: result ? extractResultTerms(result) : [],
  };
}

export function isLinkedToResult(
  resource: Record<string, unknown>,
  resultContext: ResultContext,
): boolean {
  const references = collectReferenceValues(resource);

  if (
    references.some((reference) =>
      referenceMatchesResult(reference, resultContext),
    )
  ) {
    return true;
  }

  const text = JSON.stringify(resource).toLowerCase();
  return resultContext.terms.some((term) => text.includes(term));
}

export function referenceMatchesResult(
  reference: string,
  resultContext: ResultContext,
): boolean {
  const normalizedReference = normalizeReference(reference);
  const normalizedResultReference = normalizeReference(
    resultContext.resultReference,
  );
  const normalizedResultId = normalizeReference(resultContext.resultId);

  return (
    normalizedReference === normalizedResultReference ||
    normalizedReference === normalizedResultId ||
    normalizedReference.endsWith(`/${normalizedResultId}`)
  );
}

export function collectReferenceValues(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectReferenceValues(item));
  }

  const object = value as Record<string, unknown>;
  const references: string[] = [];

  if (typeof object["reference"] === "string") {
    references.push(object["reference"]);
  }

  for (const child of Object.values(object)) {
    references.push(...collectReferenceValues(child));
  }

  return references;
}

export function extractResultTerms(result: Record<string, unknown>): string[] {
  const terms = new Set<string>();
  const code = result["code"] as
    | {
        text?: string;
        coding?: Array<{ code?: string; display?: string }>;
      }
    | undefined;

  addTerm(terms, code?.text);

  for (const coding of code?.coding || []) {
    addTerm(terms, coding.display);
    addTerm(terms, coding.code);
  }

  if (typeof result["conclusion"] === "string") {
    for (const token of result["conclusion"].split(/[^a-zA-Z0-9.-]+/)) {
      addTerm(terms, token);
    }
  }

  return Array.from(terms).filter((term) => term.length >= 3);
}

function normalizeReference(reference: string): string {
  const withoutUrn = reference.replace(/^urn:uuid:/, "");
  const withoutBaseUrl = withoutUrn.replace(/^https?:\/\/[^/]+\//, "");
  return withoutBaseUrl.toLowerCase();
}

function addTerm(terms: Set<string>, value: string | undefined): void {
  const normalized = value?.toLowerCase().trim();
  if (!normalized) {
    return;
  }

  terms.add(normalized);

  for (const token of normalized.split(/[^a-zA-Z0-9.-]+/)) {
    if (token.length >= 3) {
      terms.add(token);
    }
  }
}
