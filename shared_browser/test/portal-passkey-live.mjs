// Disposable local RP and authenticator; never registers a key in Agent Trace.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer-core';
import {PasskeyGate} from '../passkey-gate.mjs';
const origin='http://localhost:8798', bridge='http://127.0.0.1:8799';
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
 if(req.url==='/options'){verified=false;request=gate.start('remote-site');const options=await gate.authenticationOptions(request.id,'phone');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(options));return;}
 if(req.url==='/verify'){const parts=[];for await(const p of req)parts.push(p);await gate.approve(request.id,'phone',JSON.parse(Buffer.concat(parts)));verified=true;res.end('{}');return;}
 res.setHeader('Content-Type','text/html');res.end(site);
}catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}});
await new Promise(r=>server.listen(8798,'127.0.0.1',r));
const browser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true,args:['--disable-dev-shm-usage']});
let worker;
const wait=async fn=>{for(let i=0;i<100;i++){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,75));}throw Error('Expected bridge state not reached');};
try{
 const phone=await browser.newPage();await phone.goto(origin+'/_shared-browser-passkey/');
 const cdp=await phone.createCDPSession();await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
 // Navigate to a same-origin plain page until the helper service starts.
 await phone.goto(origin+'/enroll');
 const options=await gate.registrationOptions('phone');
 const registration=await phone.evaluate(async options=>(await navigator.credentials.create({publicKey:PublicKeyCredential.parseCreationOptionsFromJSON(options)})).toJSON(),options);
 await gate.register('phone',registration);
 worker=spawn(process.execPath,[fileURLToPath(new URL('../portal-passkey-bridge.mjs',import.meta.url))],{env:{...process.env,PORTAL_ORIGIN:origin,PORTAL_BRIDGE_PORT:'8799',PORTAL_BROWSER_WS:browser.wsEndpoint()},stdio:['ignore','pipe','pipe']});
 await wait(async()=>{try{return (await fetch(bridge+'/agent/state')).ok;}catch{return false;}});
 const remote=await browser.newPage();await remote.goto(origin+'/');
 await wait(()=>remote.evaluate(()=>!!window.__portalPasskeyHook));
 await remote.click('#login');
 const pending=await wait(async()=> (await(await fetch(bridge+'/agent/state')).json())[0]);
 assert.equal(verified,false);
 await phone.bringToFront();await phone.goto(pending.url);await phone.waitForSelector('#approve:not([disabled])');await phone.click('#approve');
 await wait(()=>verified);
 await remote.bringToFront();await wait(async()=> (await remote.$eval('#status',e=>e.textContent))==='Unlocked');
 console.log('PASS existing enrolled passkey signs on original RP origin; serialized credential passes portal-style type checks; original verifier accepts response');
 const delivered=await fetch(bridge+new URL(pending.url).pathname+'request/'+new URL(pending.url).searchParams.get('request'),{headers:{'x-shared-browser-edge':'qa-dashboard'}});assert.equal(delivered.status,400);
 console.log('PASS delivered request cannot be fetched or reused');
 await remote.click('#login');await wait(async()=> (await(await fetch(bridge+'/agent/state')).json()).length===1);await remote.click('#abort');
 await wait(async()=> (await remote.$eval('#status',e=>e.textContent)).startsWith('Denied'));
 assert.equal(verified,false);console.log('PASS remote cancellation leaves site locked');
}finally{worker?.kill('SIGTERM');await browser.close();await new Promise(r=>server.close(r));}
