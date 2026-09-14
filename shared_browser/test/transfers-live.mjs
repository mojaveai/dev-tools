// Run on the browser host. TEST_PORT/SHARED_BROWSER_STATE allow an isolated server.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { rpc } from '../rpc.mjs';
const base = 'http://127.0.0.1:'+(process.env.TEST_PORT || 8791);
const origin = 'https://procbox.agent-trace.ts.net:8443';
const owner = {'Tailscale-User-Login':'manbir@asgroup.ai'};
const context = 'file-test-'+Date.now();
const js = async code => {
  const result = await rpc('js',{context,code});
  return result.content;
};
const read = async code => JSON.parse((await js('nodeRepl.write(JSON.stringify('+code+'));'))[0].text);
const wait = async fn => {
  for (let i=0;i<80;i++) {const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,75));}
  throw Error('Expected transfer result did not arrive');
};
const open = async () => {
  const ws = new WebSocket(base.replace('http','ws')+'/ws',{origin,headers:owner});
  const messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw)));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const hello=await wait(()=>messages.find(m=>m.type==='hello'));
  return {ws,messages,client:hello.clientId};
};
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shared-transfer-live-'));
let viewer, tab;
let checks=0;
const pass=label=>{checks++;console.log('PASS '+label);};
try {
  await js(`const tab=await cua.createBrowserTab("remote-chrome", ${JSON.stringify(base+'/fixture?file-tests=1')});`);
  tab=await read('await tab.getState()');
  viewer=await open();
  const node=id=>tab.dom.elements.find(e=>e.id===id).node;
  const upload = async ({files=[new File(['viewer upload\n'],'viewer.txt')],client=viewer.client,generation=tab.generation,target=node('upload-single'),headers={},chooser}={}) => {
    const form=new FormData();for(const file of files)form.append('files',file);
    const params=new URLSearchParams({client,tab:tab.id,generation,node:target});if(chooser)params.set('chooser',chooser);
    const response=await fetch(base+'/upload?'+params,{method:'POST',headers:{...owner,Origin:origin,...headers},body:form});
    return {status:response.status,body:await response.json()};
  };
  assert.equal((await upload({headers:{'Tailscale-User-Login':'outsider@example.com'}})).status,403);
  assert.equal((await upload({headers:{Origin:'https://other.example'}})).status,403);
  assert.equal((await upload({client:'missing'})).status,409);
  assert.equal((await upload({generation:'old'})).status,409);
  pass('unauthorized identity/origin and stale connection/document rejected');
  assert.equal((await upload({target:node('message')})).status,400);
  assert.equal((await upload({files:[new File(['1'],'one.txt'),new File(['2'],'two.txt')]})).status,400);
  assert.equal((await upload({files:[new File([new Uint8Array(10*1024*1024+1)],'big.bin')]})).status,400);
  pass('wrong target, single-input multiplicity and oversized files rejected');
  assert.equal((await upload()).status,200);
  const hash=createHash('sha256').update('viewer upload\n').digest('hex');
  await wait(async()=>String(await read("await tab.playwright.locator('#file-result').innerText()")).includes(hash));
  pass('viewer upload exact SHA-256 visible in real page');
  assert.equal((await upload()).status,200);
  await wait(async()=>String(await read("await tab.playwright.locator('#file-result').innerText()")).includes('Selection 2'));
  pass('same file can be selected again');
  assert.equal((await upload({target:node('upload-multiple'),files:[new File(['one'],'same.txt'),new File(['two'],'same.txt')]})).status,200);
  await wait(async()=>String(await read("await tab.playwright.locator('#file-result').innerText()")).includes(createHash('sha256').update('two').digest('hex')));
  pass('multiple files with duplicate names preserve contents');
  const remote=path.join(dir,'agent.txt');await fs.writeFile(remote,'agent upload\n');
  await js(`await tab.setFiles('#upload-single', ${JSON.stringify(remote)});`);
  await wait(async()=>String(await read("await tab.playwright.locator('#file-result').innerText()")).includes(createHash('sha256').update('agent upload\n').digest('hex')));
  pass('agent remote-path upload uses same real input');
  await js("await tab.click('#custom-upload');");
  let state=await rpc('state');let chooser=state.choosers.find(c=>c.tab===tab.id);
  assert.ok(chooser);
  assert.equal((await upload({chooser:chooser.id})).status,200);
  pass('custom picker upload reaches intercepted Chrome input');
  await js("await tab.click('#custom-upload');");
  state=await rpc('state');chooser=state.choosers.find(c=>c.tab===tab.id);
  viewer.ws.send(JSON.stringify({type:'cancelChooser',chooser:chooser.id,tab:tab.id,generation:tab.generation,requestId:'cancel'}));
  await wait(()=>viewer.messages.find(m=>m.requestId==='cancel'&&m.type==='ack'));
  assert.equal((await upload({chooser:chooser.id})).status,400);
  pass('canceled custom picker cannot accept a late upload');
  const beforeCancel=await read("await tab.playwright.locator('#file-result').innerText()");
  const interrupted=http.request(base+'/upload?'+new URLSearchParams({client:viewer.client,tab:tab.id,generation:tab.generation,node:node('upload-single')}),
    {method:'POST',headers:{...owner,Origin:origin,'Content-Type':'multipart/form-data; boundary=slow-test'}});
  interrupted.on('error',()=>{});
  interrupted.write('--slow-test\r\nContent-Disposition: form-data; name="files"; filename="partial.txt"\r\n\r\npartial');
  await new Promise(resolve=>setTimeout(resolve,100));
  interrupted.destroy();
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await read("await tab.playwright.locator('#file-result').innerText()"),beforeCancel);
  pass('aborting an incomplete transfer leaves remote selection unchanged');
  viewer.ws.close();await new Promise(resolve=>viewer.ws.once('close',resolve));
  assert.equal((await upload()).status,409);
  await js("await tab.click('#download-sample');");
  const download=await wait(async()=>(await read('await tab.getDownloads()')).find(d=>d.name==='shared-browser-sample.txt'&&d.status==='completed'));
  assert.equal(await fs.readFile(download.path,'utf8'),'Shared browser download test.\n');
  const saved=await fetch(base+download.url,{headers:owner});assert.equal(await saved.text(),'Shared browser download test.\n');
  assert.match(saved.headers.get('content-disposition'),/^attachment/);
  assert.equal((await fetch(base+download.url)).status,403);
  assert.equal((await fetch(base+'/download/not-a-download',{headers:owner})).status,404);
  pass('disconnected viewer cannot upload; agent download continues, bytes match, private attachment only');
  viewer=await open();
  await wait(()=>viewer.messages.find(m=>m.type==='state'&&m.downloads.some(d=>d.id===download.id)));
  pass('reconnected viewer receives completed download link');
  console.log(`${checks} transfer integration checks passed`);
} finally {
  viewer?.ws.close();
  if(tab)await js('await tab.close();').catch(()=>{});
  await fs.rm(dir,{recursive:true,force:true});
}
