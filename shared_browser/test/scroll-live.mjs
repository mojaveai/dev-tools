// Isolated full-stack checks for local scroll, source scroll, and coordinate
// input on long pages. No live user site or profile is changed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';
const state=await fs.mkdtemp(path.join(os.tmpdir(),'shared-scroll-'));
process.env.SHARED_BROWSER_STATE=state;
const {rpc}=await import('../rpc.mjs');
const fixture=http.createServer((req,res)=>{
  res.setHeader('Content-Type','text/html');
  res.end(`<style>html{scroll-behavior:smooth}body{margin:0}header{position:sticky;top:0;background:white}a{display:block;height:28px}</style><header><button id="button" onclick="this.textContent='Clicked'">Click me</button><input id="checkbox" type="checkbox"><input id="text" aria-label="Notes"></header>${Array.from({length:1000},(_,i)=>`<a href="#row${i}" id="row${i}">Row ${i}</a>`).join('')}`);
});
await new Promise(r=>fixture.listen(8802,'127.0.0.1',r));
const worker=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname],{env:{...process.env,SHARED_BROWSER_PORT:'8801',SHARED_BROWSER_ORIGIN:'http://127.0.0.1:8801'},stdio:['ignore','ignore','pipe']});
let logs='';worker.stderr.on('data',b=>logs+=b);
let browser,sourceBrowser;
const wait=async(fn,label)=>{for(let n=0;n<100;n++){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Timed out '+label+' '+logs);};
try {
  await wait(()=>rpc('state'),'server');
  await rpc('js',{context:'scroll',code:"var browser=await cua.getBrowser();var tab=await browser.tabs.new('http://127.0.0.1:8802/');"});
  browser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true});
  const viewer=await browser.newPage();await viewer.setViewport({width:800,height:600,hasTouch:true});
  await viewer.setExtraHTTPHeaders({'Tailscale-User-Login':'manbir@asgroup.ai'});await viewer.goto('http://127.0.0.1:8801/');
  await wait(()=>viewer.$('#interaction-layer input'),'viewer');
  const [port]=(await fs.readFile(path.join(state,'profile/DevToolsActivePort'),'utf8')).split('\n');
  sourceBrowser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});
  const source=(await sourceBrowser.pages()).find(p=>p.url().includes(':8802/'));
  await source.evaluate(()=>{window.audit=[];for(const type of ['mousedown','mouseup','click'])addEventListener(type,e=>audit.push({type,target:e.target.id,x:e.clientX,y:e.clientY}));});
  const point=selector=>viewer.$eval('#replay iframe',(f,selector)=>{const r=f.contentDocument.querySelector(selector).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},selector);
  let p=await point('#button');await viewer.mouse.click(p.x,p.y);
  await wait(()=>source.$eval('#button',e=>e.textContent==='Clicked'),'coordinate button');
  await wait(()=>viewer.$eval('#replay iframe',f=>f.contentDocument.querySelector('#button').textContent==='Clicked'),'button layout replay');
  p=await point('#checkbox');await viewer.touchscreen.tap(p.x,p.y);
  await wait(()=>source.$eval('#checkbox',e=>e.checked),'touch checkbox').catch(async error=>{console.log(JSON.stringify({point:p,source:await source.evaluate(()=>({events:audit,box:document.querySelector('#checkbox').getBoundingClientRect().toJSON()})),viewer:await viewer.evaluate(({x,y})=>({target:document.elementFromPoint(x,y)?.outerHTML,error:document.querySelector('#error').textContent}),p)}));throw error;});
  await viewer.type('#interaction-layer input[aria-label="Notes"]','Still editable');
  await wait(()=>source.$eval('#text',e=>e.value==='Still editable'),'native input');
  assert.equal(await viewer.$$eval('#interaction-layer button',a=>a.length),1,'Only the native checkbox needs a form overlay');
  console.log('PASS: mouse button, touch checkbox and native typing work without 1,000 duplicate link overlays');
  await viewer.evaluate(()=>document.querySelector('#interaction-layer').dispatchEvent(new WheelEvent('wheel',{clientX:700,clientY:400,deltaY:500,bubbles:true,cancelable:true})));
  assert.equal(await viewer.$eval('#replay iframe',f=>f.contentWindow.scrollY),500);
  await wait(()=>source.evaluate(()=>scrollY===500),'local scroll forwarded');
  await new Promise(r=>setTimeout(r,1100));
  await source.evaluate(()=>{window.scrollSamples=0;const emit=window.__sharedEmit;window.__sharedEmit=m=>{if(m.event.type===3 && m.event.data.source===3)scrollSamples++;return emit(m);};});
  await source.evaluate(async()=>{for(let n=1;n<=30;n++){await new Promise(requestAnimationFrame);scrollTo({top:500+n*20,behavior:'instant'});}});
  await wait(()=>viewer.$eval('#replay iframe',f=>f.contentWindow.scrollY===1100),'source scroll replay');
  assert.ok(await source.evaluate(()=>scrollSamples>=15),'Source scrolling must not be sampled at only 10 Hz');
  console.log('PASS: immediate local scrolling and frame-rate source scrolling agree despite CSS smooth scrolling');
  await viewer.reload();await wait(()=>viewer.$eval('#replay iframe',f=>f.contentWindow.scrollY===1100),'reconnect position');
  assert.equal(await source.$eval('#text',e=>e.value),'Still editable');
  console.log('PASS: reconnect retains scroll position and form contents');
}finally {
  await sourceBrowser?.disconnect();await browser?.close();worker.kill('SIGTERM');
  await new Promise(r=>worker.exitCode!==null?r():worker.once('exit',r));await new Promise(r=>fixture.close(r));
  await fs.rm(state,{recursive:true,force:true});
}
