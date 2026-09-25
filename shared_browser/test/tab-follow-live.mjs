// Actual MCP actions, independent Chrome source, and two real viewer pages.
// No live account or operational browser is touched.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const state=await fs.mkdtemp('/tmp/shared-follow-');
process.env.SHARED_BROWSER_STATE=state;
const {rpc}=await import('../rpc.mjs');
const origin='http://127.0.0.1:8801';
const headers={'Tailscale-User-Login':'manbir@asgroup.ai'};
const fixture=http.createServer((req,res)=>{
  res.setHeader('Content-Type','text/html');
  res.end(`<!doctype html><title>Follow ${req.url}</title><h1>Follow ${req.url}</h1>
    <button id="count" onclick="this.textContent='Clicked at '+innerWidth">Click</button>
    <div id="opaque-host" style="width:180px;height:50px"></div>
    <script>
      const root=document.getElementById('opaque-host').attachShadow({mode:'closed'});
      root.innerHTML='<button style="width:180px;height:50px;background:rgb(12, 150, 90)" onclick="window.opaqueClicks=(window.opaqueClicks||0)+1">Hidden control</button>';
    </script>
    <input aria-label="Note"><a id="popup" href="/popup" target="_blank">Open popup</a>
    <div style="height:1800px">Scroll area</div>`);
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const fixtureURL='http://127.0.0.1:'+fixture.address().port;
const otherOrigin='http://localhost:'+fixture.address().port;
const source=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true});
let worker,viewer,webkitViewer,ws,logs='';
const client=new Client({name:'tab-follow-test',version:'1.0.0'});
const wait=async(fn,label)=>{
  for(let i=0;i<150;i++) {try {if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,60));}
  throw Error('Timed out: '+label+' '+logs);
};
const act=async code=>{
  const result=await client.callTool({name:'js',arguments:{code}});
  assert.ok(!result.isError,JSON.stringify(result));return result;
};
const stop=async()=>{worker.kill('SIGTERM');await new Promise(r=>worker.exitCode!==null?r():worker.once('exit',r));worker=undefined;};
const start=async()=>{
  worker=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname],{
    env:{...process.env,SHARED_BROWSER_PORT:'8801',SHARED_BROWSER_ORIGIN:origin,
      SHARED_BROWSER_CDP_URL:'http://'+new URL(source.wsEndpoint()).host},stdio:['ignore','ignore','pipe']});
  worker.stderr.on('data',b=>logs+=b);
  await wait(()=>rpc('state'),'receiver');
};
try {
  await start();
  await client.connect(new StdioClientTransport({command:process.execPath,
    args:[new URL('../mcp.mjs',import.meta.url).pathname],env:{...process.env}}));
  await act('await cua.getState();');
  await act(`var browser=await cua.getBrowser();var a=await browser.tabs.new('${fixtureURL}/a');var b=await browser.tabs.new('${otherOrigin}/b');`);
  const initial=await rpc('state');
  const a=initial.tabs.find(t=>t.url===fixtureURL+'/a').id;
  const b=initial.tabs.find(t=>t.url===otherOrigin+'/b').id;
  const sourceA=(await source.pages()).find(p=>p.url()===fixtureURL+'/a');
  const sourceB=(await source.pages()).find(p=>p.url()===otherOrigin+'/b');
  viewer=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true});
  const pages=[await viewer.newPage()];
  if(process.env.SHARED_BROWSER_WEBKIT_MODULE) {
    const {webkit}=await import(process.env.SHARED_BROWSER_WEBKIT_MODULE);
    webkitViewer=await webkit.launch({headless:true});pages.push(await webkitViewer.newPage());
  } else pages.push(await viewer.newPage());
  for(const page of pages){
    if(page.setViewport)await page.setViewport({width:940,height:700});
    else await page.setViewportSize({width:940,height:700});
    await page.setExtraHTTPHeaders(headers);
    const captureSocket=()=>{const Native=window.WebSocket;window.WebSocket=class extends Native{constructor(...args){super(...args);window.testViewerSocket=this;}};};
    if(page.evaluateOnNewDocument)await page.evaluateOnNewDocument(captureSocket);
    else await page.addInitScript(captureSocket);
    await page.goto(origin);
  }
  const showing=(page,id,text)=>page.evaluate(({id,text})=>document.querySelector('#tabs')?.value===id &&
    getComputedStyle(document.querySelector('#viewport')).visibility==='visible' &&
    document.querySelector('#replay iframe')?.contentDocument?.body?.textContent.includes(text),{id,text});
  const both=async(id,text)=>{
    for(const [index,page] of pages.entries()){
      await page.bringToFront();
      await wait(()=>showing(page,id,text),'viewer '+index+' visibly shows '+text);
    }
  };
  await both(b,'Follow /b');
  await pages[0].bringToFront();
  await wait(()=>pages[0].evaluate(()=>!!document.querySelector('#interaction-layer img[data-opaque-id]')),'closed shadow image');
  const opaque=await pages[0].evaluate(()=>{
    const image=document.querySelector('#interaction-layer img[data-opaque-id]');
    const box=image.getBoundingClientRect();
    return {x:box.x+box.width/2,y:box.y+box.height/2,src:image.src};
  });
  assert.ok(opaque.src.startsWith('data:image/png;base64,'));
  await pages[0].mouse.click(opaque.x,opaque.y);
  await wait(()=>sourceB.evaluate(()=>window.opaqueClicks===1),'closed shadow click');
  console.log('PASS: closed shadow pixels appear in replay and viewer clicks reach source Chrome');
  const events=[];
  ws=new WebSocket(origin.replace('http','ws')+'/ws',{headers:{...headers,Origin:origin}});
  ws.on('message',raw=>events.push(JSON.parse(raw)));
  await wait(()=>events.some(e=>e.type==='ready'),'observer ready');

  await act('await a.getAXState();');
  assert.equal((await rpc('state')).activeTab,b,'read-only inspection remains passive');
  events.length=0;
  await act("await a.click('#count');");
  const clicked=await sourceA.$eval('#count',e=>e.textContent);
  assert.match(clicked,/^Clicked at \d+$/);
  await both(a,clicked);
  const selected=events.findIndex(e=>e.type==='state'&&e.activeTab===a);
  const cue=events.findIndex(e=>e.type==='agentActivity'&&e.tab===a&&e.phase==='start');
  assert.ok(selected>=0 && cue>selected,'viewer switches before action feedback');
  assert.equal(await sourceA.$eval('#count',e=>e.textContent),clicked);
  console.log('PASS: retained background tab action selects both viewers without device emulation');

  // Delayed events from the old viewer must not steal Chrome focus or resize it.
  const sourceWidth=await sourceB.evaluate(()=>innerWidth);
  const generation=(await rpc('state')).tabs.find(t=>t.id===b).generation;
  ws.send(JSON.stringify({type:'resize',tab:b,width:333,height:444,requestId:'stale-resize'}));
  ws.send(JSON.stringify({type:'pointer',phase:'move',tab:b,generation,x:10,y:10,modifiers:0,requestId:'stale-hover'}));
  ws.send(JSON.stringify({type:'click',tab:b,generation,x:10,y:10,requestId:'stale-click'}));
  await wait(()=>events.some(e=>e.requestId==='stale-click'),'stale messages processed');
  assert.equal((await rpc('state')).activeTab,a);
  assert.equal(await sourceA.evaluate(()=>document.visibilityState),'visible');
  assert.equal(await sourceB.evaluate(()=>innerWidth),sourceWidth);
  assert.match(events.find(e=>e.requestId==='stale-click').message,/Tab changed/);
  assert.equal(events.find(e=>e.requestId==='stale-click').code,'STALE_VIEW');
  console.log('PASS: late old-tab resize, hover, and click cannot switch back or act on a stale view');

  await act("await b.type('input','Agent changed B');");
  await both(b,'Follow /b');
  for(const page of pages){await page.bringToFront();await wait(()=>page.$eval('#interaction-layer input',e=>e.value==='Agent changed B'),'B form visible');}
  await pages[0].bringToFront();
  await pages[0].type('#interaction-layer input',' plus viewer');
  await wait(()=>sourceB.$eval('input',e=>e.value==='Agent changed B plus viewer'),'viewer input reaches newly selected source');
  console.log('PASS: switching back by a field edit preserves two-way user interaction');
  await pages[0].evaluate(tab=>window.testViewerSocket.send(JSON.stringify({
    type:'click',tab,generation:'old-document',x:10,y:10,requestId:'old-document-click'
  })),b);
  await wait(()=>pages[0].$eval('#error',e=>e.textContent==='Page changed. Please try that action again.'),'transient stale-view notice');
  await wait(()=>pages[0].$eval('#error',e=>e.textContent===''),'stale-view notice clears automatically');
  assert.equal(await sourceB.$eval('#count',e=>e.textContent),'Click','rejected click was not replayed');
  console.log('PASS: stale document input is rejected and its retry notice clears without a refresh');
  await act('await a.getAXState();');
  assert.equal((await rpc('state')).activeTab,b,'background reading does not interrupt the foreground action');
  await wait(()=>pages[0].$eval('#last-agent-activity',e=>!e.hidden && e.textContent.includes('Follow /a')),'last reading location visible');
  await pages[0].click('#last-agent-activity');await both(a,'Follow /a');
  await rpc('js',{context:'second-agent',code:`const tab=await cua.getTab('${b}');await tab.type('input','Second agent');`});
  await both(b,'Follow /b');
  const activity=(await rpc('state')).agents;
  assert.equal(activity.length,2);assert.notEqual(activity[0].agent,activity[1].agent);
  await wait(()=>pages[0].$$eval('#agent-tabs button',e=>e.length===2),'separate agent shortcuts');
  console.log('PASS: last observed tab can be opened manually; separate agents retain individual recent locations');
  // Different viewer sizes must not strand a phone behind a desktop-sized replay.
  if(pages[1].setViewport)await pages[1].setViewport({width:390,height:780});
  else await pages[1].setViewportSize({width:390,height:780});


  await act("await a.click('#popup');");
  await wait(async()=>(await rpc('state')).tabs.some(t=>t.url===fixtureURL+'/popup'),'popup attached');
  const popup=(await rpc('state')).tabs.find(t=>t.url===fixtureURL+'/popup').id;
  await both(popup,'Follow /popup');
  await act(`var popup=await cua.getTab('${popup}');await popup.close();`);
  await both(a,'Follow /a');
  assert.equal(await sourceA.evaluate(()=>document.visibilityState),'visible');
  console.log('PASS: normal target=_blank popup follows automatically; closing returns to Chrome foreground');

  // Explicit viewer tab selection is still supported; the next agent action follows again.
  ws.send(JSON.stringify({type:'tab',tab:b,requestId:'manual-tab'}));
  await both(b,'Follow /b');
  await act("await a.type('input','After manual switch');");
  await both(a,'Follow /a');
  for(const page of pages)await page.close();
  ws.close();await new Promise(r=>ws.once('close',r));ws=undefined;
  await wait(async()=>(await rpc('state')).viewers===0,'all viewers disconnected');
  await act("await b.type('input','While disconnected');");
  const reconnected=await viewer.newPage();await reconnected.setExtraHTTPHeaders(headers);await reconnected.goto(origin);
  await wait(()=>showing(reconnected,b,'Follow /b'),'reconnect follows latest active tab');
  await wait(()=>reconnected.$eval('#interaction-layer input',e=>e.value==='While disconnected'),'reconnect current form');
  console.log('PASS: viewer selection, disconnected agent actions, and reconnect all follow the current target');

  await stop();await start();
  const afterRestart=await rpc('state');
  assert.equal(afterRestart.tabs.find(t=>t.id===afterRestart.activeTab)?.url,otherOrigin+'/b');
  await reconnected.reload();
  await wait(()=>reconnected.$eval('#interaction-layer input',e=>e.value==='While disconnected'),'receiver restart preserves current form');
  console.log('PASS: receiver-only restart preserves Chrome tab selection and unsaved edits');
}finally {
  ws?.close();await client.close();await viewer?.close();await webkitViewer?.close();if(worker)await stop();await source.close();
  await new Promise(r=>fixture.close(r));await fs.rm(state,{recursive:true,force:true});
}
