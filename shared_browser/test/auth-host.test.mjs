import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createAuthHost,hostToken,mac,signedRequest,proofValid} from '../auth-host.mjs';
const key=Buffer.alloc(32,7),viewer='https://coder-x.asg.ts.net:8443',origin='https://auth.nebius.com';
function call(port,method,path,{body,token,host='localhost:8811'}={}){
 return new Promise((resolve,reject)=>{const req=http.request({port,method,path,headers:{host,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(d||'null')}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
}
async function setup(){const {server}=createAuthHost({key,viewer});await new Promise(r=>server.listen(0,'127.0.0.1',r));return {server,port:server.address().port};}
const options=(extra={})=>({challenge:'Y2hhbGxlbmdl',rpId:'nebius.com',extensions:{remoteDesktopClientOverride:{origin,sameOriginWithAncestors:true}},...extra});
const response=(challenge='Y2hhbGxlbmdl')=>({type:'public-key',id:'cred',response:{clientDataJSON:Buffer.from(JSON.stringify({type:'webauthn.get',origin,challenge,crossOrigin:false})).toString('base64url')}});

test('host routes require the derived host token and loopback Host header',async()=>{
 const {server,port}=await setup();
 assert.equal((await call(port,'POST','/host/start',{body:{kind:'get',options:options()}})).status,403);
 assert.equal((await call(port,'POST','/host/start',{body:{kind:'get',options:options()},token:'f'.repeat(64)})).status,403);
 assert.equal((await call(port,'GET','/pending',{host:'evil.example'})).status,403);
 server.close();
});

test('requests are signed for this viewer and completed only with a valid proof',async()=>{
 const {server,port}=await setup();
 const {body:{id}}=await call(port,'POST','/host/start',{body:{kind:'get',options:options()},token:hostToken(key)});
 const [signed]=(await call(port,'GET','/pending')).body;
 assert.equal(signed.sig,mac(key,'request',signed.payload));
 const request=JSON.parse(signed.payload);
 assert.equal(request.viewer,viewer);assert.equal(request.origin,origin);assert.equal(request.id,id);
 assert.equal(request.publicKey.extensions.remoteDesktopClientOverride,undefined);
 const meta=(await call(port,'GET','/agent/state')).body[0];
 assert.equal(meta.code,id.slice(0,8).toUpperCase());assert.equal(meta.publicKey,undefined);
 assert.equal((await call(port,'POST','/complete',{body:{id,response:response(),proof:'0'.repeat(64)}})).status,403);
 assert.equal((await call(port,'POST','/cancel',{body:{id,proof:mac(key,'complete',id)}})).status,403);
 assert.deepEqual((await call(port,'POST','/complete',{body:{id,response:response(),proof:mac(key,'complete',id)}})).body,{delivered:true});
 const result=(await call(port,'POST','/host/result',{body:{id},token:hostToken(key)})).body;
 assert.equal(result.status,'delivered');assert.equal(result.response.id,'cred');
 server.close();
});

test('cross-origin frames and substituted challenges are rejected',async()=>{
 const {server,port}=await setup();
 const framed=options();framed.extensions.remoteDesktopClientOverride.sameOriginWithAncestors=false;
 assert.equal((await call(port,'POST','/host/start',{body:{kind:'get',options:framed},token:hostToken(key)})).status,400);
 const {body:{id}}=await call(port,'POST','/host/start',{body:{kind:'get',options:options()},token:hostToken(key)});
 assert.equal((await call(port,'POST','/complete',{body:{id,response:response('b3RoZXI'),proof:mac(key,'complete',id)}})).status,400);
 assert.deepEqual((await call(port,'POST','/cancel',{body:{id,proof:mac(key,'cancel',id)}})).body,{canceled:true});
 assert.equal((await call(port,'POST','/host/result',{body:{id},token:hostToken(key)})).body.status,'canceled');
 server.close();
});

test('signatures and proofs are key-specific',()=>{
 const other=Buffer.alloc(32,8),r={id:'a',kind:'get',origin,publicKey:{challenge:'c'},expiresAt:1};
 assert.notEqual(signedRequest(key,viewer,r).sig,signedRequest(other,viewer,r).sig);
 assert.notEqual(signedRequest(key,viewer,r).sig,signedRequest(key,'https://evil.ts.net:8443',r).sig);
 assert.ok(proofValid(key,'complete','a',mac(key,'complete','a')));
 assert.ok(!proofValid(other,'complete','a',mac(key,'complete','a')));
 assert.ok(!proofValid(key,'complete','a','not-hex'));
});

test('extension IDs follow Chrome unpacked-path derivation and unchanged loads are skipped',async()=>{
 const {unpackedExtensionId,installHostExtension}=await import('../auth-host.mjs');
 assert.equal(unpackedExtensionId('/home/manbir/.local/state/dev-tools/shared-browser-primary/auth-host-extension'),'edclbfcbpfckpgkmofaokehddpjjdhjd');
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'auth-ext-'));
 const id=unpackedExtensionId(path.join(dataDir,'auth-host-extension'));
 let installs=0,targets=[];
 const browser={targets:()=>targets,installExtension:async()=>{installs++;targets=[{type:()=>'service_worker',url:()=>'chrome-extension://'+id+'/host.js'}];return id;}};
 assert.equal(await installHostExtension(browser,{key,dataDir}),id);
 assert.equal(await installHostExtension(browser,{key,dataDir}),id);
 assert.equal(installs,1);
 assert.equal(await installHostExtension(browser,{key:Buffer.alloc(32,9),dataDir}),id);
 assert.equal(installs,2);
 const config=await fs.readFile(path.join(dataDir,'auth-host-extension/config.js'),'utf8');
 assert.match(config,new RegExp(hostToken(Buffer.alloc(32,9))));
 await fs.rm(dataDir,{recursive:true});
});
