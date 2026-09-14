// Real browser input through the shipped viewer relay and remote mouse adapter.
// A delayed ACK path reproduces ordinary network latency without touching a site.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import puppeteer from 'puppeteer-core';
import {RemoteMouse} from '../remote-mouse.mjs';
const relay=await fs.readFile(process.env.TEST_VIEWER_MOUSE||new URL('../viewer-mouse.js',import.meta.url),'utf8');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await sleep(25);}throw Error('Expected browser input was not delivered');};
const server=http.createServer((req,res)=>{
  if(req.url==='/relay.js'){res.setHeader('Content-Type','text/javascript');return res.end(relay);}
  res.setHeader('Content-Type','text/html');
  const base='<style>html,body{margin:0;width:100%;height:100%}#surface{position:fixed;inset:0}</style><div id="surface"></div>';
  const audit='<script>window.observed=[];for(const type of ["pointermove","pointerdown","pointerup","click"])addEventListener(type,e=>observed.push({type,x:e.clientX,y:e.clientY,pressure:e.pressure,buttons:e.buttons,trusted:e.isTrusted,target:e.target.id||e.target.tagName}));</script>';
  if(req.url==='/source')return res.end(base+audit);
  res.end(base+audit+`<script type="module">
import {relayMouse} from '/relay.js';const ws=new WebSocket(location.origin.replace('http','ws'));let n=0;
const relay=relayMouse(document.querySelector('#surface'),{enabled:()=>ws.readyState===1,context:()=>({generation:'fixture'}),point:e=>({x:e.clientX,y:e.clientY}),send:m=>{const id=String(++n);ws.send(JSON.stringify({...m,requestId:id}));return id;}});
ws.onmessage=e=>relay.acknowledge(JSON.parse(e.data).requestId);ws.onopen=()=>window.ready=true;
</script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true,args:['--disable-dev-shm-usage']});
const wss=new WebSocketServer({server});let source,viewer,viewerBrowser,queue=Promise.resolve(),payloadBytes=0;
try{
  source=await browser.newPage();await source.goto(origin+'/source');
  const tab={cdp:await source.createCDPSession()},mouse=new RemoteMouse();
  wss.on('connection',ws=>{
    ws.on('message',raw=>{
      payloadBytes+=raw.length;const message=JSON.parse(raw);
      queue=queue.then(()=>mouse.dispatch(ws,tab,message)).then(()=>{
        const timer=setTimeout(()=>{if(ws.readyState===1)ws.send(JSON.stringify({requestId:message.requestId}));},200);timer.unref();
      });
    });
    ws.on('close',()=>{queue=queue.then(()=>mouse.release(ws));});
  });
  viewerBrowser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true,args:['--disable-dev-shm-usage']});
  viewer=await viewerBrowser.newPage();await viewer.goto(origin+'/viewer');await viewer.waitForFunction(()=>window.ready);
  // Each genuine browser event occupies its own animation frame. Both sides
  // should retain the same positions even while prior moves await ACKs.
  for(let i=0;i<20;i++){await viewer.mouse.move(50+i*12,100+i*4);await sleep(35);}
  await sleep(450);await queue;
  const left=await viewer.evaluate(()=>observed.filter(e=>e.type==='pointermove'));
  const right=await source.evaluate(()=>observed.filter(e=>e.type==='pointermove'));
  console.log(JSON.stringify({observedMoves:left.length,deliveredMoves:right.length,ackDelayMs:200}));
  assert.deepEqual(right,left);
  assert.equal(left.length,20);
  console.log('PASS: all 20 observed movement samples reach Chrome in order with 200 ms ACK latency');
  const cdp=await viewer.createCDPSession();
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:278,y:176,button:'left',buttons:1,clickCount:1,force:0.5});
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:278,y:176,button:'left',buttons:0,clickCount:1,force:0});
  await wait(async()=>(await source.evaluate(()=>observed.filter(e=>e.type==='click').length))===1);
  assert.deepEqual(await source.evaluate(()=>observed.filter(e=>e.type!=='pointermove')),await viewer.evaluate(()=>observed.filter(e=>e.type!=='pointermove')));
  console.log('PASS: observed mouse pressure, release, button state, trust and a single click match the viewer');
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:278,y:176,button:'left',buttons:1,clickCount:1,force:0.5});
  for(const x of [260,240,220]){
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:180,button:'left',buttons:1,force:0.5});await sleep(35);
  }
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:220,y:180,button:'left',buttons:0,clickCount:1,force:0});
  await wait(async()=>(await source.evaluate(()=>observed.filter(e=>e.type==='pointerup').length))===2);
  assert.deepEqual(await source.evaluate(()=>observed),await viewer.evaluate(()=>observed));
  console.log('PASS: held-button movement and pressure remain equal throughout a drag');
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x:278,y:176,button:'left',buttons:1,clickCount:1,force:0.5});
  await wait(async()=>(await source.evaluate(()=>observed.filter(e=>e.type==='pointerdown').length))===3);
  await viewer.close();viewer=null;await sleep(100);await queue;
  assert.equal(mouse.held.size,0);
  // Chrome can send an outside-page click to HTML; it must not activate the
  // control that was pressed when the viewer disconnected.
  assert.equal(await source.evaluate(()=>observed.filter(e=>e.type==='click'&&e.target==='surface').length),2);
  console.log('PASS: disconnect releases the pointer without activating the pressed control; total input payload '+payloadBytes+' bytes');
}finally{
  await viewer?.close();for(const ws of wss.clients)ws.terminate();
  await viewerBrowser?.close();await browser.close();await queue.catch(()=>{});
  await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));
}
