import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load a synthetic patient bundle by filename (without .json extension).
 */
export function loadPatientBundle(name: string): Record<string, unknown> {
  const filePath = join(__dirname, "patients", `${name}.json`);
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * All available synthetic patient fixture names.
 */
export const PATIENT_FIXTURES = [
  "maria-lopez",
  "james-chen",
  "sarah-williams",
  "robert-johnson",
  "priya-patel",
] as const;

export type PatientFixtureName = (typeof PATIENT_FIXTURES)[number];
