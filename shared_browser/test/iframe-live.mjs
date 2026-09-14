// Isolated browser/server/fixture: never navigates or submits a real portal.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';
const state=await fs.mkdtemp(path.join(os.tmpdir(),'shared-nav-'));
process.env.SHARED_BROWSER_STATE=state;
const {rpc}=await import('../rpc.mjs');
const origin='http://127.0.0.1:8801';
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5mUAAAAASUVORK5CYII=','base64');
const child=http.createServer((req,res)=>{
 if(req.url.startsWith('/image.png')){res.setHeader('Content-Type','image/png');return setTimeout(()=>res.end(image),700);}
 if(req.url==='/icons.css'){res.setHeader('Content-Type','text/css');return res.end('button {background-image:url(http://127.0.0.1:8803/image.png?icon);background-size:20px 20px;}');}
 res.setHeader('Content-Type','text/html');res.end(`<link rel="stylesheet" href="http://127.0.0.1:8803/icons.css"><body><button style="position:absolute;left:20px;top:100px" onclick="document.querySelector('#result').textContent='Child clicked';document.querySelector('img').src='/image.png?changed'">Child button</button><div id="result">Child ready</div><script>setTimeout(()=>{let i=new Image();i.src='/image.png';document.body.append(i)},500)</script>`);
});
const fixture=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><h1>Frame fixture</h1><iframe width="400" height="300" id="child" sandbox="allow-scripts allow-same-origin"></iframe><script>setTimeout(()=>document.querySelector("#child").src="http://localhost:8803/",1500)</script>');});
await new Promise(r=>child.listen(8803,r));
await new Promise(r=>fixture.listen(8802,'127.0.0.1',r));
const worker=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname],{env:{...process.env,SHARED_BROWSER_PORT:'8801',SHARED_BROWSER_ORIGIN:origin},stdio:['ignore','pipe','pipe']});
let logs='';worker.stderr.on('data',b=>logs+=b);
let browser,sourceBrowser;
const wait=async(fn,label)=>{for(let i=0;i<100;i++){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,75));}throw Error('Timed out: '+label);};
try {
 await wait(()=>rpc('state'),'isolated server '+logs);
 await rpc('js',{context:'navigation-test',code:"const browser=await cua.getBrowser();const tab=await browser.tabs.new('http://127.0.0.1:8802/');nodeRepl.write('ready');"});
 browser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true,args:['--disable-dev-shm-usage']});
 const page=await browser.newPage();page.on('console',m=>console.log('VIEWER',m.type(),m.text().slice(0,300)));page.on('pageerror',e=>console.log(e.message));await page.setExtraHTTPHeaders({'Tailscale-User-Login':'manbir@asgroup.ai'});
 await page.goto(origin);

 const frameData=()=>page.$eval('#replay iframe',e=>{const f=e.contentDocument?.querySelector('iframe'),d=f?.contentDocument;return {text:d?.body?.textContent,images:d?[...d.images].map(i=>({width:i.naturalWidth,src:i.src})):[]};});
 await wait(async()=>(await frameData()).images.some(i=>i.width>0),'child image rendering').catch(async e=>{console.log(await frameData());throw e;});
 console.log('PASS: delayed cross-origin child image renders without refresh');
 const background=await page.$eval('#replay iframe',e=>{const d=e.contentDocument.querySelector('iframe').contentDocument;return d.defaultView.getComputedStyle(d.querySelector('button')).backgroundImage;});
 assert.ok(background.includes('/asset?'),background);
 const iconStatus=await page.evaluate(async value=>{const url=value.slice(5,-2);return (await fetch(url)).status;},background);assert.equal(iconStatus,200);
 console.log('PASS: external stylesheet icons use the authenticated asset relay');
 await page.reload();
 await wait(async()=>(await frameData()).images.some(i=>i.width>0),'child image after reconnect');
 console.log('PASS: child image survives reconnect');
 const [debugPort]=(await fs.readFile(path.join(state,'profile/DevToolsActivePort'),'utf8')).split('\n');
 sourceBrowser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+debugPort,defaultViewport:null});
 const sourcePage=(await sourceBrowser.pages()).find(p=>p.url().includes(':8802'));
 const sourceFrame=sourcePage.frames().find(f=>f.url().includes(':8803'));
 const auditDOM=(doc)=>{
   const measure=e=>{const r=e.getBoundingClientRect(),c=doc.defaultView.getComputedStyle(e);return {tag:e.tagName,x:r.x,y:r.y,width:r.width,height:r.height,display:c.display,visibility:c.visibility,opacity:c.opacity,font:c.font,border:c.border,backgroundColor:c.backgroundColor,hasBackground:c.backgroundImage!=='none',...(e.tagName==='IMG'?{loaded:e.complete&&e.naturalWidth>0,naturalWidth:e.naturalWidth,naturalHeight:e.naturalHeight}:{})};};
   return [...doc.querySelectorAll('button,img')].map(measure);
 };
 // Replay hit-testing may ignore embedded frames even though Chrome accepts
 // pointer input there. Human coordinates must survive that discrepancy.
 await page.$eval('#replay iframe',e=>{e.contentDocument.querySelector('iframe').style.pointerEvents='none';});
 const point=await page.$eval('#replay iframe',e=>{const f=e.contentDocument.querySelector('iframe'),r=f.getBoundingClientRect(),button=f.contentDocument.querySelector('button').getBoundingClientRect();return {x:r.x+f.clientLeft+button.x+10,y:r.y+f.clientTop+button.y+10};});
 await page.mouse.click(point.x,point.y);
 await wait(async()=>(await frameData()).text.includes('Child clicked'),'human coordinate click inside frame').catch(async e=>{console.log({point,source:await sourceFrame.evaluate(`(${auditDOM.toString()})(document)`),viewer:await page.evaluate(`(${auditDOM.toString()})(document.querySelector('#replay iframe').contentDocument.querySelector('iframe').contentDocument)`),error:await page.$eval('#error',e=>e.textContent)});throw e;});
 console.log('PASS: human clicks land on intended child element');
 await wait(async()=>(await frameData()).images.some(i=>i.width>0 && i.src.includes('changed')),'dynamic replacement image');
 console.log('PASS: replacement image loads after human action');
 const sourceAudit=await sourceFrame.evaluate(`(${auditDOM.toString()})(document)`);
 const viewerAudit=await page.evaluate(`(${auditDOM.toString()})(document.querySelector('#replay iframe').contentDocument.querySelector('iframe').contentDocument)`);
 assert.deepEqual(viewerAudit,sourceAudit);
 console.log('PASS: source and shared frame controls/images match geometry, styles, visibility and decoded dimensions');
 assert.equal(await page.$eval('#replay iframe',e=>e.contentDocument.compatMode),await sourcePage.evaluate(()=>document.compatMode));
 console.log('PASS: source document layout mode is preserved');


}finally{
 if(sourceBrowser)await sourceBrowser.disconnect();
 if(browser)await browser.close();
 worker.kill('SIGTERM');await new Promise(r=>worker.exitCode!==null?r():worker.once('exit',r));
 await new Promise(r=>fixture.close(r));await new Promise(r=>child.close(r));await fs.rm(state,{recursive:true,force:true});
}
