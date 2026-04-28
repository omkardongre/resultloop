/**
 * ResultLoop — Abnormal Result Follow-Up Closure Audit MCP Server
 *
 * A SHARP-on-MCP compliant server that audits patient records for abnormal
 * lab and imaging results lacking documented follow-up closure evidence.
 *
 * Architecture: Express HTTP → MCP SDK → FHIR context extraction → Tool dispatch
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createMcpExpressApp,
} from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import { config } from "./config.js";
import { logger } from "./util/logger.js";
import { registerAllTools } from "./tools/index.js";

const allowedHosts: string[] = [];

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
                {
                  name: "patient/Patient.rs",
                  required: true,
                },
                {
                  name: "offline_access",
                },
                {
                  name: "patient/Observation.rs",
                },
                {
                  name: "patient/DiagnosticReport.rs",
                },
                {
                  name: "patient/ServiceRequest.rs",
                },
                {
                  name: "patient/Task.rs",
                },
                {
                  name: "patient/Communication.rs",
                },
                {
                  name: "patient/CarePlan.rs",
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

app.listen(config.port, () => {
  logger.info(
    { port: config.port, env: config.poEnv },
    "ResultLoop MCP server started",
  );
});
