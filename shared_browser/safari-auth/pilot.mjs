import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {generateRegistrationOptions,generateAuthenticationOptions,verifyRegistrationResponse,verifyAuthenticationResponse} from '@simplewebauthn/server';
import {AuthRelay} from './relay.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const origin='http://localhost:8812', relayURL='http://localhost:8811';
let token=randomBytes(32).toString('hex');
if(process.env.AUTH_REUSE_PAIRING==='1'){
  const saved=await fs.readFile(path.join(root,'local/extension/config.js'),'utf8');
  const config=JSON.parse(saved.slice('const AUTH_CONFIG = '.length).trim().replace(/;$/,''));
  if(!/^[a-f0-9]{64}$/.test(config.token))throw Error('Invalid local pairing capability');
  token=config.token;
}
const relay=new AuthRelay({origin});
const local=path.join(root,'local');
await fs.mkdir(local,{recursive:true,mode:0o700});
await fs.cp(path.join(root,'extension'),path.join(local,'extension'),{recursive:true});
await fs.writeFile(path.join(local,'extension/config.js'),'const AUTH_CONFIG = '+JSON.stringify({relay:relayURL,site:origin,token})+';\n',{mode:0o600});
let credential,options,authenticated=false;
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req){let n=0;const parts=[];for await(const part of req){n+=part.length;if(n>100000)throw Error('Body too large');parts.push(part);}return JSON.parse(Buffer.concat(parts).toString());}
const relayServer=http.createServer(async(req,res)=>{try{
  if(process.env.AUTH_TEST_DIAGNOSTICS==='1')console.log('Relay request:',req.method,req.url,'origin:',req.headers.origin||'(none)');
  if(req.headers.host!=='localhost:8811')return json(res,{error:'Invalid host'},403);
  if(req.headers.authorization!=='Bearer '+token)return json(res,{error:'Unpaired client'},403);
  if(req.method==='GET'&&req.url==='/pending')return json(res,relay.list());
  if(req.method!=='POST')return json(res,{error:'Not found'},404);
  const data=await body(req);
  if(req.url==='/complete')return json(res,relay.complete(data.id,data.response));
  if(req.url==='/cancel')return json(res,relay.cancel(data.id));
  json(res,{error:'Not found'},404);
}catch(error){json(res,{error:error.message},400);}});
const html=`<!doctype html><meta charset="utf-8"><title>Dev Tools Auth Test</title><style>body{font:18px system-ui;max-width:650px;margin:70px auto;padding:20px}button{padding:12px;margin:8px}#status{white-space:pre-wrap}</style><h1>Separate browser authentication test</h1><p>Create a disposable passkey through Safari, then use it to sign in here.</p><button id="create">Create test passkey</button><button id="get">Sign in with test passkey</button><button id="cancel">Cancel</button><p id="status">Ready</p><script src="/site.js"></script>`;
const siteJS=`let controller;for(const kind of ['create','get'])document.getElementById(kind).onclick=async()=>{controller?.abort();controller=new AbortController();const status=document.getElementById('status');try{status.textContent='Waiting for Safari approval…';const r=await fetch('/options/'+kind,{method:'POST'});const options=await r.json();if(!r.ok)throw Error(options.error);const publicKey=kind==='create'?PublicKeyCredential.parseCreationOptionsFromJSON(options):PublicKeyCredential.parseRequestOptionsFromJSON(options);const c=await navigator.credentials[kind]({publicKey,signal:controller.signal});const v=await fetch('/verify/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c.toJSON())});const result=await v.json();if(!v.ok)throw Error(result.error);status.textContent=kind==='create'?'Registration verified by the original site. Now test sign-in.':'SIGNED IN — original site verified the Safari signature.';}catch(e){status.textContent=e.name+': '+e.message;}};document.getElementById('cancel').onclick=()=>controller?.abort();`;
const site=http.createServer(async(req,res)=>{try{
  if(req.headers.host!=='localhost:8812')return json(res,{error:'Invalid host'},403);
  if(req.method==='POST'&&req.headers.origin!==origin)return json(res,{error:'Invalid origin'},403);
  if(req.method==='POST'&&req.url.startsWith('/options/')){
    const kind=req.url.split('/').at(-1);authenticated=false;
    if(kind==='create')options=await generateRegistrationOptions({rpName:'Dev Tools disposable Safari test',rpID:'localhost',userID:randomBytes(32),userName:'dev-tools-mac-test',attestationType:'none',authenticatorSelection:{residentKey:'required',userVerification:'required'},timeout:120000});
    else if(kind==='get'&&credential)options=await generateAuthenticationOptions({rpID:'localhost',allowCredentials:[{id:credential.id}],userVerification:'required',timeout:120000});
    else throw Error('Create a test passkey first');
    return json(res,options);
  }
  if(req.method==='POST'&&req.url.startsWith('/verify/')){
    const response=await body(req);
    if(req.url==='/verify/create'){
      const result=await verifyRegistrationResponse({response,expectedChallenge:options.challenge,expectedOrigin:origin,expectedRPID:'localhost',requireUserVerification:true});
      if(!result.verified)throw Error('Registration failed');credential=result.registrationInfo.credential;
      console.log('VERIFIED registration: original site accepted Safari response.');
    }else{
      const result=await verifyAuthenticationResponse({response,expectedChallenge:options.challenge,expectedOrigin:origin,expectedRPID:'localhost',credential,requireUserVerification:true});
      if(!result.verified)throw Error('Authentication failed');credential.counter=result.authenticationInfo.newCounter;authenticated=true;
      console.log('VERIFIED authentication: original site accepted Safari signature.');
    }
    return json(res,{verified:true});
  }
  if(req.url==='/status')return json(res,{registered:!!credential,authenticated,pending:relay.list().map(({id,kind})=>({id,kind}))});
  res.setHeader('Content-Type',req.url==='/site.js'?'text/javascript':'text/html');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  res.end(req.url==='/site.js'?siteJS:req.url==='/approval'?'<!doctype html><title>Safari approval</title><p>The Dev Tools Auth extension will show your approval here. If it does not, allow it on localhost in Safari.</p>':html);
}catch(error){json(res,{error:error.message},400);}});
await Promise.all([new Promise(r=>relayServer.listen(8811,'127.0.0.1',r)),new Promise(r=>site.listen(8812,'127.0.0.1',r))]);
const chrome=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:process.env.AUTH_TEST_HEADLESS==='1',args:['--no-first-run']});
const page=await chrome.newPage();
// Test-only interception, scoped to this fresh page and exact fixture origin.
// Production interception must obtain origin/frame identity from trusted browser APIs.
await page.exposeFunction('__authPilot',async(kind,publicKey)=>{
  if(new URL(page.url()).origin!==origin)throw Error('Unexpected test page');
  const request=relay.start(kind,publicKey);
  return await request.promise;
});
await page.exposeFunction('__authCancel',()=>{for(const r of relay.list())relay.cancel(r.id);});
await page.evaluateOnNewDocument(()=>{
  const encode=v=>{if(v instanceof ArrayBuffer||ArrayBuffer.isView(v))return btoa(String.fromCharCode(...new Uint8Array(v.buffer||v))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');if(Array.isArray(v))return v.map(encode);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,v])=>[k,encode(v)]));return v;};
  for(const kind of ['create','get'])navigator.credentials[kind]=async({publicKey,signal})=>{
    if(location.origin!=='http://localhost:8812'||window!==top)throw Error('Test only');
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    const cancel=()=>window.__authCancel();signal?.addEventListener('abort',cancel,{once:true});
    try{const response=await window.__authPilot(kind,encode(publicKey));return {toJSON:()=>response};}
    finally{signal?.removeEventListener('abort',cancel);}
  };
});
page.on('framenavigated',frame=>{if(frame===page.mainFrame())for(const r of relay.list())relay.cancel(r.id);});
page.on('close',()=>{for(const r of relay.list())relay.cancel(r.id);});
await page.goto(origin);
await fs.writeFile(path.join(local,'test-browser.json'),JSON.stringify({endpoint:chrome.wsEndpoint(),origin}),{mode:0o600});
console.log('Safari extension folder: '+path.join(local,'extension'));
console.log('Disposable test site ready. No production sessions modified.');
async function stop(){for(const r of relay.list())relay.cancel(r.id);await chrome.close();relayServer.close();site.close();process.exit();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
