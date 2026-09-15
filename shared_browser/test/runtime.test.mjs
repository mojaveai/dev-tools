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

test('native-style coordinate clicks retain feedback and target the browser viewport',async()=>{
  const events=[];
  const tab={id:'coordinates',generation:'doc',page:{bringToFront:async()=>events.push('front'),mouse:{click:async(x,y)=>events.push(['click',x,y])}}};
  const r=new AgentRuntime({...session,tabs:new Map([[tab.id,tab]]),agentAction:async fn=>fn(),feedbackPoint:async(t,p,kind,fn)=>{events.push([kind,p.x,p.y,t.generation]);return fn();}});
  await r.execute('a','const tab=await cua.getTab("coordinates"); await tab.click([42.5, 87]);');
  assert.deepEqual(events,['front',['click',42.5,87,'doc'],['click',42.5,87]]);
  await assert.rejects(r.execute('a','await tab.click([NaN, 1]);'),/finite/);
  assert.equal(events.length,3);
});

test('actions through retained tab handles activate the shared view before feedback',async()=>{
  const events=[];
  const tabs=new Map(['a','b'].map(id=>[id,{id,page:{url:()=>id,mouse:{click:async()=>events.push('click '+id)}}}]));
  const r=new AgentRuntime({...session,tabs,agentAction:async fn=>fn(),
    activate:async tab=>events.push('activate '+tab.id),
    feedbackPoint:async(tab,point,kind,fn)=>{events.push('cue '+tab.id);return fn();},
    snapshot:async tab=>({title:tab.id,text:'',elements:[]}),
  });
  await r.execute('a','const a=await cua.getTab("a");const b=await cua.getTab("b");await a.getAXState();');
  assert.deepEqual(events,[],'observing background tabs does not move the shared view');
  await r.execute('a','await b.click([10,20]);await a.click([20,30]);');
  assert.deepEqual(events,['activate b','cue b','click b','activate a','cue a','click a']);
});
