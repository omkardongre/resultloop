import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Utility helpers for constructing MCP tool responses.
 */
export const McpUtilities = {
  /**
   * Create a standard text response for an MCP tool call.
   */
  createTextResponse: (
    text: string,
    options: { isError: boolean } = { isError: false },
  ): CallToolResult => {
    return {
      content: [{ type: "text", text }],
      isError: options.isError,
    };
  },

  /**
   * Create a JSON response for structured tool output.
   */
  createJsonResponse: (
    data: Record<string, unknown>,
    options: { isError: boolean } = { isError: false },
  ): CallToolResult => {
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      isError: options.isError,
    };
  },
};
