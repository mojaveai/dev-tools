import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
const module=await fs.readFile(new URL('../foreign-object.js',import.meta.url),'utf8');
const server=http.createServer((req,res)=>{
  if(req.url==='/module.js'){res.setHeader('Content-Type','text/javascript');return res.end(module);}
  res.setHeader('Content-Type','text/html');
  res.end(`<style>body{margin:0}a{font:11px/1 Arial;display:block}foreignObject{overflow:visible}</style><svg width="800" height="400">
  ${[-60,25,90].map((angle,i)=>`<g transform="translate(${150+i*210} 210) scale(1.2)"><foreignObject id="f${i}" x="-15" y="6" width="90" height="12"><div style="display:flex;justify-content:end;transform:translateY(-50%)"><div style="transform:rotate(${angle}deg);transform-origin:100% 50%"><a href="#${i}">A chart label<br>with two lines</a></div></div></foreignObject></g>`).join('')}
  <foreignObject id="branch" width="100" height="40"><div style="transform:rotate(20deg)"><span>A</span><span>B</span></div></foreignObject>
  </svg><script type="module">import {ForeignObjectTransforms} from '/module.js';window.repair=new ForeignObjectTransforms(document);window.boxes=()=>[...document.querySelectorAll('a')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]});</script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true});
const close=(a,b)=>a.forEach((r,i)=>r.forEach((v,j)=>assert.ok(Math.abs(v-b[i][j])<.1,`${i}/${j}: ${v} vs ${b[i][j]}`)));
try {
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.repair);
  const before=await page.evaluate(()=>boxes());
  await page.evaluate(()=>{window.original=[...document.querySelectorAll('a')];repair.refresh();});
  close(before,await page.evaluate(()=>boxes()));
  assert.equal(await page.evaluate(()=>repair.entries.size),3);
  assert.equal(await page.$eval('#branch',e=>e.parentElement.tagName),'svg');
  assert.equal(await page.evaluate(()=>original.every(e=>e.isConnected)),true);
  console.log('PASS: multiline labels, translated/scaled SVGs, and three rotation angles preserve geometry and original link nodes');
  await page.evaluate(()=>repair.refresh());
  assert.equal(await page.evaluate(()=>repair.entries.size),3);
  const mutation=await page.evaluate(()=>{
    const f=document.querySelector('#f0'),entry=repair.entries.get(f);repair.restore(entry);repair.entries.delete(f);
    f.querySelector('a').textContent='Updated longer label';f.querySelector('div div').style.transform='rotate(-30deg)';
    const expected=boxes();repair.refresh();return {expected,actual:boxes()};
  });
  close(mutation.expected,mutation.actual);
  const incremental=await page.evaluate(()=>{
    const f=document.querySelector('#f0');f.querySelector('div div').style.transform='rotate(15deg)';
    f.querySelector('a').textContent='Changed by incremental replay';repair.refresh();const actual=boxes();
    const entry=repair.entries.get(f);repair.restore(entry);repair.entries.delete(f);const expected=boxes();repair.refresh();
    return {actual,expected};
  });
  close(incremental.expected,incremental.actual);
  const forced=await page.evaluate(()=>{const before=boxes();repair.refresh(true);return {before,after:boxes()};});
  close(forced.before,forced.after);
  await page.evaluate(()=>{document.querySelector('#f1').remove();repair.refresh();});
  assert.equal(await page.evaluate(()=>repair.entries.size),2);
  console.log('PASS: mutations and repeated resize repair do not compound transforms; removed labels release wrappers');
}finally{await browser.close();await new Promise(r=>server.close(r));}
