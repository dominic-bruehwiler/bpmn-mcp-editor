/**
 * stdio MCP entry for Cursor and other local clients.
 * Writes the same database as the web server. Keep logs on stderr; stdout is the protocol.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { prepareDatabase } from "./db";
import { createMcpServer } from "./mcp";

await prepareDatabase();
const server = createMcpServer();
await server.connect(new StdioServerTransport());
console.error("BPMN MCP server is listening on stdio.");
