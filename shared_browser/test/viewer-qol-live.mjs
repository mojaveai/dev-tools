import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
const server = http.createServer(async(req,res) => {
  if (req.url === '/passkey-requests') { res.setHeader('Content-Type','application/json');return res.end('[]'); }
  if (['/viewer-transfers.js','/viewer-passkeys.js'].includes(req.url)) {
    res.setHeader('Content-Type','text/javascript');return res.end(await fs.readFile(new URL('..'+req.url,import.meta.url)));
  }
  res.setHeader('Content-Type','text/html');
  res.end('<div id="viewport"></div><script type="module">import {ViewerTransfers} from "/viewer-transfers.js";import {ViewerPasskeys} from "/viewer-passkeys.js";window.transfers=new ViewerTransfers({context:()=>({}),send:()=>{},error:()=>{}});window.passkeys=new ViewerPasskeys();clearInterval(passkeys.timer);</script>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true,args:['--disable-dev-shm-usage']});
try {
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
 await page.waitForFunction(()=>window.passkeys && !passkeys.busy);
 const state={downloads:[{id:'example',name:'sample.txt',status:'completed',url:'/download/example'}]};
 await page.evaluate(s=>transfers.update(s),state);
 assert.equal(await page.$eval('details',e=>e.open),false);
 await page.click('summary');await page.click('button[aria-label="Dismiss sample.txt"]');
 assert.equal(await page.$eval('details',e=>e.hidden),true);
 await page.reload();await page.waitForFunction(()=>window.passkeys && !passkeys.busy);
 await page.evaluate(s=>transfers.update(s),state);
 assert.equal(await page.$eval('details',e=>e.hidden),true);
 console.log('PASS: downloads collapsed; dismissal persists through reload');
 const request={code:'TEST1234',url:'https://procbox.agent-trace.ts.net:23581/_shared-browser-passkey/?request=test',expiresAt:Date.now()+120000};
 await page.evaluate(r=>passkeys.update([r]),request);
 assert.equal(await page.$eval('#passkey-requests a',e=>e.textContent),'Approve with passkey');
 assert.equal(await page.$eval('#passkey-requests a',e=>e.target),'_blank');
 await page.evaluate(()=>passkeys.update([]));
 assert.equal(await page.$$eval('#passkey-requests a',e=>e.length),0);
 await page.evaluate(r=>passkeys.update([{...r,expiresAt:1}]),request);
 assert.equal(await page.$$eval('#passkey-requests a',e=>e.length),0);
 console.log('PASS: approval link appears and clears on completion/expiry');
 await page.evaluate(r=>passkeys.update([{...r,url:'https://example.com/'}]),request);
 assert.equal(await page.$$eval('#passkey-requests a',e=>e.length),0);
 console.log('PASS: unexpected approval origin rejected');
} finally {await browser.close();await new Promise(r=>server.close(r));}
