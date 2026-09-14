import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
const source=(await fs.readFile(new URL('../agent-pointer.js',import.meta.url),'utf8')).replace("import './agent-pointer.css';",'');
const css=await fs.readFile(new URL('../agent-pointer.css',import.meta.url),'utf8');
const server=http.createServer((req,res)=>{
 if(req.url==='/pointer.js'){res.setHeader('Content-Type','text/javascript');res.end(source);return;}
 res.setHeader('Content-Type','text/html');res.end(`<style>${css}</style><div id="root"></div><script type="module">import {AgentPointer} from '/pointer.js';window.pointer=new AgentPointer(document.querySelector('#root'));window.rect={x:200,y:150,width:80,height:40};window.resolve=()=>rect;window.start=id=>pointer.handle({id,node:1,phase:'start',kind:'click',duration:240,x:240,y:170},resolve);window.done=id=>pointer.handle({id,node:1,phase:'done',kind:'click'},resolve);</script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true,args:['--disable-dev-shm-usage']});
try {
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.pointer);
 await page.evaluate(()=>start('a'));await page.waitForFunction(()=>!pointer.moving);
 await page.evaluate(()=>{rect=null;done('a');pointer.refresh();});
 assert.deepEqual(await page.evaluate(()=>pointer.position),{x:240,y:170});
 assert.equal(await page.$eval('.agent-cursor',e=>getComputedStyle(e).opacity),'1');
 assert.equal(await page.$eval('.agent-target',e=>e.hidden),true);
 console.log('PASS: removed click target retains visible cursor at click point');
 await page.evaluate(()=>{rect={x:600,y:400,width:80,height:40};pointer.refresh();});
 assert.deepEqual(await page.evaluate(()=>pointer.position),{x:240,y:170});
 console.log('PASS: post-click layout changes cannot move the completed pointer');
 const continuity=await page.evaluate(async()=>{
  start('b');await new Promise(r=>setTimeout(r,70));const before={...pointer.position};
  start('c');const after={...pointer.position};return {before,after};
 });
 assert.deepEqual(continuity.before,continuity.after);
 await page.waitForFunction(()=>!pointer.moving);
 assert.deepEqual(await page.evaluate(()=>pointer.position),{x:640,y:420});
 console.log('PASS: interrupted movement continues from the visible position');
 await page.evaluate(()=>{rect={x:100,y:100,width:80,height:40};start('d');});
 await page.evaluate(()=>{rect={x:120,y:80,width:80,height:40};pointer.refresh();});
 await page.waitForFunction(()=>!pointer.moving);
 assert.deepEqual(await page.evaluate(()=>pointer.position),{x:160,y:100});
 await page.evaluate(()=>done('d'));
 assert.equal(await page.$eval('.agent-ripple',e=>e.style.left),'160px');
 console.log('PASS: moving target and click ripple agree on final coordinates');
 await page.waitForFunction(()=>pointer.target.hidden);
 assert.equal(await page.$eval('.agent-cursor',e=>getComputedStyle(e).opacity),'1');
 console.log('PASS: completed outline expires while the cursor remains visible');
 await page.evaluate(()=>{start('e');pointer.reset();done('e');});
 assert.equal(await page.$eval('.agent-feedback',e=>e.classList.contains('visible')),false);
 assert.equal(await page.$eval('.agent-target',e=>e.hidden),true);
 console.log('PASS: document reset cannot be revived by a late completion');
}finally{await browser.close();await new Promise(r=>server.close(r));}
