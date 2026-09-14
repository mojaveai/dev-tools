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
 res.end(`<h1 id="route">${req.url==='/done'?'Full navigation done':'Initial page'}</h1><a id="hash" href="#next">Hash route</a><button id="push" onclick="history.pushState({},'', '/pushed');document.querySelector('h1').textContent='Push route done'">Push route</button><a id="full" href="/redirect">Full navigation</a><script>onhashchange=()=>document.querySelector('h1').textContent='Hash route done'</script>`);
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
 const act=async selector=>{const r=await rpc('js',{context:'navigation-test',code:`await tab.click(${JSON.stringify(selector)});nodeRepl.write('clicked');`});assert.ok(!r.isError,JSON.stringify(r));};
 await act('#hash');await wait(()=>rendered('Hash route done'),'hash route without viewer refresh');
 console.log('PASS: hash navigation renders without refresh');
 await act('#push');await wait(()=>rendered('Push route done'),'pushState route without viewer refresh');
 console.log('PASS: pushState navigation renders without refresh');
 await act('#full');await wait(()=>rendered('Full navigation done'),'redirect and new document without viewer refresh');
 console.log('PASS: full navigation and redirect render without refresh');
}finally{
 if(browser)await browser.close();
 worker.kill('SIGTERM');await new Promise(r=>worker.exitCode!==null?r():worker.once('exit',r));
 await new Promise(r=>fixture.close(r));await fs.rm(state,{recursive:true,force:true});
}
