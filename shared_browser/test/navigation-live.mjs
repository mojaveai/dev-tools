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
const fixture=http.createServer((req,res)=>{
 if(req.url==='/redirect'){res.writeHead(302,{Location:'/done'});return res.end();}
 res.setHeader('Content-Type','text/html');
 res.end(`<style>@keyframes spin{to{transform:rotate(360deg)}}.spinner{width:24px;height:24px;border:3px solid gray;border-top-color:blue;border-radius:50%;animation:spin .8s linear infinite}</style><div class="spinner"></div><input aria-label="Test code" style="border:2px solid black;border-right-width:3px;border-bottom-width:4px;border-left-width:5px;outline:1px solid red;box-shadow:0 0 2px black"><h1 id="route">${req.url==='/done'?'Full navigation done':'Initial page'}</h1><a id="hash" href="#next">Hash route</a><button id="push" onclick="history.pushState({},'', '/pushed');document.querySelector('h1').textContent='Push route done'">Push route</button><a id="full" href="/redirect">Full navigation</a><script>onhashchange=()=>document.querySelector('h1').textContent='Hash route done'</script>`);
});
await new Promise(r=>fixture.listen(8802,'127.0.0.1',r));
const worker=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname],{env:{...process.env,SHARED_BROWSER_PORT:'8801',SHARED_BROWSER_ORIGIN:origin},stdio:['ignore','pipe','pipe']});
let logs='';worker.stderr.on('data',b=>logs+=b);
let browser;
const wait=async(fn,label)=>{for(let i=0;i<100;i++){try{if(await fn())return;}catch{}await new Promise(r=>setTimeout(r,75));}throw Error('Timed out: '+label);};
try {
 await wait(()=>rpc('state'),'isolated server '+logs);
 await rpc('js',{context:'navigation-test',code:"const browser=await cua.getBrowser();const tab=await browser.tabs.new('http://127.0.0.1:8802/');nodeRepl.write('ready');"});
 browser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true,args:['--disable-dev-shm-usage']});
 const page=await browser.newPage();await page.setExtraHTTPHeaders({'Tailscale-User-Login':'manbir@asgroup.ai'});
 await page.goto(origin);
 const rendered=label=>page.$eval('#replay iframe',(e,label)=>e.contentDocument?.body?.textContent.includes(label),label);
 await wait(()=>rendered('Initial page'),'initial viewer snapshot');
 const footprint=()=>page.$eval('#viewport',e=>({top:e.getBoundingClientRect().top,width:e.getBoundingClientRect().width}));
 assert.deepEqual(await footprint(),{top:0,width:800});
 assert.equal(await page.$eval('#viewer-toolbar',e=>e.hidden),true);
 await page.click('#viewer-handle');
 assert.equal(await page.$eval('#viewer-toolbar',e=>e.hidden),false);
 assert.deepEqual(await footprint(),{top:0,width:800});
 await page.keyboard.press('Escape');
 assert.equal(await page.$eval('#viewer-toolbar',e=>e.hidden),true);
 console.log('PASS: floating controls do not consume page space or resize the website');

 const act=async selector=>{const r=await rpc('js',{context:'navigation-test',code:`await tab.click(${JSON.stringify(selector)});nodeRepl.write('clicked');`});assert.ok(!r.isError,JSON.stringify(r));};
 const spinner=()=>page.$eval('#replay iframe',e=>{
  const d=e.contentDocument,s=d.defaultView.getComputedStyle(d.querySelector('.spinner'));
  return {state:s.animationPlayState,transform:s.transform};
 });
 const first=await spinner();
 assert.equal(first.state,'running','Live replay must not pause CSS animations');
 await new Promise(r=>setTimeout(r,150));
 assert.notEqual((await spinner()).transform,first.transform,'Spinner must advance without new DOM events');
 console.log('PASS: CSS spinner advances in idle live viewer');
 await act('#hash');await wait(()=>rendered('Hash route done'),'hash route without viewer refresh');
 console.log('PASS: hash navigation renders without refresh');
 await act('#push');await wait(()=>rendered('Push route done'),'pushState route without viewer refresh');
 console.log('PASS: pushState navigation renders without refresh');
 await act('#full');await wait(()=>rendered('Full navigation done'),'redirect and new document without viewer refresh');
 assert.equal(await page.$eval('.agent-feedback',e=>e.classList.contains('visible')),false,'Navigation must clear the previous document highlight');
 console.log('PASS: full navigation and redirect render without refresh');
 const border=await page.$eval('#controls input[aria-label="Test code"]',e=>{
  const s=getComputedStyle(e);return [s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth,s.outlineWidth];
 }).catch(async()=>page.$eval('input[aria-label="Test code"]',e=>{
  const s=getComputedStyle(e);return [s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth,s.outlineWidth];
 }));
 assert.deepEqual(border,['2px','3px','4px','5px','1px']);
 console.log('PASS: native overlay preserves asymmetric borders and outline');
 await rpc('js',{context:'navigation-test',code:"const next=await browser.tabs.new('http://127.0.0.1:8802/');nodeRepl.write('new tab');"});
 await wait(()=>rendered('Initial page'),'new tab rendered');
 await wait(()=>page.$eval('#replay iframe',(e,width)=>Number(e.width)===width,800),'new tab fits connected viewer');
 console.log('PASS: new agent tab adopts connected viewer width without reconnect');
 await page.setViewport({width:390,height:700});
 await wait(()=>page.$eval('#replay iframe',e=>Number(e.width)===390),'phone width');
 await page.click('#viewer-handle');
 assert.equal(await page.$eval('#viewer-toolbar',e=>e.hidden),false);
 assert.deepEqual(await footprint(),{top:0,width:390});
 await page.click('#viewer-close');
 assert.equal(await page.$eval('#viewer-toolbar',e=>e.hidden),true);
 console.log('PASS: phone-sized controls open and close without reducing page area');


}finally{
 if(browser)await browser.close();
 worker.kill('SIGTERM');await new Promise(r=>worker.exitCode!==null?r():worker.once('exit',r));
 await new Promise(r=>fixture.close(r));await fs.rm(state,{recursive:true,force:true});
}
