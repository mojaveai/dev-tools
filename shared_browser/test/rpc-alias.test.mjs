import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {installRpcAlias} from '../rpc-alias.mjs';

test('old fixed-path clients reach the selected receiver across restart and migration',async()=>{
  // macOS's default temp directory can exceed the Unix socket path limit once
  // the legacy directory suffix is appended.
  const home=await fs.mkdtemp('/tmp/shared-rpc-');
  const alias=path.join(home,'.local/state/dev-tools/shared-browser/server.sock');
  let server;
  const start=async(stateDir,label)=>{
    await fs.mkdir(stateDir,{recursive:true});
    server=http.createServer((req,res)=>res.end(label));
    await new Promise(r=>server.listen(path.join(stateDir,'server.sock'),r));
  };
  const stop=()=>new Promise(r=>server.close(r));
  const oldClient=()=>new Promise((resolve,reject)=>{
    http.get({socketPath:alias,path:'/state'},res=>{let data='';res.on('data',b=>data+=b);res.on('end',()=>resolve(data));}).on('error',reject);
  });
  try{
    const primary=path.join(home,'primary');await start(primary,'primary');
    await installRpcAlias({stateDir:primary,home});assert.equal(await oldClient(),'primary');
    await stop();await start(primary,'restarted');assert.equal(await oldClient(),'restarted');
    await installRpcAlias({stateDir:primary,home});assert.equal(await oldClient(),'restarted');
    await stop();const next=path.join(home,'next');await start(next,'next');
    await installRpcAlias({stateDir:next,home});assert.equal(await oldClient(),'next');
    await fs.unlink(alias);await fs.writeFile(alias,'occupied');
    await assert.rejects(installRpcAlias({stateDir:next,home}),/occupied/);
    assert.equal(await fs.readFile(alias,'utf8'),'occupied');
    await installRpcAlias({stateDir:path.dirname(alias),home});
    assert.equal(await fs.readFile(alias,'utf8'),'occupied','default profile never creates a self-link');
  }finally{if(server?.listening)await stop();await fs.rm(home,{recursive:true,force:true});}
});
