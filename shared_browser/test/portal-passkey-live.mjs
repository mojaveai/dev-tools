// Disposable local RP and authenticator; never registers a key in Agent Trace.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer-core';
import {verifyAuthenticationResponse} from '@simplewebauthn/server';
import {PasskeyGate} from '../passkey-gate.mjs';
const origin='http://localhost:8798', bridge='http://127.0.0.1:8799';
const viewerOrigin='http://localhost:8800';
const parent=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<iframe style="width:480px;height:320px" sandbox="allow-scripts allow-same-origin" allow="publickey-credentials-get" src="'+origin+'/_shared-browser-passkey/?request='+new URL(req.url,viewerOrigin).searchParams.get('request')+'&embed=1"></iframe>');});
await new Promise(r=>parent.listen(8800,'127.0.0.1',r));
const gate=new PasskeyGate({origin,persist:async()=>{}});let request,verified=false;
const site=`<!doctype html><button id="login">Sign in</button><button id="abort">Cancel</button><p id="status">Locked</p><script>
let controller;
document.querySelector('#abort').onclick=()=>controller?.abort();
document.querySelector('#login').onclick=async()=>{document.querySelector('#status').textContent='Waiting';controller=new AbortController();try{
const options=await(await fetch('/options')).json();
const c=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON(options),signal:controller.signal});
if(!(c instanceof PublicKeyCredential)||!(c.response instanceof AuthenticatorAssertionResponse))throw Error('Credential interface mismatch');
const r=await fetch('/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c.toJSON())});if(!r.ok)throw Error('Signature rejected');document.querySelector('#status').textContent='Unlocked';
}catch(e){document.querySelector('#status').textContent='Denied: '+e.message;}};</script>`;
const server=http.createServer(async(req,res)=>{try{
 if(req.url.startsWith('/_shared-browser-passkey/')){
  const up=http.request(bridge+req.url,{method:req.method,headers:{...req.headers,'x-shared-browser-edge':'qa-dashboard'}},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});up.on('error',()=>{res.writeHead(502);res.end();});req.pipe(up);return;
 }
 if(req.url==='/options'){verified=false;request=gate.start('remote-site');const options=await gate.authenticationOptions(request.id,'phone');options.hints=['security-key','client-device'];options.allowCredentials=options.allowCredentials.map(c=>({...c,transports:['usb']}));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(options));return;}
 if(req.url==='/verify'){const parts=[];for await(const p of req)parts.push(p);const response=JSON.parse(Buffer.concat(parts));
 const client=JSON.parse(Buffer.from(response.response.clientDataJSON,'base64url'));
 if(client.crossOrigin){
  const result=await verifyAuthenticationResponse({response,expectedChallenge:gate.get(request.id).challenge,expectedOrigin:origin,expectedTopOrigin:viewerOrigin,expectedRPID:gate.rpID,credential:gate.credential,requireUserVerification:true});
  assert.equal(result.verified,true);gate.credential.counter=result.authenticationInfo.newCounter;
 }else await gate.approve(request.id,'phone',response);
 verified=true;res.end('{}');return;}
 res.setHeader('Content-Type','text/html');res.end(site);
}catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}});
await new Promise(r=>server.listen(8798,'127.0.0.1',r));
const browser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true,args:['--disable-dev-shm-usage']});
const state=await fs.mkdtemp(path.join(os.tmpdir(),'portal-endpoint-live-'));
let worker;
const wait=async fn=>{for(let i=0;i<100;i++){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,75));}throw Error('Expected bridge state not reached');};
try{
 const phone=await browser.newPage();await phone.goto(origin+'/_shared-browser-passkey/');
 const cdp=await phone.createCDPSession();await cdp.send('WebAuthn.enable');const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
 // Navigate to a same-origin plain page until the helper service starts.
 await phone.goto(origin+'/enroll');
 const options=await gate.registrationOptions('phone');
 const registration=await phone.evaluate(async options=>(await navigator.credentials.create({publicKey:PublicKeyCredential.parseCreationOptionsFromJSON(options)})).toJSON(),options);
 await gate.register('phone',registration);
 await fs.mkdir(path.join(state,'profile'));
 await fs.writeFile(path.join(state,'profile/DevToolsActivePort'),'1\n/devtools/browser/stale');
 await fs.writeFile(path.join(state,'browser-host.json'),JSON.stringify({browserWSEndpoint:browser.wsEndpoint()}));
 worker=spawn(process.execPath,[fileURLToPath(new URL('../portal-passkey-bridge.mjs',import.meta.url))],{env:{...process.env,PORTAL_ORIGIN:origin,PORTAL_VIEWER_ORIGIN:viewerOrigin,PORTAL_BRIDGE_PORT:'8799',PORTAL_BROWSER_WS:'',SHARED_BROWSER_STATE:state},stdio:['ignore','pipe','pipe']});
 worker.stderr.on('data',b=>process.stderr.write(b));
 await wait(async()=>{try{return (await fetch(bridge+'/agent/state')).ok;}catch{return false;}});
 const remote=await browser.newPage();await remote.goto(origin+'/');
 await wait(()=>remote.evaluate(()=>!!window.__portalPasskeyHook && typeof window.__portalPasskeyWait==="function" && typeof window.__portalPasskeyCancel==="function"));
 await remote.click('#login');
 const pending=await wait(async()=> (await(await fetch(bridge+'/agent/state')).json())[0]);
 assert.equal(verified,false);
 await phone.bringToFront();await phone.goto(pending.url);await phone.waitForSelector('#approve:not([disabled])');await phone.click('#approve');
 await wait(()=>verified).catch(async error=>{console.error({phone:await phone.$eval('#status',e=>e.textContent),remote:await remote.$eval('#status',e=>e.textContent)});throw error;});
 await remote.bringToFront();await wait(async()=> (await remote.$eval('#status',e=>e.textContent))==='Unlocked');
 console.log('PASS current managed browser endpoint wins over stale legacy port; enrolled passkey signs on original RP origin; original verifier accepts response');
 const delivered=await fetch(bridge+new URL(pending.url).pathname+'request/'+new URL(pending.url).searchParams.get('request'),{headers:{'x-shared-browser-edge':'qa-dashboard'}});assert.equal(delivered.status,400);
 console.log('PASS delivered request cannot be fetched or reused');
 // A real cross-origin iframe produces signed topOrigin and reaches the verifier.
 await remote.click('#login');
 const inline=await wait(async()=> (await(await fetch(bridge+'/agent/state')).json())[0]);
 await phone.bringToFront();await phone.goto(viewerOrigin+'/?request='+new URL(inline.url).searchParams.get('request'));
 const frame=await wait(()=>phone.frames().find(f=>f.url().includes('embed=1')));
 await frame.waitForSelector('#approve:not([disabled])');await frame.click('#approve');
 await wait(()=>verified).catch(async error=>{console.error(await frame.$eval('#status',e=>e.textContent));throw error;});
 assert.equal(phone.url().startsWith(viewerOrigin),true);
 console.log('PASS cross-origin inline approval preserves the viewer and verifies the signed expected parent origin');
 if(process.env.SHARED_BROWSER_WEBKIT_MODULE){
  await remote.bringToFront();await remote.click('#login');
  const pending=await wait(async()=> (await(await fetch(bridge+'/agent/state')).json())[0]);
  const {webkit}=await import(process.env.SHARED_BROWSER_WEBKIT_MODULE);
  const safari=await webkit.launch({headless:true});
  try{
   const page=await safari.newPage({viewport:{width:390,height:780}});
   await page.addInitScript(()=>{
    navigator.credentials.get=async({publicKey})=>({id:'test',rawId:new Uint8Array([1]).buffer,type:'public-key',getClientExtensionResults:()=>({}),response:{
      clientDataJSON:new TextEncoder().encode(JSON.stringify({type:'webauthn.get',origin:location.origin,crossOrigin:true})).buffer,
      authenticatorData:new Uint8Array(37).buffer,signature:new Uint8Array([1]).buffer,userHandle:null,
    }});
   });
   await page.goto(viewerOrigin+'/?request='+new URL(pending.url).searchParams.get('request'));
   const frame=page.frameLocator('iframe');await frame.locator('#approve:not([disabled])').click();
   await wait(async()=>(await frame.locator('#status').textContent()).includes('separate approval window'));
   assert.equal(verified,false);assert.equal((await(await fetch(bridge+'/agent/state')).json()).length,1);
   console.log('PASS WebKit inline panel remains usable; missing signed topOrigin preserves request for separate-window fallback');
  }finally{await safari.close();}
  await remote.click('#abort');await wait(async()=>(await(await fetch(bridge+'/agent/state')).json()).length===0);
 }
 // The streamlined flow prompts on load and returns to the existing viewer.
 for(const requireTap of [false,true]) {
  await remote.bringToFront();await remote.click('#login');
  const pending=await wait(async()=> (await(await fetch(bridge+'/agent/state')).json())[0]);
  const created=new Promise(resolve=>browser.once('targetcreated',resolve));
  await phone.evaluate(()=>window.open('about:blank','_blank','noopener,popup,width=480,height=640'));
  const popup=await(await created).page();
  const popupCDP=await popup.createCDPSession();await popupCDP.send('WebAuthn.enable');
  const virtual=await popupCDP.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  const {credentials}=await cdp.send('WebAuthn.getCredentials',{authenticatorId});
  await popupCDP.send('WebAuthn.addCredential',{authenticatorId:virtual.authenticatorId,credential:{...credentials[0],signCount:gate.credential.counter}});
  if(requireTap)await popup.evaluateOnNewDocument(()=>{
    const get=navigator.credentials.get.bind(navigator.credentials);let first=true;
    navigator.credentials.get=options=>{if(first){first=false;return Promise.reject(new DOMException('Tap to approve','NotAllowedError'));}return get(options);};
  });
  await popup.goto(pending.url+'&auto=1');
  assert.equal(await popup.evaluate(()=>window.opener),null);
  if(requireTap){await popup.waitForSelector('#approve:not([disabled])');await popup.click('#approve');}
  await wait(()=>verified);await wait(()=>popup.isClosed());
  console.log('PASS automatic approval window '+(requireTap?'offers a retry after gesture rejection and ':'')+'closes after verified handoff');
 }
 await remote.click('#login');await wait(async()=> (await(await fetch(bridge+'/agent/state')).json()).length===1);await remote.click('#abort');
 await wait(async()=> (await remote.$eval('#status',e=>e.textContent)).startsWith('Denied'));
 assert.equal(verified,false);console.log('PASS remote cancellation leaves site locked');
}finally{worker?.kill('SIGTERM');await browser.close();await new Promise(r=>server.close(r));await new Promise(r=>parent.close(r));await fs.rm(state,{recursive:true,force:true});}
