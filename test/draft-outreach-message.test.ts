import { describe, it, expect } from "vitest";
import { DraftOutreachMessageToolInstance } from "../src/tools/draft-outreach-message.js";

// We extract the class method for testing template generation
const tool: any = DraftOutreachMessageToolInstance;

describe("DraftOutreachMessageTool", () => {
  const resultDisplay = "Screening Mammogram";
  const resultDate = "2026-03-10";

  it("generates English template by default", () => {
    const output = tool.generateTemplate("en", resultDisplay, resultDate);
    expect(output.subject).toContain("Important update");
    expect(output.body).toContain(resultDisplay);
    expect(output.body).toContain(resultDate);
    expect(output.body).toContain("online patient portal");
    expect(output.readingLevel).toBe("6th Grade");
  });

  it("generates Spanish template", () => {
    const output = tool.generateTemplate("es", resultDisplay, resultDate);
    expect(output.subject).toContain("Aviso importante");
    expect(output.body).toContain(resultDisplay);
    expect(output.body).toContain(resultDate);
    expect(output.body).toContain("portal de pacientes");
    expect(output.readingLevel).toBe("6th Grade (Spanish)");
  });

  it("generates Hindi template", () => {
    const output = tool.generateTemplate("hi", resultDisplay, resultDate);
    expect(output.subject).toContain("महत्वपूर्ण सूचना");
    expect(output.body).toContain(resultDisplay);
    expect(output.body).toContain(resultDate);
    expect(output.body).toContain("पेशेंट पोर्टल");
    expect(output.readingLevel).toBe("6th Grade (Hindi)");
  });
  
  it("defaults to English for unknown language", () => {
    const output = tool.generateTemplate("fr", resultDisplay, resultDate);
    expect(output.subject).toContain("Important update");
    expect(output.readingLevel).toBe("6th Grade");
  });
});
