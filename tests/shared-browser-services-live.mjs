// Linux integration: real Supervisor, isolated fake browser/receiver, and the
// production RPC startup path. No user browser or credentials are touched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'shared-services-test-'));
const state=path.join(temp,'state'), runtime=path.join(temp,'runtime');
await fs.mkdir(runtime);
await fs.writeFile(path.join(runtime,'mcp.mjs'),'// Registration fixture');
await fs.writeFile(path.join(runtime,'browser-host.mjs'),'setInterval(()=>{},1000);');
await fs.writeFile(path.join(runtime,'server.mjs'),`
import http from 'node:http';import fs from 'node:fs';
const socket=process.env.SHARED_BROWSER_STATE+'/server.sock';
try{fs.unlinkSync(socket)}catch{}
http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({engine:'fixture',pid:process.pid}));}).listen(socket);
`);
const env={...process.env,CODEX_HOME:path.join(temp,'codex'),SHARED_BROWSER_REPO:root,SHARED_BROWSER_STATE:state};
const ctl=(...args)=>execFileSync('supervisorctl',['-c',path.join(state,'supervisor.conf'),...args],{encoding:'utf8'});
try {
  execFileSync('python3',[path.join(root,'shared_browser/services.py'),'install',state,runtime,
    process.execPath,'/fixture/chrome','http://localhost','owner@example.test','/fixture/Xvfb','native'],{env});
  const chrome=ctl('pid','chrome').trim();
  execFileSync('python3',[path.join(root,'shared_browser/services.py'),'install',state,runtime,
    process.execPath,'/fixture/chrome','http://localhost','owner@example.test','/fixture/Xvfb','native'],{env});
  assert.equal(ctl('pid','chrome').trim(),chrome);
  console.log('PASS: supervised installer rerun preserves the browser process');
  ctl('shutdown');
  for(let n=0;n<100;n++) {
    try {ctl('pid');}catch{break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  // Receiver intentionally left its stale socket behind, like a killed pod.
  process.env.SHARED_BROWSER_STATE=state;
  const {rpc}=await import('../shared_browser/rpc.mjs');
  const result=await rpc('state');
  assert.equal(result.engine,'fixture');
  assert.notEqual(ctl('pid','chrome').trim(),chrome);
  console.log('PASS: first RPC restarts stopped container services despite a stale socket');
} finally {
  try{ctl('shutdown');}catch{}
  delete process.env.SHARED_BROWSER_STATE;
  // Supervisor has acknowledged shutdown; wait for its owned children to exit.
  for(let n=0;n<100;n++) {
    try {ctl('pid');}catch{break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await fs.rm(temp,{recursive:true,force:true});
}
