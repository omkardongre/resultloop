import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Request } from "express";

/**
 * Interface that all ResultLoop MCP tools must implement.
 */
export interface IMcpTool {
  registerTool: (server: McpServer, req: Request) => void;
}
