/**
 * ResultLoop — send_sms_outreach tool (T14)
 *
 * Sends a clinician-approved patient outreach SMS via Twilio Programmable Messaging.
 *
 * External API: Twilio Messages REST API (v2010-04-01)
 * Docs:         https://www.twilio.com/docs/sms/api/message-resource
 * Auth:         HTTP Basic (TWILIO_ACCOUNT_SID : TWILIO_AUTH_TOKEN)
 * Rate limits:  1 SMS/sec on free trial; production limits per account tier
 *
 * Safety gates:
 *  - clinicianApprovalConfirmed must be true in the SAME conversation turn
 *  - Phone number must be in E.164 format (+1xxxxxxxxxx)
 *  - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER must be set
 *  - Graceful degradation: isError response on Twilio failure, never breaks session
 *
 * No FHIR reads or writes performed by this tool.
 * No patient data stored — Twilio receives only the phone number and message body.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";
import { z } from "zod";
import { IMcpTool } from "../tools/IMcpTool.js";
import { McpUtilities } from "../util/mcp-utilities.js";
import { logger } from "../util/logger.js";
import { config } from "../config.js";

// ─── Twilio API types ─────────────────────────────────────────────────────────

interface TwilioMessageResponse {
  sid: string;
  status: string;
  to: string;
  from: string;
  body: string;
  date_created: string;
  error_code: number | null;
  error_message: string | null;
}

interface TwilioErrorResponse {
  code: number;
  message: string;
  more_info: string;
  status: number;
}

// ─── E.164 phone number validation ───────────────────────────────────────────

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone);
}

// ─── Twilio send implementation ───────────────────────────────────────────────

/**
 * Send an SMS via Twilio Programmable Messaging REST API.
 * Uses native fetch (Node 20+) with HTTP Basic auth — no SDK dependency.
 * Follows Twilio best practices: HTTPS only, 10s timeout, error code surfaced.
 */
async function sendTwilioSms(
  to: string,
  body: string,
): Promise<TwilioMessageResponse> {
  const { twilioAccountSid, twilioAuthToken, twilioFromNumber } = config;

  if (!twilioAccountSid || !twilioAuthToken || !twilioFromNumber) {
    throw new Error(
      "Twilio credentials not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, " +
        "and TWILIO_FROM_NUMBER environment variables.",
    );
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;

  // Twilio requires application/x-www-form-urlencoded body
  const params = new URLSearchParams();
  params.set("To", to);
  params.set("From", twilioFromNumber);
  params.set("Body", body);

  // Basic auth: base64(accountSid:authToken)
  const credentials = Buffer.from(
    `${twilioAccountSid}:${twilioAuthToken}`,
  ).toString("base64");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "ResultLoop-MCP/1.0",
      Accept: "application/json",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  const data = (await response.json()) as
    | TwilioMessageResponse
    | TwilioErrorResponse;

  if (!response.ok) {
    const err = data as TwilioErrorResponse;
    throw new Error(
      `Twilio API error ${response.status}: ${err.message} (code ${err.code}). ` +
        `See: ${err.more_info}`,
    );
  }

  return data as TwilioMessageResponse;
}

// ─── Tool class ───────────────────────────────────────────────────────────────

class SendSmsOutreachTool implements IMcpTool {
  registerTool(server: McpServer, _req: Request): void {
    server.registerTool(
      "send_sms_outreach",
      {
        description:
          "Sends a clinician-approved patient outreach SMS via Twilio Programmable Messaging. " +
          "Use this tool when the clinician explicitly approves sending the drafted outreach message " +
          "to the patient's phone number. " +
          "ALWAYS call draft_outreach_message first to get the message text. " +
          "ALWAYS show the drafted message and phone number to the clinician and wait for explicit approval before calling this tool. " +
          "This tool will NOT send any SMS unless clinicianApprovalConfirmed is true in this same conversation turn. " +
          "Does NOT perform FHIR reads or writes. " +
          "Phone number must be in E.164 format (e.g. +15551234567). " +
          "If the patient phone is unknown, ask the clinician to provide it — do NOT guess or fabricate.",
        inputSchema: {
          toPhoneNumber: z
            .string()
            .describe(
              "Patient phone number in E.164 format (e.g. +15551234567 or +919876543210). " +
                "Ask the clinician if unknown. Read from patient FHIR telecom if available. " +
                "Never guess or fabricate.",
            ),
          messageText: z
            .string()
            .min(10)
            .max(1600)
            .describe(
              "The outreach message body to send. " +
                "Pass ONLY the core message body from draft_outreach_message — do NOT include the Subject line, " +
                "greeting headers, or safety disclaimer. The body is the paragraph starting with the patient salutation " +
                "(e.g. 'Estimado/a paciente,...' or 'Dear patient,...'). " +
                "Keep it concise — SMS has a 320 character limit. Long messages will be truncated.",
            ),
          preferredLanguage: z
            .enum(["en", "es", "hi"])
            .describe(
              "Language of the message: 'en' (English), 'es' (Spanish), 'hi' (Hindi). " +
                "Used for audit logging only — does not affect transmission.",
            ),
          patientName: z
            .string()
            .optional()
            .describe("Patient display name for audit log. Optional."),
          resultReference: z
            .string()
            .optional()
            .describe(
              "FHIR reference of the abnormal result this outreach relates to " +
                "(e.g. 'DiagnosticReport/cb94f0b2'). Used for audit logging only.",
            ),
          clinicianApprovalConfirmed: z
            .boolean()
            .describe(
              "MUST be true in this same conversation turn. " +
                "Set to true ONLY when the clinician has explicitly said something like " +
                "'yes send it', 'confirm and send', 'go ahead and send'. " +
                "NEVER set to true based on approval from a previous message — each SMS send " +
                "requires its own explicit same-turn approval. " +
                "If false or absent, do not send — explain that explicit approval is required.",
            ),
        },
      },
      async ({
        toPhoneNumber,
        messageText,
        preferredLanguage,
        patientName,
        resultReference,
        clinicianApprovalConfirmed,
      }) => {
        // ── Safety gate: explicit clinician approval required ──────────────
        if (!clinicianApprovalConfirmed) {
          logger.warn(
            { toPhoneNumber, preferredLanguage },
            "send_sms_outreach: blocked — clinicianApprovalConfirmed is false",
          );
          return McpUtilities.createJsonResponse({
            status: "not_sent",
            errorCode: "CLINICIAN_APPROVAL_NOT_CONFIRMED",
            fhirWritesPerformed: false,
            smsDelivered: false,
            safetyNote:
              "SMS was NOT sent. Explicit clinician approval is required in the same conversation turn. " +
              "Please confirm you approve sending this message (e.g. 'yes send it', 'confirm and send').",
          });
        }

        // ── E.164 phone number validation ──────────────────────────────────
        if (!isValidE164(toPhoneNumber)) {
          logger.warn(
            { toPhoneNumber },
            "send_sms_outreach: invalid E.164 phone number",
          );
          return McpUtilities.createJsonResponse({
            status: "not_sent",
            errorCode: "INVALID_PHONE_NUMBER",
            fhirWritesPerformed: false,
            smsDelivered: false,
            safetyNote:
              `Phone number '${toPhoneNumber}' is not in valid E.164 format. ` +
              "E.164 format requires a leading '+' and country code (e.g. +15551234567 for US, " +
              "+919876543210 for India). Please provide the correct number and try again.",
          });
        }

        // ── Twilio credentials check ───────────────────────────────────────
        if (
          !config.twilioAccountSid ||
          !config.twilioAuthToken ||
          !config.twilioFromNumber
        ) {
          logger.error("send_sms_outreach: Twilio credentials not configured");
          return McpUtilities.createTextResponse(
            "Twilio SMS is not configured on this server. " +
              "The server administrator must set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, " +
              "and TWILIO_FROM_NUMBER environment variables before SMS delivery is available. " +
              "The outreach message draft remains valid and can be sent manually.",
            { isError: true },
          );
        }

        try {
          logger.info(
            {
              toPhoneNumber,
              preferredLanguage,
              patientName,
              resultReference,
              messageLength: messageText.length,
            },
            "send_sms_outreach: sending SMS via Twilio",
          );

          // SMS delivery is currently supported for English (en) only.
          // Non-English messages (es, hi) contain non-GSM-7 characters that exceed
          // Twilio trial account segment limits. Ask the clinician to use English.
          if (preferredLanguage !== "en") {
            return McpUtilities.createJsonResponse({
              status: "not_sent",
              errorCode: "LANGUAGE_NOT_SUPPORTED_FOR_SMS",
              fhirWritesPerformed: false,
              smsDelivered: false,
              safetyNote:
                `SMS delivery is currently supported for English (en) only. ` +
                `The '${preferredLanguage}' outreach draft was prepared successfully but cannot be sent via SMS at this time. ` +
                `Please ask the clinician to request an English outreach draft and approve that for SMS delivery.`,
            });
          }

          // Strip subject line, take first substantive paragraph, hard-cap at 155 GSM-7 chars
          // (160 max minus Twilio trial prefix length) to guarantee 1 SMS segment.
          const rawText = messageText.replace(/^Subject:.*\n?/im, "").trim();
          const paragraphs = rawText
            .split(/\n\s*\n/)
            .map((p) => p.trim())
            .filter(Boolean);
          const bodyPara =
            paragraphs.find((p) => p.length > 60) ?? paragraphs[0] ?? rawText;
          const MAX_SMS_CHARS = 155;
          const smsBody =
            bodyPara.length > MAX_SMS_CHARS
              ? bodyPara.substring(0, MAX_SMS_CHARS - 3) + "..."
              : bodyPara;

          const twilioResponse = await sendTwilioSms(toPhoneNumber, smsBody);

          logger.info(
            {
              messageSid: twilioResponse.sid,
              status: twilioResponse.status,
              toPhoneNumber,
              preferredLanguage,
            },
            "send_sms_outreach: SMS queued successfully",
          );

          return McpUtilities.createJsonResponse({
            status: "sent",
            messageSid: twilioResponse.sid,
            deliveryStatus: twilioResponse.status,
            sentAt: twilioResponse.date_created,
            to: twilioResponse.to,
            from: twilioResponse.from,
            preferredLanguage,
            patientName: patientName ?? null,
            resultReference: resultReference ?? null,
            messagePreview:
              messageText.length > 120
                ? messageText.substring(0, 120) + "..."
                : messageText,
            fhirWritesPerformed: false,
            smsDelivered: true,
            safetyNote:
              "SMS has been queued for delivery by Twilio. Delivery to the patient's device " +
              "is subject to carrier network conditions. This outreach message is a draft only — " +
              "it does not constitute a clinical order or guarantee receipt by the patient. " +
              "Clinician should follow up through the EHR if no patient response is received.",
          });
        } catch (error) {
          logger.error(
            { error, toPhoneNumber, preferredLanguage },
            "send_sms_outreach: Twilio API request failed",
          );

          return McpUtilities.createTextResponse(
            `SMS delivery failed: ${
              error instanceof Error ? error.message : "Unknown Twilio error"
            }. ` +
              "The outreach message draft is still valid. You may retry or send manually through " +
              "your patient communication platform. ResultLoop audit results remain valid independently " +
              "of this SMS delivery failure.",
            { isError: true },
          );
        }
      },
    );
  }
}

export const SendSmsOutreachToolInstance = new SendSmsOutreachTool();
