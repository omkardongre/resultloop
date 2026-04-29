import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "..", "src", "fixtures", "patients");

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), "utf-8"));
}

describe("fixture validity", () => {
  const patients = [
    "maria-lopez",
    "james-chen",
    "sarah-williams",
    "robert-johnson",
    "priya-patel",
  ];

  it("loads all 5 patient bundles", () => {
    for (const name of patients) {
      const bundle = loadFixture(name);
      expect(bundle["resourceType"]).toBe("Bundle");
      expect(bundle["type"]).toBe("transaction");
      expect(bundle["entry"]).toBeDefined();
    }
  });

  it("each bundle has a Patient resource as first entry", () => {
    for (const name of patients) {
      const bundle = loadFixture(name);
      const entries = bundle["entry"] as Array<{
        resource: { resourceType: string };
      }>;
      expect(entries[0]!.resource.resourceType).toBe("Patient");
    }
  });

  it("every entry has a valid request method", () => {
    for (const name of patients) {
      const bundle = loadFixture(name);
      const entries = bundle["entry"] as Array<{
        request: { method: string; url: string };
      }>;
      for (const entry of entries) {
        expect(["PUT", "POST"]).toContain(entry.request.method);
        expect(entry.request.url).toBeTruthy();
      }
    }
  });

  it("every resource has an id field", () => {
    for (const name of patients) {
      const bundle = loadFixture(name);
      const entries = bundle["entry"] as Array<{
        resource: { id: string; resourceType: string };
      }>;
      for (const entry of entries) {
        expect(entry.resource.id).toBeTruthy();
      }
    }
  });

  it("patient references use correct format", () => {
    for (const name of patients) {
      const bundle = loadFixture(name);
      const entries = bundle["entry"] as Array<{
        resource: Record<string, unknown>;
      }>;
      const patientId = (entries[0]!.resource as { id: string }).id;
      for (let i = 1; i < entries.length; i++) {
        const resource = entries[i]!.resource;
        const subject = resource["subject"] as { reference?: string } | undefined;
        const forRef = resource["for"] as { reference?: string } | undefined;
        if (subject?.reference) {
          expect(subject.reference).toBe(`Patient/${patientId}`);
        }
        if (forRef?.reference) {
          expect(forRef.reference).toBe(`Patient/${patientId}`);
        }
      }
    }
  });
});

describe("maria-lopez fixture (OPEN LOOP)", () => {
  let bundle: Record<string, unknown>;

  beforeAll(() => {
    bundle = loadFixture("maria-lopez");
  });

  it("has Patient, DiagnosticReport, and Observation", () => {
    const entries = bundle["entry"] as Array<{
      resource: { resourceType: string };
    }>;
    const types = entries.map((e) => e.resource.resourceType);
    expect(types).toContain("Patient");
    expect(types).toContain("DiagnosticReport");
    expect(types).toContain("Observation");
  });

  it("mammogram conclusion contains suspicious keywords", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const dr = entries.find(
      (e) => e.resource["resourceType"] === "DiagnosticReport",
    );
    expect(dr).toBeDefined();
    const conclusion = (dr!.resource["conclusion"] as string).toLowerCase();
    expect(conclusion).toContain("suspicious");
    expect(conclusion).toContain("bi-rads 4");
  });

  it("CA-125 has High interpretation code", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const obs = entries.find(
      (e) => e.resource["resourceType"] === "Observation",
    );
    expect(obs).toBeDefined();
    const interpretation = obs!.resource["interpretation"] as Array<{
      coding: Array<{ code: string }>;
    }>;
    expect(interpretation[0]!.coding[0]!.code).toBe("H");
  });

  it("CA-125 value exceeds reference range", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const obs = entries.find(
      (e) => e.resource["resourceType"] === "Observation",
    );
    const value = (obs!.resource["valueQuantity"] as { value: number }).value;
    const refHigh = (
      obs!.resource["referenceRange"] as Array<{
        high: { value: number };
      }>
    )[0]!.high.value;
    expect(value).toBeGreaterThan(refHigh);
  });

  it("has NO follow-up resources (ServiceRequest, Task, Communication, CarePlan)", () => {
    const entries = bundle["entry"] as Array<{
      resource: { resourceType: string };
    }>;
    const types = entries.map((e) => e.resource.resourceType);
    expect(types).not.toContain("ServiceRequest");
    expect(types).not.toContain("Task");
    expect(types).not.toContain("Communication");
    expect(types).not.toContain("CarePlan");
  });
});

describe("james-chen fixture (OPEN LOOP)", () => {
  let bundle: Record<string, unknown>;

  beforeAll(() => {
    bundle = loadFixture("james-chen");
  });

  it("PSA has Critical high interpretation", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const obs = entries.find(
      (e) => e.resource["resourceType"] === "Observation",
    );
    const interpretation = obs!.resource["interpretation"] as Array<{
      coding: Array<{ code: string }>;
    }>;
    expect(interpretation[0]!.coding[0]!.code).toBe("HH");
  });

  it("PSA value 12.8 exceeds normal range of 4.0", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const obs = entries.find(
      (e) => e.resource["resourceType"] === "Observation",
    );
    const value = (obs!.resource["valueQuantity"] as { value: number }).value;
    expect(value).toBe(12.8);
    const refHigh = (
      obs!.resource["referenceRange"] as Array<{
        high: { value: number };
      }>
    )[0]!.high.value;
    expect(value).toBeGreaterThan(refHigh);
  });

  it("has NO follow-up resources", () => {
    const entries = bundle["entry"] as Array<{
      resource: { resourceType: string };
    }>;
    const types = entries.map((e) => e.resource.resourceType);
    expect(types).not.toContain("ServiceRequest");
    expect(types).not.toContain("Task");
  });
});

describe("sarah-williams fixture (CLOSED LOOP)", () => {
  let bundle: Record<string, unknown>;

  beforeAll(() => {
    bundle = loadFixture("sarah-williams");
  });

  it("TSH has High interpretation", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const obs = entries.find(
      (e) => e.resource["resourceType"] === "Observation",
    );
    const interpretation = obs!.resource["interpretation"] as Array<{
      coding: Array<{ code: string }>;
    }>;
    expect(interpretation[0]!.coding[0]!.code).toBe("H");
  });

  it("has ServiceRequest for endocrinology referral", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const sr = entries.find(
      (e) => e.resource["resourceType"] === "ServiceRequest",
    );
    expect(sr).toBeDefined();
    expect((sr!.resource["code"] as { text: string }).text).toContain(
      "Endocrinology",
    );
  });

  it("has completed Task for appointment scheduling", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const task = entries.find(
      (e) => e.resource["resourceType"] === "Task",
    );
    expect(task).toBeDefined();
    expect(task!.resource["status"]).toBe("completed");
  });

  it("has Communication for patient notification", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const comm = entries.find(
      (e) => e.resource["resourceType"] === "Communication",
    );
    expect(comm).toBeDefined();
    expect(comm!.resource["status"]).toBe("completed");
  });

  it("ServiceRequest was authored AFTER the abnormal result date", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const obs = entries.find(
      (e) => e.resource["resourceType"] === "Observation",
    );
    const sr = entries.find(
      (e) => e.resource["resourceType"] === "ServiceRequest",
    );
    const resultDate = new Date(obs!.resource["effectiveDateTime"] as string);
    const srDate = new Date(sr!.resource["authoredOn"] as string);
    expect(srDate.getTime()).toBeGreaterThan(resultDate.getTime());
  });
});

describe("robert-johnson fixture (OPEN LOOP)", () => {
  let bundle: Record<string, unknown>;

  beforeAll(() => {
    bundle = loadFixture("robert-johnson");
  });

  it("has CT chest DiagnosticReport with suspicious nodule", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const dr = entries.find(
      (e) => e.resource["resourceType"] === "DiagnosticReport",
    );
    expect(dr).toBeDefined();
    const conclusion = (dr!.resource["conclusion"] as string).toLowerCase();
    expect(conclusion).toContain("nodule");
    expect(conclusion).toContain("suspicious");
  });

  it("has NO follow-up resources", () => {
    const entries = bundle["entry"] as Array<{
      resource: { resourceType: string };
    }>;
    const types = entries.map((e) => e.resource.resourceType);
    expect(types).not.toContain("ServiceRequest");
    expect(types).not.toContain("Task");
    expect(types).not.toContain("CarePlan");
  });
});

describe("priya-patel fixture (MIXED)", () => {
  let bundle: Record<string, unknown>;

  beforeAll(() => {
    bundle = loadFixture("priya-patel");
  });

  it("has two abnormal observations (WBC + Hemoglobin)", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const observations = entries.filter(
      (e) => e.resource["resourceType"] === "Observation",
    );
    expect(observations).toHaveLength(2);
  });

  it("WBC has Critical high interpretation", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const wbc = entries.find(
      (e) =>
        e.resource["resourceType"] === "Observation" &&
        (e.resource["id"] as string).includes("wbc"),
    );
    const interpretation = wbc!.resource["interpretation"] as Array<{
      coding: Array<{ code: string }>;
    }>;
    expect(interpretation[0]!.coding[0]!.code).toBe("HH");
  });

  it("Hemoglobin has Low interpretation", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const hgb = entries.find(
      (e) =>
        e.resource["resourceType"] === "Observation" &&
        (e.resource["id"] as string).includes("hgb"),
    );
    const interpretation = hgb!.resource["interpretation"] as Array<{
      coding: Array<{ code: string }>;
    }>;
    expect(interpretation[0]!.coding[0]!.code).toBe("L");
  });

  it("has ServiceRequest for hematology referral (covers hemoglobin only)", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const sr = entries.find(
      (e) => e.resource["resourceType"] === "ServiceRequest",
    );
    expect(sr).toBeDefined();
    const reasonRef = sr!.resource["reasonReference"] as Array<{
      reference: string;
    }>;
    expect(reasonRef[0]!.reference).toContain("hgb");
  });

  it("has NO follow-up specifically for WBC (open loop for WBC)", () => {
    const entries = bundle["entry"] as Array<{
      resource: Record<string, unknown>;
    }>;
    const sr = entries.find(
      (e) => e.resource["resourceType"] === "ServiceRequest",
    );
    const reasonRef = sr!.resource["reasonReference"] as Array<{
      reference: string;
    }>;
    // ServiceRequest only references hemoglobin, not WBC
    expect(reasonRef[0]!.reference).not.toContain("wbc");
  });
});
