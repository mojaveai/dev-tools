import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../runtime.mjs";
const session = {
  state: async () => ({ session: "test" }),
  tabs: new Map(),
  tabList: async () => [],
};
test("persistent bindings, output, and isolated MCP contexts", async () => {
  const r = new AgentRuntime(session);
  await r.execute(
    "a",
    "const count = 7; const { session } = await cua.getState();",
  );
  const output = await r.execute("a", "nodeRepl.write({count, session});");
  assert.deepEqual(JSON.parse(output[0].text), { count: 7, session: "test" });
  await assert.rejects(r.execute("b", "nodeRepl.write(count)"), /not defined/);
  r.reset("a");
  await assert.rejects(r.execute("a", "nodeRepl.write(count)"), /not defined/);
});
test("invalid JavaScript is an error and does not reset the browser", async () => {
  const r = new AgentRuntime(session);
  await assert.rejects(r.execute("a", "await ("), /Unexpected token/);
  assert.ok(
    (
      await r.execute("a", "nodeRepl.write(await cua.getState())")
    )[0].text.includes("test"),
  );
});
test("persistent browser handles retain mutation authority across tool calls", async () => {
  let changed = 0;
  const r = new AgentRuntime({
    ...session,
    agentAction: async (fn) => fn(),
    newTab: async () => {
      changed++;
      return { id: "x", page: { bringToFront: async () => {},} };
    },
  });
  await r.execute("a", "const browser = await cua.getBrowser();");
  await r.execute("a", "const tab = await browser.tabs.new();");
  assert.equal(changed, 1);
});
