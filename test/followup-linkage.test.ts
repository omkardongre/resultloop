import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  buildResultContext,
  collectReferenceValues,
  isLinkedToResult,
  referenceMatchesResult,
} from "../src/fhir/result-linkage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "..", "src", "fixtures", "patients");

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), "utf-8"));
}

type BundleEntry = {
  fullUrl: string;
  resource: Record<string, unknown>;
};

function getEntries(bundle: Record<string, unknown>): BundleEntry[] {
  return bundle["entry"] as BundleEntry[];
}

describe("result follow-up linkage", () => {
  it("matches direct resource references and urn uuid references", () => {
    const resultContext = buildResultContext("Observation/abc-123", null);

    expect(referenceMatchesResult("Observation/abc-123", resultContext)).toBe(
      true,
    );
    expect(referenceMatchesResult("urn:uuid:abc-123", resultContext)).toBe(
      true,
    );
    expect(
      referenceMatchesResult("https://example.test/fhir/Observation/abc-123", resultContext),
    ).toBe(true);
    expect(referenceMatchesResult("Observation/other", resultContext)).toBe(
      false,
    );
  });

  it("collects nested reference values from FHIR resources", () => {
    const resource = {
      reasonReference: [{ reference: "Observation/result-1" }],
      supportingInfo: [{ reference: "DiagnosticReport/report-1" }],
      nested: { focus: { reference: "Task/task-1" } },
    };

    expect(collectReferenceValues(resource)).toEqual([
      "Observation/result-1",
      "DiagnosticReport/report-1",
      "Task/task-1",
    ]);
  });

  it("links Priya hematology referral to hemoglobin but not WBC", () => {
    const bundle = loadFixture("priya-patel");
    const entries = getEntries(bundle);
    const serviceRequest = entries.find(
      (entry) => entry.resource["resourceType"] === "ServiceRequest",
    )!.resource;
    const hemoglobinEntry = entries.find(
      (entry) =>
        entry.resource["resourceType"] === "Observation" &&
        JSON.stringify(entry.resource["code"]).includes("Hemoglobin"),
    )!;
    const wbcEntry = entries.find(
      (entry) =>
        entry.resource["resourceType"] === "Observation" &&
        JSON.stringify(entry.resource["code"]).includes("Leukocytes"),
    )!;

    const hemoglobinContext = buildResultContext(
      `Observation/${hemoglobinEntry.resource["id"]}`,
      hemoglobinEntry.resource,
    );
    const wbcContext = buildResultContext(
      `Observation/${wbcEntry.resource["id"]}`,
      wbcEntry.resource,
    );

    expect(isLinkedToResult(serviceRequest, hemoglobinContext)).toBe(true);
    expect(isLinkedToResult(serviceRequest, wbcContext)).toBe(false);
  });

  it("links Sarah follow-up evidence by result-specific clinical text", () => {
    const bundle = loadFixture("sarah-williams");
    const entries = getEntries(bundle);
    const tsh = entries.find(
      (entry) =>
        entry.resource["resourceType"] === "Observation" &&
        JSON.stringify(entry.resource["code"]).includes("Thyrotropin"),
    )!.resource;
    const task = entries.find(
      (entry) => entry.resource["resourceType"] === "Task",
    )!.resource;
    const communication = entries.find(
      (entry) => entry.resource["resourceType"] === "Communication",
    )!.resource;
    const tshContext = buildResultContext(
      `Observation/${tsh["id"]}`,
      tsh,
    );

    expect(isLinkedToResult(task, tshContext)).toBe(true);
    expect(isLinkedToResult(communication, tshContext)).toBe(true);
  });
});
