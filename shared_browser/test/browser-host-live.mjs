// Isolated normal Chrome plus receiver: tests engine properties, native-style
// coordinates, and preservation of live page state through receiver updates.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';
const state=await fs.mkdtemp(path.join(os.tmpdir(),'shared-native-live-'));
process.env.SHARED_BROWSER_STATE=state;
const {rpc}=await import('../rpc.mjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){for(let i=0;i<150;i++){try{const value=await fn();if(value)return value;}catch{}await sleep(100);}throw Error('Timed out: '+label);}
const free=http.createServer();await new Promise(r=>free.listen(0,'127.0.0.1',r));const port=free.address().port;await new Promise(r=>free.close(r));
const origin='http://127.0.0.1:'+port;
const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
let pixelRequests=0;
const fixture=http.createServer((req,res)=>{
  if(req.url==='/tile.png'){pixelRequests++;res.setHeader('Content-Type','image/png');res.setHeader('Cache-Control','max-age=3600');return res.end(pixel);}
  if(req.url==='/external.css'){res.setHeader('Content-Type','text/css');return res.end('body{margin:27px;background:rgb(234,245,252) url("/tile.png") no-repeat}#count,#child-button{border:7px solid rgb(25,80,140)}');}
  res.setHeader('Content-Type','text/html');
  if(req.url==='/child')return res.end('<!doctype html><link rel="stylesheet" href="/external.css"><input id="child-field" value="child original"><button id="child-button" onclick="this.textContent=\'Child clicked\'">Child button</button>');
  res.end('<!doctype html><link rel="stylesheet" href="/external.css"><input id="kept" value="original"><button id="count" onclick="this.textContent=String(Number(this.textContent)+1)">0</button><iframe id="child"></iframe><script>document.querySelector("iframe").src="http://localhost:"+location.port+"/child"</script>');
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const fixtureURL='http://127.0.0.1:'+fixture.address().port;
const env={...process.env,SHARED_BROWSER_ENGINE:'native',SHARED_BROWSER_PORT:String(port),SHARED_BROWSER_ORIGIN:origin};
let host,receiver,sourceBrowser,viewerBrowser;
function start(file){const p=spawn(process.execPath,[new URL('../'+file,import.meta.url).pathname],{env,stdio:['ignore','pipe','pipe']});p.stdout.on('data',()=>{});p.stderr.on('data',b=>process.stderr.write(b));return p;}
async function stop(p){if(!p||p.exitCode!==null)return;p.kill('SIGTERM');await wait(()=>p.exitCode!==null||p.signalCode,'process shutdown');}
try{
  host=start('browser-host.mjs');
  const info=await wait(()=>fs.readFile(path.join(state,'browser-host.json'),'utf8').then(JSON.parse),'native host');
  assert.equal((await fs.stat(path.join(state,'browser-host.Xauthority'))).mode&0o777,0o600);
  sourceBrowser=await puppeteer.connect({browserWSEndpoint:info.browserWSEndpoint,defaultViewport:null});
  receiver=start('server.mjs');await wait(()=>rpc('state'),'receiver ready');
  assert.equal((await rpc('state')).engine,'native');
  await rpc('js',{context:'native-live',code:'const tab=await (await cua.getBrowser()).tabs.new('+JSON.stringify(fixtureURL)+');'});
  const source=(await sourceBrowser.pages()).find(p=>p.url()===fixtureURL+'/');assert.ok(source);
  const properties=await source.evaluate(()=>({webdriver:navigator.webdriver,headless:navigator.userAgent.includes('HeadlessChrome'),screen:[screen.width,screen.height]}));
  assert.deepEqual(properties,{webdriver:false,headless:false,screen:[2560,1600]});
  console.log('PASS: real desktop Chrome with authenticated local rendering and normal browser properties');
  await source.focus('#kept');await source.keyboard.press('End');await source.keyboard.type(' unsaved');
  const child=await wait(()=>source.frames().find(f=>f.url().endsWith('/child')),'cross-origin child');
  await child.focus('#child-field');await source.keyboard.press('End');await source.keyboard.type(' unsaved');
  const button=await child.$('#child-button');const box=await button.boundingBox();await button.dispose();
  await rpc('js',{context:'native-live',code:'await tab.click('+JSON.stringify([box.x+box.width/2,box.y+box.height/2])+');'});
  assert.equal(await child.$eval('#child-button',e=>e.textContent),'Child clicked');
  console.log('PASS: native-style MCP coordinate click reaches a cross-origin control');
  viewerBrowser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true,args:['--disable-dev-shm-usage']});
  const viewer=await viewerBrowser.newPage();await viewer.setExtraHTTPHeaders({'Tailscale-User-Login':'manbir@asgroup.ai'});await viewer.goto(origin);
  const values=()=>viewer.$eval('#replay iframe',f=>({top:f.contentDocument.querySelector('#kept')?.value,child:f.contentDocument.querySelector('#child')?.contentDocument?.querySelector('#child-field')?.value}));
  await wait(async()=>(await values()).child==='child original unsaved','initial shared child content').catch(async error=>{
    console.log({sourceValue:await child.$eval('#child-field',e=>e.value),replay:await values().catch(e=>e.message),viewer:await viewer.$eval('body',e=>e.innerText),status:await rpc('state')});throw error;
  });
  const initialGeneration=await source.evaluate(()=>window.__sharedGeneration);
  const initialPixelRequests=pixelRequests;
  await stop(receiver);receiver=start('server.mjs');await wait(()=>rpc('state'),'receiver restarted');
  await wait(async()=>{const s=await rpc('state');const generation=await source.evaluate(()=>window.__sharedGeneration);return generation===initialGeneration&&s.tabs.some(t=>t.generation===generation);},'new receiver preserves the live document mirror');
  await wait(async()=>JSON.stringify(await values())===JSON.stringify({top:'original unsaved',child:'child original unsaved'}),'viewer reconnect restores live forms');
  // Force the URL relay: same-origin fixture sheets may also be inlined by
  // rrweb, unlike real cross-origin CDN sheets. Fetching via the viewer proves
  // a new receiver can recover bytes without a source-page reload.
  const recoveredCSS=await viewer.evaluate(async({port,url})=>{
    const status=await fetch('/status').then(r=>r.json());const t=status.tabs.find(t=>t.url===url+'/');
    const results=[];
    for(const host of ['127.0.0.1','localhost']){
      const r=await fetch('/asset?tab='+encodeURIComponent(t.id)+'&url='+encodeURIComponent('http://'+host+':'+port+'/external.css'));
      results.push({status:r.status,text:await r.text()});
    }
    return results;
  },{port:fixture.address().port,url:fixtureURL});
  assert.deepEqual(recoveredCSS.map(r=>({status:r.status,css:r.text.includes('rgb(234,245,252)')})),[{status:200,css:true},{status:200,css:true}]);
  const recoveredImages=await viewer.evaluate(async({port,url})=>{
    const status=await fetch('/status').then(r=>r.json());const t=status.tabs.find(t=>t.url===url+'/');
    return Promise.all(['127.0.0.1','localhost'].map(async host=>{
      const r=await fetch('/asset?tab='+encodeURIComponent(t.id)+'&url='+encodeURIComponent('http://'+host+':'+port+'/tile.png'));
      return {status:r.status,bytes:[...new Uint8Array(await r.arrayBuffer())]};
    }));
  },{port:fixture.address().port,url:fixtureURL});
  for(const image of recoveredImages){assert.equal(image.status,200);assert.deepEqual(Buffer.from(image.bytes),pixel);}
  assert.equal(pixelRequests,initialPixelRequests);
  console.log('PASS: loaded parent and cross-origin child stylesheets survive receiver restart without source reload');
  console.log('PASS: CSS background images recover byte-for-byte from Chrome cache without duplicate network requests');
  assert.equal(JSON.parse(await fs.readFile(path.join(state,'browser-host.json'),'utf8')).pid,info.pid);
  const tabs=await rpc('state');const savedTab=tabs.tabs.find(t=>t.url===source.url());
  await rpc('js',{context:'after-restart',code:'const tab=await cua.getTab('+JSON.stringify(savedTab.id)+'); await tab.click("#count");'});
  assert.equal(await source.$eval('#count',e=>e.textContent),'1');
  await child.focus('#child-field');await source.keyboard.press('End');await source.keyboard.type(' still connected');
  await wait(async()=>(await values()).child.endsWith('still connected'),'child updates after recorder reattachment').catch(async error=>{
    console.log({source:await child.$eval('#child-field',e=>({value:e.value,generation:window.__sharedGeneration,node:window.__sharedMirror.getId(e),recording:!!window.__sharedStop})),replay:await values(),viewerText:await viewer.$eval('body',e=>e.innerText)});throw error;
  });
  console.log('PASS: receiver restart preserves Chrome, unsaved parent/child form state, live mirror IDs, and continued interaction');
  // New documents after reattachment must not inherit competing recorders or
  // stale node maps from previous receiver connections.
  for(let attempt=0;attempt<2;attempt++){
    await stop(receiver);receiver=start('server.mjs');await wait(()=>rpc('state'),'repeated receiver restart');
    await source.reload({waitUntil:'networkidle2'});
    await wait(async()=>(await values()).child==='child original','fresh child after restart and navigation');
    const current=(await rpc('state')).tabs.find(t=>t.url===source.url());
    const childNow=source.frames().find(f=>f.url().endsWith('/child'));
    const node=await childNow.$eval('#child-button',e=>window.__sharedMirror.getId(e));
    assert.ok(node>0);
    await rpc('js',{context:'reload-'+attempt,code:'const tab=await cua.getTab('+JSON.stringify(current.id)+'); await tab.click("#count");'});
    await wait(()=>viewer.$eval('#replay iframe',f=>f.contentDocument.querySelector('#count')?.textContent==='1'),'fresh replay follows action');
    await childNow.focus('#child-field');await source.keyboard.press('End');await source.keyboard.type(' after reload');
    await wait(async()=>(await values()).child==='child original after reload','fresh child recording after repeated reattachment');
  }
  console.log('PASS: repeated receiver restarts followed by navigation preserve functional parent/child recording');
}finally{
  await viewerBrowser?.close();sourceBrowser?.disconnect();await stop(receiver);await stop(host);
  await new Promise(r=>fixture.close(r));await fs.rm(state,{recursive:true,force:true});
}
