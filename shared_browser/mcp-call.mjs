// Diagnostic client: runs the real registered tool protocol, not a direct CDP
// shortcut. Long-lived agent connections should use mcp.mjs itself.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
let code = "";
for await (const chunk of process.stdin) code += chunk;
const client = new Client({
  name: "shared-browser-tool-client",
  version: "0.1.0",
});
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("./mcp.mjs", import.meta.url))],
    }),
  );
  const result = await client.callTool({ name: "js", arguments: { code } });
  console.log(JSON.stringify(result, null, 2));
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
