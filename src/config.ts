import "dotenv/config";

export const config = {
  port: parseInt(process.env["PORT"] || "10000", 10),
  poEnv: (process.env["PO_ENV"] || "local") as "dev" | "prod" | "local",
  logLevel: process.env["LOG_LEVEL"] || "info",
  // Public URL for serving HTML audit reports.
  // Set MCP_PUBLIC_BASE_URL in Render env vars to override.
  publicBaseUrl:
    process.env["MCP_PUBLIC_BASE_URL"] || "https://resultloop-mcp.onrender.com",
};
