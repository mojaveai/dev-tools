// Manual public-demo diagnostic. Alternate a genuinely fresh, unrecorded tab
// with a recorded tab in the same Chrome process/profile. Never read tokens.
// This temporarily stops the installed receiver; finally always starts it again.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import puppeteer from 'puppeteer-core';
const exec=promisify(execFile), sleep=ms=>new Promise(r=>setTimeout(r,ms));
const state=process.env.SHARED_BROWSER_STATE||path.join(os.homedir(),'.local/state/dev-tools/shared-browser');
const endpoint=JSON.parse(await fs.readFile(path.join(state,'browser-host.json'),'utf8'));
const browser=await puppeteer.connect({browserWSEndpoint:endpoint.browserWSEndpoint,defaultViewport:null});
const original=(await browser.pages()).find(p=>p.url()==='https://www.google.com/recaptcha/api2/demo');
const out=await fs.mkdtemp('/tmp/captcha-recorder-control-');await fs.chmod(out,0o700);
let page, trial, seq=0, mode;
const service=action=>exec('systemctl',['--user',action,'dev-tools-shared-browser.service']);
async function point(selector,kind){
  const frame=page.frames().find(f=>f.url().includes(kind==='anchor'?'/anchor':'/bframe'));
  const el=await frame.$(selector), box=await el?.boundingBox();await el?.dispose();
  if(!box)throw Error('Missing observed target');
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2,{delay:0});
}
async function report(command){
  const frames=[];
  for(const f of page.frames())frames.push(await f.evaluate(()=>({
    kind:location.pathname.includes('/anchor')?'anchor':location.pathname.includes('/bframe')?'challenge':'top',
    recording:!!window.__sharedStop,mirror:!!window.__sharedMirror,binding:typeof window.__sharedEmit==='function',
    text:document.body?.innerText,checked:document.querySelector('#recaptcha-anchor')?.getAttribute('aria-checked'),
    images:[...document.images].map(i=>({loaded:i.complete&&!!i.naturalWidth,width:i.naturalWidth,height:i.naturalHeight})),
    webdriver:navigator.webdriver,viewport:[innerWidth,innerHeight],visibility:document.visibilityState,
  })).catch(()=>({detached:true})));
  if(mode==='off' && frames.some(f=>f.recording||f.mirror||f.binding))throw Error('Recorder-off arm contaminated');
  const entry={seq:++seq,time:new Date().toISOString(),trial:{...trial},command,frames};
  await fs.appendFile(path.join(out,'observations.jsonl'),JSON.stringify(entry)+'\n');
  const screenshot=path.join(out,'latest.png');await page.screenshot({path:screenshot,clip:{x:0,y:0,width:520,height:700}});
  await fs.copyFile(screenshot,path.join(out,String(seq).padStart(3,'0')+'.png'));
  console.log(JSON.stringify({...entry,screenshot}));
}
console.log(JSON.stringify({ready:true,out,pid:endpoint.pid}));
try{
  for await(const line of createInterface({input:process.stdin})){
    try{
      const c=JSON.parse(line);if(c.action==='stop')break;
      if(c.action==='start'){
        if(!['on','off'].includes(c.mode))throw Error('Specify recorder on/off');
        // A fresh target after detach has no previous recorder patches or preload.
        await page?.close();await service('stop');
        if(c.mode==='on')await service('start');
        page=await browser.newPage();await page.bringToFront();await page.setViewport({width:1920,height:963});
        mode=c.mode;trial={id:c.id,mode,rounds:0,tiles:0,started:Date.now()};
        await page.goto('https://www.google.com/recaptcha/api2/demo',{waitUntil:'networkidle2'});
        if(mode==='on')await page.waitForFunction(()=>!!window.__sharedStop);
        await page.frames().find(f=>f.url().includes('/anchor')).waitForSelector('#recaptcha-anchor');
        await point('#recaptcha-anchor','anchor');
      }
      if(c.action==='tiles'){
        if(![3,4].includes(c.columns)||!Array.isArray(c.cells)||c.cells.some(n=>!Number.isInteger(n)||n<1||n>c.columns*c.columns))throw Error('Invalid grid');
        for(const cell of c.cells){await point(`tr:nth-child(${Math.ceil(cell/c.columns)}) td:nth-child(${(cell-1)%c.columns+1})`,'challenge');trial.tiles++;}
      }
      if(c.action==='verify'){await point('#recaptcha-verify-button','challenge');trial.rounds++;}
      await sleep(Math.max(0,Math.min(10000,c.waitMs??1200)));await report(c);
    }catch(error){console.log(JSON.stringify({error:error.stack}));}
  }
}finally{
  process.stdin.pause();await page?.close().catch(()=>{});await original?.bringToFront().catch(()=>{});
  await service('start');browser.disconnect();
}
