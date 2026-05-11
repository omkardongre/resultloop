/**
 * ResultLoop — Abnormal Result Follow-Up Closure Audit MCP Server
 *
 * A SHARP-on-MCP compliant server that audits patient records for abnormal
 * lab and imaging results lacking documented follow-up closure evidence.
 *
 * Architecture: Express HTTP → MCP SDK → FHIR context extraction → Tool dispatch
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import { config } from "./config.js";
import { logger } from "./util/logger.js";
import { registerAllTools } from "./tools/index.js";
import { getReport } from "./tools/report-store.js";

const allowedHosts: string[] = ["resultloop-mcp.onrender.com"];

switch (config.poEnv) {
  case "dev":
    allowedHosts.push("resultloop.dev.promptopinion.ai");
    break;
  case "prod":
    allowedHosts.push("resultloop.promptopinion.ai");
    break;
  default:
    allowedHosts.push("localhost");
}

const app = createMcpExpressApp({
  host: "0.0.0.0",
  allowedHosts,
});

app.use(cors());

// Health check endpoint
app.get("/health", async (_req, res) => {
  res.json({
    status: "ok",
    service: "resultloop-mcp",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  });
});

// Serve generated HTML audit reports
app.get("/report/:reportId", async (req, res) => {
  const { reportId } = req.params;
  const html = getReport(reportId);

  if (!html) {
    res.status(404).send(
      "<h1>Report Not Found</h1><p>This report may have expired or the ID is invalid.</p>",
    );
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// MCP protocol endpoint
app.post("/mcp", async (req, res) => {
  try {
    const server = new McpServer(
      {
        name: "ResultLoop",
        version: "0.1.0",
      },
      {
        capabilities: {
          extensions: {
            "ai.promptopinion/fhir-context": {
              scopes: [
                // All resource scopes below are required because the closure
                // audit pipeline must query every resource type to produce a
                // trustworthy verdict. Missing any scope would silently
                // under-report follow-up evidence and risk a false CLOSED.
                {
                  name: "patient/Patient.rs",
                  required: true,
                },
                {
                  name: "patient/Observation.rs",
                  required: true,
                },
                {
                  name: "patient/DiagnosticReport.rs",
                  required: true,
                },
                {
                  name: "patient/ServiceRequest.rs",
                  required: true,
                },
                {
                  // Task scope is optional because some FHIR platforms do not
                  // expose Task in their SMART scope set. The audit still
                  // produces a verdict from the other follow-up resources and
                  // surfaces a partial-failure warning via searchErrors.
                  name: "patient/Task.rs",
                  required: true,
                },
                {
                  name: "patient/Communication.rs",
                  required: true,
                },
                {
                  name: "patient/CarePlan.rs",
                  required: true,
                },
                {
                  name: "patient/Encounter.rs",
                  required: true,
                },
              ],
            },
          },
        },
      },
    );

    // Register all ResultLoop tools
    registerAllTools(server, req);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      logger.debug("MCP request closed");
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logger.error({ error }, "Error handling MCP request");
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.listen(config.port, "0.0.0.0", () => {
  logger.info(
    { port: config.port, env: config.poEnv },
    "ResultLoop MCP server started",
  );
});
