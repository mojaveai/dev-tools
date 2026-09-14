// Run on procbox against the installed, running pilot. All website changes are
// confined to a dedicated synthetic fixture tab. Uses the actual stdio MCP.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let client;
async function connect() {
  client = new Client({ name: "shared-browser-live-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "mcp.mjs")],
    }),
  );
}
const call = async (code) => {
  const r = await client.callTool({ name: "js", arguments: { code } });
  if (r.isError) throw Error(r.content[0].text);
  return r;
};
const read = async (code) =>
  JSON.parse(
    (await call("nodeRepl.write(JSON.stringify(" + code + "));")).content[0]
      .text,
  );
function viewer() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:8791/ws?width=390&height=700", {
      origin: "https://procbox.agent-trace.ts.net:8443",
      headers: { "Tailscale-User-Login": "manbir@asgroup.ai" },
    });
    const messages = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw)));
    ws.on("error", reject);
    ws.on("open", () => resolve({ ws, messages }));
  });
}
const wait = async (predicate) => {
  for (let n = 0; n < 100; n++) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("Expected event did not arrive");
};
async function action(v, message) {
  const requestId = crypto.randomUUID();
  v.ws.send(JSON.stringify({ ...message, requestId }));
  const r = await wait(() => v.messages.find((m) => m.requestId === requestId));
  if (r.type === "error") throw Error(r.message);
  return r;
}
await connect();
assert.ok((await client.listTools()).tools.some((t) => t.name === "js"));
assert.equal((await fetch("http://127.0.0.1:8791/status")).status, 403);
assert.equal(
  (
    await fetch("http://127.0.0.1:8791/status", {
      headers: { "Tailscale-User-Login": "other@example.com" },
    })
  ).status,
  403,
);
await call(
  'const browser = await cua.getBrowser(); const tab = await browser.tabs.new("http://127.0.0.1:8791/fixture?automated=1");',
);
await call(
  'await tab.type("#message", "Written through MCP"); await tab.click("#save");',
);
assert.match(
  await read('await tab.playwright.locator("#result").innerText()'),
  /Written through MCP/,
);
const tabId = (await read("await tab.getState()")).id;
const v = await viewer();
await wait(() =>
  v.messages.some(
    (m) => m.type === "event" && m.tab === tabId && m.event.type === 2,
  ),
);
await wait(()=>v.messages.some(m=>m.type==="ready"));
const firstFull=v.messages.find(m=>m.type==="event" && m.tab===tabId && m.event.type===2);
assert.match(JSON.stringify(firstFull.event),/Phone layout/);
const initial=await read("await tab.getState()");
await action(v,{type:"scrollTo",tab:tabId,generation:initial.generation,node:firstFull.event.data.node.id,x:0,y:250,sequence:1});
const scrolled=await wait(()=>v.messages.find(m=>m.type==="scrollResult" && m.sequence===1));
assert.ok(scrolled.y>0 && scrolled.y<=250);
await assert.rejects(action(v,{type:"scrollTo",tab:tabId,generation:"stale",node:firstFull.event.data.node.id,x:0,y:400,sequence:2}),/Page changed/);
await action(v, { type: "take", width: 390, height: 700 });
await call('await tab.click("#increment");');
const clickStart=await wait(()=>v.messages.find(m=>m.type==="agentActivity" && m.kind==="click" && m.phase==="start"));
await wait(()=>v.messages.find(m=>m.type==="agentActivity" && m.id===clickStart.id && m.phase==="done"));
assert.ok(Number.isFinite(clickStart.x) && clickStart.rect.width>0);
await call('await tab.type("#notes","Feedback test"); await tab.select("#color","Ocean");');
for(const kind of ["typing","select"]) {
 const start=await wait(()=>v.messages.find(m=>m.type==="agentActivity" && m.kind===kind && m.phase==="start"));
 await wait(()=>v.messages.find(m=>m.type==="agentActivity" && m.id===start.id && m.phase==="done"));
}
// Closing a foreground tab used to leave the fixture hidden, stalling clicks.
await call('const background = await cua.createBrowserTab("about:blank"); await background.close();');
await call('await tab.click("#save");');
const current = await read("await tab.getState()");
await assert.rejects(
  action(v, { type: "click", tab: tabId, generation: "stale", x: 100, y: 100 }),
  /Page changed/,
);
await action(v, {
  type: "fill", tab: tabId, generation: current.generation,
  node: current.dom.elements.find(e => e.id === "message").node,
  value: "Shared viewer edit",
});
await call('await tab.click("#save");');
assert.match(await read('await tab.playwright.locator("#result").innerText()'), /Shared viewer edit/);
await action(v, { type: "give" });
await call('await tab.click("#increment");');
assert.equal(
  await read('await tab.playwright.locator("#count").innerText()'),
  "2",
);
v.ws.close();
await new Promise((r) => setTimeout(r, 100));
await call('await tab.click("#increment");');
const rejoined = await viewer();
await wait(() =>
  rejoined.messages.some((m) => m.type === "event" && m.tab === tabId),
);
assert.equal(
  await read('await tab.playwright.locator("#count").innerText()'),
  "3",
);
const full = await wait(() => rejoined.messages.find(m => m.type === "event" && m.tab === tabId && m.event.type === 2));
const nodes = [];
const visit = node => { nodes.push(node); for (const child of node.childNodes || []) visit(child); };
visit(full.event.data.node);
assert.equal(nodes.find(n => n.attributes?.id === "message").attributes.value, "Shared viewer edit");
rejoined.ws.close();
await client.close();
await connect();
await call(`const tab = await cua.getTab(${JSON.stringify(tabId)});`);
assert.equal(
  await read('await tab.playwright.locator("#count").innerText()'),
  "3",
);
await client.callTool({ name: "js_reset", arguments: {} });
await call(`const tab = await cua.getTab(${JSON.stringify(tabId)});`);
assert.equal(
  await read('await tab.playwright.locator("#count").innerText()'),
  "3",
);
await call("await tab.close();");
await client.close();
console.log(
  JSON.stringify(
    {
      passed: [
        "viewport applied before first full snapshot",
        "absolute scrolling acknowledged and stale document rejected",
        "agent click/typing/select cues have matching completion events",
        "MCP discovery",
        "persistent JavaScript",
        "MCP form entry and click",
        "unauthorized HTTP denied",
        "DOM snapshots delivered",
        "human and agent share mutation access",
        "stale input rejected",
        "viewer disconnect preserves automation",
        "viewer reconnect restores saved input property",
        "background tab click resumes without stalling",
        "MCP reconnect preserves browser",
        "MCP reset preserves browser",
      ],
      viewport: current.dom?.title,
    },
    null,
    2,
  ),
);
