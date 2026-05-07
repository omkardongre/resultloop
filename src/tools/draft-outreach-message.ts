import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { z } from "zod";
import { IMcpTool } from "./IMcpTool.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { logger } from "../util/logger.js";
import { FhirUtilities } from "../fhir/fhir-utilities.js";

/**
 * Tool 6: draft_outreach_message
 * 
 * Drafts a patient-friendly outreach message based on an open-loop abnormal result.
 * Supports multiple languages (English, Spanish, Hindi) for health equity.
 * Incorporates Cures Act awareness (acknowledging the patient may have seen the result on the portal).
 * Explicitly frames the output as a draft requiring clinician review.
 * 
 * In a fully licensed production environment, this would call an LLM (e.g. OpenAI/Anthropic) 
 * to personalize the message based on the patient's full clinical context. 
 * For this implementation, it uses a robust DRY_RUN deterministic template fallback.
 */
class DraftOutreachMessageTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "draft_outreach_message",
      {
        description:
          "Drafts a personalized, health-literate patient outreach message regarding an abnormal result that needs follow-up. " +
          "Supports English ('en'), Spanish ('es'), and Hindi ('hi') to improve health equity. " +
          "Automatically includes Cures Act framing (acknowledging the patient may have seen the result online). " +
          "IMPORTANT: Returns a DRAFT that must be reviewed by a clinician before sending.",
        inputSchema: {
          patientId: z
            .string()
            .describe(
              "The patient ID. Optional; Prompt Opinion patient context is authoritative when available.",
            )
            .optional(),
          closureArtifactJson: z
            .string()
            .describe(
              "JSON string returned by generate_result_closure_summary containing the abnormal result details.",
            ),
          preferredLanguage: z
            .enum(["en", "es", "hi"])
            .describe(
              "The target language for the outreach message (en = English, es = Spanish, hi = Hindi).",
            ),
        },
      },
      async ({ patientId, closureArtifactJson, preferredLanguage }) => {
        try {
          // Verify patient context securely
          patientId = FhirUtilities.getPatientIdOrThrow(req, patientId);

          logger.info(
            { patientId, preferredLanguage },
            "Drafting patient outreach message",
          );

          // Parse the closure artifact
          let artifact: any;
          try {
            artifact = JSON.parse(closureArtifactJson);
          } catch (err) {
            throw new Error("closureArtifactJson must be a valid JSON string");
          }

          const abnormalResult = artifact.abnormalResult || {};
          const resultDisplay = abnormalResult.display || "recent test result";
          const resultDate = abnormalResult.date || "recently";

          // Generate the drafted message based on language
          const messageDraft = this.generateTemplate(
            preferredLanguage,
            resultDisplay,
            resultDate
          );

          const response = {
            draftMessage: messageDraft.body,
            subject: messageDraft.subject,
            language: preferredLanguage,
            readingLevel: messageDraft.readingLevel,
            curesActAware: true,
            safetyDisclaimer: "DRAFT ONLY: This message is AI-generated for clinician or care coordinator review. It must not be sent to the patient automatically. A human must verify the clinical appropriateness before transmission.",
            nextSteps: [
              "Review the draft message for clinical accuracy",
              "Insert specific clinic contact information where indicated",
              "Send to patient via secure portal, SMS, or letter"
            ]
          };

          return McpUtilities.createJsonResponse(response);
        } catch (error) {
          logger.error({ error }, "Failed to draft outreach message");
          return McpUtilities.createTextResponse(
            `Error drafting outreach message: ${error instanceof Error ? error.message : "Unknown error"}`,
            { isError: true },
          );
        }
      },
    );
  }

  private generateTemplate(lang: string, resultDisplay: string, resultDate: string) {
    // Note: In a production LLM mode, this would be a prompt sent to an LLM.
    // For this implementation, we use the DRY_RUN deterministic fallback pattern.
    
    switch (lang) {
      case "es":
        return {
          subject: "Aviso importante sobre sus resultados médicos recientes",
          body: `Estimado/a paciente,\n\nNos comunicamos con usted sobre los resultados de su reciente prueba de ${resultDisplay} del ${resultDate}. Sabemos que es posible que ya haya visto estos resultados a través de su portal de pacientes en línea.\n\nSu equipo de atención médica ha revisado los resultados y desea programar una cita de seguimiento para conversarlos y planificar los próximos pasos de su atención.\n\nPor favor, llame a nuestra clínica lo antes posible al [CLINIC_PHONE_NUMBER] para programar esta cita. Su salud es nuestra prioridad.\n\nAtentamente,\nEl equipo de atención de [CLINIC_NAME]`,
          readingLevel: "6th Grade (Spanish)"
        };
      
      case "hi":
        return {
          subject: "आपके हालिया मेडिकल परिणामों के बारे में महत्वपूर्ण सूचना",
          body: `प्रिय मरीज,\n\nहम ${resultDate} के आपके हालिया ${resultDisplay} के परीक्षण परिणामों के संबंध में आपसे संपर्क कर रहे हैं। हम जानते हैं कि आपने इन परिणामों को पहले ही अपने ऑनलाइन पेशेंट पोर्टल पर देख लिया होगा।\n\nआपकी देखभाल टीम ने परिणामों की समीक्षा की है और उन पर चर्चा करने तथा आपकी देखभाल में अगले कदमों की योजना बनाने के लिए एक फॉलो-अप अपॉइंटमेंट (भेंट) तय करना चाहती है।\n\nकृपया इस अपॉइंटमेंट को तय करने के लिए जल्द से जल्द हमारे क्लीनिक में [CLINIC_PHONE_NUMBER] पर कॉल करें। आपका स्वास्थ्य हमारी प्राथमिकता है।\n\nभवदीय,\n[CLINIC_NAME] केयर टीम`,
          readingLevel: "6th Grade (Hindi)"
        };

      case "en":
      default:
        return {
          subject: "Important update regarding your recent medical results",
          body: `Dear Patient,\n\nWe are following up regarding your recent test results for ${resultDisplay} from ${resultDate}. We know you may have already seen these results through your online patient portal.\n\nYour care team has reviewed the results and would like to schedule a follow-up appointment to discuss them and plan the next steps in your care.\n\nPlease call our office at your earliest convenience at [CLINIC_PHONE_NUMBER] to schedule this appointment. Your health is our priority.\n\nSincerely,\nThe Care Team at [CLINIC_NAME]`,
          readingLevel: "6th Grade"
        };
    }
  }
}

export const DraftOutreachMessageToolInstance = new DraftOutreachMessageTool();
