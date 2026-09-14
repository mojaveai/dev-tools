import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { rpc } from "./rpc.mjs";
import { instructions } from "./runtime.mjs";
const context = randomUUID();
const server = new McpServer(
  { name: "shared_browser_repl", version: "0.1.0" },
  { instructions },
);
server.registerTool(
  "js",
  {
    description: instructions,
    inputSchema: { code: z.string(), title: z.string().optional() },
  },
  async ({ code }) => {
    try {
      return await rpc("js", { context, code });
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  },
);
server.registerTool(
  "js_reset",
  {
    description:
      "Reset JavaScript bindings; Chrome and the shared session remain running.",
    inputSchema: {},
  },
  async () => ({
    content: [
      { type: "text", text: JSON.stringify(await rpc("reset", { context })) },
    ],
  }),
);
await server.connect(new StdioServerTransport());
