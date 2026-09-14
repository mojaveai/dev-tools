import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
const source=await fs.readFile(new URL('../control-visibility.js',import.meta.url),'utf8');
const server=http.createServer((req,res)=>{
 if(req.url==='/module.js'){res.setHeader('Content-Type','text/javascript');return res.end(source);}
 res.setHeader('Content-Type','text/html');res.end(`<style>body{margin:0}input{display:block;box-sizing:border-box;height:40px;width:200px}</style><details id="section"><summary><button id="summary">Expand</button></summary><input id="invitation"></details><div style="visibility:hidden"><input id="invisible"></div><div style="height:20px;overflow:hidden"><input id="partial"></div><div style="height:0;overflow:hidden"><input id="clipped"></div><div style="opacity:0"><input id="transparent"></div><input id="replay" style="opacity:0"><script type="module">import {controlVisibility} from '/module.js';window.check=id=>{const v=controlVisibility(document.getElementById(id));return v?{clip:v.clip}:null};</script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true,args:['--disable-dev-shm-usage']});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.check);
 assert.equal(await page.evaluate(()=>check('invitation')),null);
 assert.ok(await page.evaluate(()=>check('summary')));
 await page.evaluate(()=>document.querySelector('details').open=true);
 assert.ok(await page.evaluate(()=>check('invitation')));
 await page.evaluate(()=>document.querySelector('details').open=false);
 assert.equal(await page.evaluate(()=>check('invitation')),null);
 console.log('PASS: collapsed details hides invitation; summary remains usable; open/close updates visibility');
 for(const id of ['invisible','clipped','transparent'])assert.equal(await page.evaluate(id=>check(id),id),null);
 assert.equal((await page.evaluate(()=>check('partial'))).clip,'inset(0px 0px 20px 0px)');
 assert.ok(await page.evaluate(()=>check('replay')));
 console.log('PASS: CSS visibility and ancestor clipping respected; replay opacity does not suppress native input');
}finally{await browser.close();await new Promise(r=>server.close(r));}
