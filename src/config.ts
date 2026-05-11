import "dotenv/config";

export const config = {
  port: parseInt(process.env["PORT"] || "10000", 10),
  poEnv: (process.env["PO_ENV"] || "local") as "dev" | "prod" | "local",
  logLevel: process.env["LOG_LEVEL"] || "info",
  // Public URL for serving HTML audit reports.
  // Set MCP_PUBLIC_BASE_URL in Render env vars to override.
  publicBaseUrl:
    process.env["MCP_PUBLIC_BASE_URL"] || "https://resultloop-mcp.onrender.com",
  // Twilio SMS credentials (required for send_sms_outreach tool).
  // Set in Render env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
  twilioAccountSid: process.env["TWILIO_ACCOUNT_SID"] || "",
  twilioAuthToken: process.env["TWILIO_AUTH_TOKEN"] || "",
  twilioFromNumber: process.env["TWILIO_FROM_NUMBER"] || "",
};
