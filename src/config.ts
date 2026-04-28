import "dotenv/config";

export const config = {
  port: parseInt(process.env["PORT"] || "5000", 10),
  poEnv: (process.env["PO_ENV"] || "local") as "dev" | "prod" | "local",
  logLevel: process.env["LOG_LEVEL"] || "info",
};
