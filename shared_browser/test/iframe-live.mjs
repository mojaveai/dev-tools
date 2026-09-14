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
 if(req.url.startsWith('/image.png')){res.setHeader('Content-Type','image/png');return res.end(image);}
 res.setHeader('Content-Type','text/html');res.end(`<body><button style="position:absolute;left:20px;top:100px" onclick="document.querySelector('#result').textContent='Child clicked';document.querySelector('img').src='/image.png?changed'">Child button</button><div id="result">Child ready</div><script>setTimeout(()=>{let i=new Image();i.src='/image.png';document.body.append(i)},500)</script>`);
});
const fixture=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<h1>Frame fixture</h1><iframe width="400" height="300" id="child" sandbox="allow-scripts allow-same-origin"></iframe><script>setTimeout(()=>document.querySelector("#child").src="http://localhost:8803/",1500)</script>');});
await new Promise(r=>child.listen(8803,r));
await new Promise(r=>fixture.listen(8802,'127.0.0.1',r));
const worker=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname],{env:{...process.env,SHARED_BROWSER_PORT:'8801',SHARED_BROWSER_ORIGIN:origin},stdio:['ignore','pipe','pipe']});
let logs='';worker.stderr.on('data',b=>logs+=b);
let browser;
const wait=async(fn,label)=>{for(let i=0;i<100;i++){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,75));}throw Error('Timed out: '+label);};
try {
 await wait(()=>rpc('state'),'isolated server '+logs);
 await rpc('js',{context:'navigation-test',code:"const browser=await cua.getBrowser();const tab=await browser.tabs.new('http://127.0.0.1:8802/');nodeRepl.write('ready');"});
 browser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true,args:['--disable-dev-shm-usage']});
 const page=await browser.newPage();page.on('console',m=>console.log('VIEWER',m.type(),m.text().slice(0,300)));page.on('pageerror',e=>console.log(e.message));await page.setExtraHTTPHeaders({'Tailscale-User-Login':'manbir@asgroup.ai'});
 await page.goto(origin);

 const frameData=()=>page.$eval('#replay iframe',e=>{const f=e.contentDocument?.querySelector('iframe'),d=f?.contentDocument;return {text:d?.body?.textContent,images:d?[...d.images].map(i=>({width:i.naturalWidth,src:i.src})):[]};});
 await wait(async()=>(await frameData()).images.some(i=>i.width>0),'child image rendering').catch(async e=>{console.log(await frameData());throw e;});
 console.log('PASS: cross-origin child image renders');
 await page.reload();
 await wait(async()=>(await frameData()).images.some(i=>i.width>0),'child image after reconnect');
 console.log('PASS: child image survives reconnect');
 const point=await page.$eval('#replay iframe',e=>{const f=e.contentDocument.querySelector('iframe'),r=f.getBoundingClientRect(),button=f.contentDocument.querySelector('button').getBoundingClientRect();return {x:r.x+f.clientLeft+button.x+10,y:r.y+f.clientTop+button.y+10};});
 await page.mouse.click(point.x,point.y);
 await wait(async()=>(await frameData()).text.includes('Child clicked'),'human coordinate click inside frame');
 console.log('PASS: human clicks land on intended child element');
 await wait(async()=>(await frameData()).images.some(i=>i.width>0 && i.src.includes('changed')),'dynamic replacement image');
 console.log('PASS: replacement image loads after human action');

}finally{
 if(browser)await browser.close();
 worker.kill('SIGTERM');await new Promise(r=>worker.exitCode!==null?r():worker.once('exit',r));
 await new Promise(r=>fixture.close(r));await new Promise(r=>child.close(r));await fs.rm(state,{recursive:true,force:true});
}
