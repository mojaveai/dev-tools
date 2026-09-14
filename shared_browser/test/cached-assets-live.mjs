// A fresh relay tab navigates to a chart whose icons are already in Chrome's
// cache. Exercise actual 304 responses, late recovery, and receiver reconnect.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';
import {resourceRecovery} from '../resource-recovery.mjs';
const state=await fs.mkdtemp(path.join(os.tmpdir(),'shared-assets-'));
process.env.SHARED_BROWSER_STATE=state;
const {rpc}=await import('../rpc.mjs');
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="purple"/></svg>';
const requests=[];
const fixture=http.createServer((req,res)=>{
  if(req.url.endsWith('.svg')){
    const status=req.headers['if-none-match']?304:200;requests.push({url:req.url,status});
    res.writeHead(status,{...(status===200?{'Content-Type':'image/svg+xml'}:{}),'ETag':'"logo"','Cache-Control':'no-cache'});
    return res.end(status===200?svg:undefined);
  }
  res.setHeader('Content-Type','text/html');
  res.end('<!doctype html><title>Cached chart icons</title><svg width="80" height="40"><image href="/logo.svg" width="16" height="16"/></svg><img src="/logo.svg"><button onclick="document.querySelector(\'image\').setAttribute(\'href\',\'/late.svg\')">Change icon</button>');
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const fixtureURL='http://127.0.0.1:'+fixture.address().port;
const origin='http://127.0.0.1:8801';
const headers={'Tailscale-User-Login':'manbir@asgroup.ai'};
let worker,logs='',viewerBrowser;
const sourceBrowser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true});
const wait=async(fn,label)=>{for(let i=0;i<100;i++){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Timed out: '+label+' '+logs);};
const start=async()=>{
  const endpoint=new URL(sourceBrowser.wsEndpoint());
  worker=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname],{env:{...process.env,SHARED_BROWSER_PORT:'8801',SHARED_BROWSER_ORIGIN:origin,SHARED_BROWSER_CDP_URL:'http://'+endpoint.host},stdio:['ignore','ignore','pipe']});
  worker.stderr.on('data',b=>logs+=b);
  await wait(()=>rpc('state'),'receiver');
};
const stop=async()=>{worker.kill('SIGTERM');await new Promise(r=>worker.exitCode!==null?r():worker.once('exit',r));worker=undefined;};
const asset=async(id,url)=>{
  const response=await fetch(`${origin}/asset?tab=${id}&url=${encodeURIComponent(url)}`,{headers,signal:AbortSignal.timeout(4000)});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^image\/svg\+xml/);
  assert.equal(await response.text(),svg);
};
try {
  await start();
  const warm=(await sourceBrowser.pages())[0];await warm.goto(fixtureURL+'/warm');
  await wait(()=>requests.some(r=>r.status===200),'warm cache');
  const source=await sourceBrowser.newPage();
  await wait(async()=>(await rpc('state')).tabs.length===2,'attach blank second tab');
  await source.goto(fixtureURL+'/chart');
  const current=()=>rpc('state').then(s=>s.tabs.find(t=>t.url===fixtureURL+'/chart'));
  await wait(current,'chart navigation');
  await wait(()=>requests.some(r=>r.status===304),'real cached revalidation');
  let id=(await current()).id;
  await asset(id,fixtureURL+'/logo.svg');
  console.log('PASS: new tab captures a real 304 image response after navigation');

  // This recovery instance starts before a new document/resource exists.
  const saved=new Map();
  const recover=await resourceRecovery(()=>source.frames().map(f=>f.client),(url,value)=>saved.set(url,value));
  await recover(fixtureURL+'/logo.svg');
  await source.goto(fixtureURL+'/next');await source.click('button');
  await wait(()=>requests.some(r=>r.url==='/late.svg'),'late icon');
  await wait(async()=>{await recover(fixtureURL+'/late.svg');return saved.has(fixtureURL+'/late.svg');},'recover late resource');
  assert.equal(saved.get(fixtureURL+'/late.svg').bytes.toString(),svg);
  console.log('PASS: fallback discovers cached assets loaded after attachment/navigation');

  const count=requests.length;
  await stop();await start();
  id=(await rpc('state')).tabs.find(t=>t.url===fixtureURL+'/next').id;
  await asset(id,fixtureURL+'/logo.svg');await asset(id,fixtureURL+'/late.svg');
  assert.equal(requests.length,count,'recovery must read existing image bytes without refetching');
  console.log('PASS: receiver reconnect recovers image bytes without reloading or refetching the source');

  // Select the chart through the public RPC so both replay engines see it.
  await rpc('js',{context:'cached-assets',code:`var tab=await cua.getTab('${id}');nodeRepl.write(await tab.getAXState());`});
  for(const engine of process.env.SHARED_BROWSER_WEBKIT_MODULE?['chrome','webkit']:['chrome']){
    const errors=[];
    let page;
    if(engine==='webkit'){
      const {webkit}=await import(process.env.SHARED_BROWSER_WEBKIT_MODULE);
      viewerBrowser=await webkit.launch({headless:true});page=await viewerBrowser.newPage({extraHTTPHeaders:headers});
    }else{
      viewerBrowser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true});page=await viewerBrowser.newPage();await page.setExtraHTTPHeaders(headers);
    }
    page.on('response',r=>{if(r.url().includes('/asset?') && r.status()!==200)errors.push(r.status());});
    await page.goto(origin);
    await page.waitForFunction(()=>document.querySelector('#replay iframe')?.contentDocument?.querySelector('image'));
    const decoded=await page.evaluate(async()=>{
      const doc=document.querySelector('#replay iframe').contentDocument;
      const nodes=[...doc.querySelectorAll('img,image')];
      return Promise.all(nodes.map(node=>new Promise(resolve=>{
        const img=new Image();img.onload=()=>resolve(img.naturalWidth);img.onerror=()=>resolve(0);
        img.src=new URL(node.getAttribute(node.tagName==='image'?'href':'src'),doc.baseURI).href;
      })));
    });
    assert.deepEqual(decoded,[16,16]);assert.deepEqual(errors,[]);
    await page.reload();await page.waitForFunction(()=>document.querySelector('#replay iframe')?.contentDocument?.querySelector('img')?.naturalWidth===16);
    console.log(`PASS: ${engine} viewer decodes SVG and HTML icons before and after reconnect`);
    await viewerBrowser.close();viewerBrowser=undefined;
  }
}finally {
  await viewerBrowser?.close();if(worker)await stop();await sourceBrowser.close();
  await new Promise(r=>fixture.close(r));await fs.rm(state,{recursive:true,force:true});
}
