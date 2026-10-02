// Isolated Chrome + owned HTTPS fixture; uses dummy credentials only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import puppeteer from 'puppeteer-core';
import {passwordFields,applyPasswordFields,PasswordFill} from '../password-fill.mjs';
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'password-fill-qa-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(scratch,'key.pem'),
  '-out',path.join(scratch,'cert.pem'),'-subj','/CN=localhost','-days','1'],{stdio:'ignore'});
const html='<form><label>Username<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label></form><script>const nodes=[...document.querySelectorAll("input")];window.__sharedMirror={getId:e=>nodes.indexOf(e)+1,getNode:id=>nodes[id-1]};</script>';
const server=https.createServer({key:await fs.readFile(path.join(scratch,'key.pem')),cert:await fs.readFile(path.join(scratch,'cert.pem'))},(req,res)=>{
  res.setHeader('Content-Type',req.url==='/robots.txt'?'text/plain':'text/html');res.end(req.url==='/robots.txt'?'User-agent: *':html);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='https://localhost:'+server.address().port;
let browser,viewerBrowser,viewerServer;
try {
  browser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless:true,acceptInsecureCerts:true,userDataDir:path.join(scratch,'profile')});
  const page=await browser.newPage();
  const values={username:'dummy-user',password:'dummy-password'};
  const load=async()=>{await page.goto(origin+'/login');return page.evaluate(passwordFields);};
  let form=await load();assert.equal(form.fields.length,2);
  assert.deepEqual(await page.evaluate(applyPasswordFields,{...form,values}),{filled:true});
  assert.equal(await page.$eval('input[type=password]',e=>e.value),values.password);
  // A controlled form re-renders every input from committed state. An email
  // change must not reset a password which has not received its input event yet.
  await page.evaluate(()=>{
    const nodes=[...document.querySelectorAll('input')];
    const state={username:'previous-user',password:'previous-password'};
    for(const node of nodes) {
      node.value=state[node.name];
      node.addEventListener('input',()=>{
        state[node.name]=node.value;
        for(const field of nodes)field.value=state[field.name];
      });
    }
  });
  assert.deepEqual(await page.evaluate(applyPasswordFields,{...form,values}),{filled:true});
  assert.equal(await page.$eval('input[type=password]',e=>e.value),values.password);
  form=await load();
  await page.evaluate(()=>document.querySelector('input[name=username]').addEventListener('input',()=>{
    document.querySelector('form').action='https://other.invalid/login';
  }));
  await assert.rejects(page.evaluate(applyPasswordFields,{...form,values}),/changed/);
  assert.equal(await page.$eval('input[type=password]',e=>e.value),'');
  form=await load();
  await page.evaluate(()=>document.querySelector('input[type=password]').addEventListener('input',event=>{
    setTimeout(()=>event.target.value='',0);
  }));
  await assert.rejects(page.evaluate(applyPasswordFields,{...form,values}),/did not keep/);
  for(const mutate of [()=>{document.querySelector('form').action='https://other.invalid/login';},
    ()=>{document.querySelector('input[type=password]').disabled=true;},
    ()=>{document.querySelector('input[type=password]').replaceWith(document.createElement('input'));},
    ()=>{history.replaceState(null,'','/changed');}]) {
    form=await load();await page.evaluate(mutate);
    await assert.rejects(page.evaluate(applyPasswordFields,{...form,values}),/changed/);
    assert.equal(await page.$eval('input[name=username]',e=>e.value),'');
  }
  await load();await page.$eval('input[type=password]',e=>e.autocomplete='new-password');
  await assert.rejects(page.evaluate(passwordFields),/creating or changing/);
  const helper=await fs.readFile(new URL('../safari-auth/extension/password.js',import.meta.url),'utf8');
  await page.goto(origin+'/robots.txt');
  await page.evaluate(request=>{window.sent=[];window.chrome={runtime:{sendMessage:async msg=>{
    if(msg.type==='ready')return {request};window.sent.push(structuredClone(msg));return {filled:true};
  }}};},{id:'test-request',kind:'password',origin,viewer:'https://fixture.ts.net:8443',fields:[{role:'username'},{role:'password'}],expiresAt:Date.now()+120000});
  await page.evaluate(helper);await page.waitForSelector('#password');
  assert.equal(await page.$eval('#password',e=>e.autocomplete),'current-password');
  await page.type('#username',values.username);await page.type('#password',values.password);
  // Real browser submit is trusted; site-generated submit events are rejected.
  await page.evaluate(()=>document.querySelector('form').dispatchEvent(new Event('submit',{cancelable:true})));
  assert.equal(await page.evaluate(()=>window.sent.length),0);
  await page.click('form button:first-of-type');
  await page.waitForFunction(()=>window.sent.length===1);
  const sent=await page.evaluate(()=>window.sent[0]);assert.equal(sent.type,'complete');assert.deepEqual(sent.values,values);
  await page.waitForFunction(()=>document.querySelector('#password').value==='');
  console.log('PASS: real Chrome field binding, stale-form rejection, native autofill form, trusted completion, and clearing');

  // Exercise the actual installed extension's isolated worlds, signed pending
  // feed, helper injection, HTTPS delivery, and automatic return in a fresh profile.
  await load();
  const key=Buffer.alloc(32,42),viewer='https://password-fill-qa.ts.net:8443';
  const fill=new PasswordFill({key,viewer,getTab:()=>({generation:'qa',page}),active:()=> 'qa',serial:fn=>fn()});
  const reply=(res,body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  viewerServer=https.createServer({key:await fs.readFile(path.join(scratch,'key.pem')),cert:await fs.readFile(path.join(scratch,'cert.pem'))},async(req,res)=>{
    try {
      if(req.url==='/') {
        res.setHeader('Content-Type','text/html');
        res.end('<button id="fill-password">Fill saved password</button><div id="error"></div><script>document.querySelector("button").onclick=async()=>{const r=await fetch("/start",{method:"POST"}).then(r=>r.json());const b=document.querySelector("button");b.dataset.passwordCode=r.code;b.dataset.passwordOrigin=r.origin;document.dispatchEvent(new CustomEvent("devtools-password-request"));};</script>');return;
      }
      if(req.url==='/start') return reply(res,await fill.start({tab:'qa',generation:'qa'}));
      if(req.url==='/auth-companion/password-pending')return reply(res,fill.pending());
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const action=req.url.endsWith('complete')?'complete':'cancel';
      reply(res,await fill.finish(action,JSON.parse(Buffer.concat(chunks).toString())));
    } catch(error) {reply(res,{error:error.message},409);}
  });
  await new Promise((resolve,reject)=>{viewerServer.once('error',reject);viewerServer.listen(8443,'127.0.0.1',resolve);});
  const extension=path.join(scratch,'extension');
  execFileSync('python3',['-c',`import importlib.util; from pathlib import Path; s=Path(${JSON.stringify(path.resolve('safari-auth'))}); spec=importlib.util.spec_from_file_location('builder',s/'build-extensions.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); m.build(s,'2a'*32,Path(${JSON.stringify(extension)}),'chrome')`]);
  viewerBrowser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless:true,enableExtensions:true,userDataDir:path.join(scratch,'viewer-profile'),
    // Only this isolated fixture browser trusts its disposable test certificate.
    args:['--ignore-certificate-errors','--no-proxy-server','--host-resolver-rules=MAP password-fill-qa.ts.net 127.0.0.1']});
  await viewerBrowser.installExtension(extension);
  const viewerPage=await viewerBrowser.newPage();await viewerPage.goto(viewer+'/');
  await viewerPage.waitForFunction(()=>document.querySelector('#fill-password')?.dataset.authPasswordConnected==='true');
  await viewerPage.click('#fill-password');
  await viewerPage.waitForFunction(()=>location.pathname==='/robots.txt');
  await viewerPage.waitForSelector('#password');
  assert.equal(new URL(viewerPage.url()).origin,origin);
  // Password-manager selection emits synthetic change events and should
  // complete without an extra button press or native form submission.
  await viewerPage.evaluate(values=>{
    for(const [role,value] of Object.entries(values)) {
      const input=document.getElementById(role);input.value=value;
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    }
  },values);
  await viewerPage.waitForFunction(expected=>location.href===expected,{},viewer+'/');
  assert.equal(await page.$eval('input[name=username]',e=>e.value),values.username);
  assert.equal(await page.$eval('input[type=password]',e=>e.value),values.password);
  assert.equal(fill.pending().length,0);
  console.log('PASS: actual Chrome extension opens at real origin, fills original browser once, and returns automatically');
} finally {
  await viewerBrowser?.close();await browser?.close();
  if(viewerServer?.listening)await new Promise(r=>viewerServer.close(r));
  await new Promise(r=>server.close(r));await fs.rm(scratch,{recursive:true,force:true});
}
