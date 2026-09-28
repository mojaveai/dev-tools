// Per-host passkey approval. Chrome's webAuthenticationProxy extension hands
// each WebAuthn request in the shared browser to this loopback relay. The
// owner's local browser extension approves it at the real site's origin and
// returns the response through this host's Tailscale-authenticated viewer.
//
// Trust: the fleet key is distributed only to the owner's hosts and local
// approval extensions. Hosts sign every request (including the viewer origin),
// so a look-alike viewer elsewhere on the tailnet cannot present an approval,
// and completion/cancellation require a proof only key holders can compute.
// The site's own verifier still decides whether a response signs in.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {AuthRelay} from './auth-relay.mjs';
import {localOptions} from './auth-host-options.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
export const AUTH_PORT=8811;
const TTL=120000;

export const fleetKeyPath=(env=process.env,home=os.homedir())=>
  env.DEVTOOLS_AUTH_FLEET_KEY||path.join(home,'.config/dev-tools/auth-fleet.key');

export async function readFleetKey(file=fleetKeyPath()) {
  let text;
  try {text=(await fs.readFile(file,'utf8')).trim();}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!/^[a-f0-9]{64}$/.test(text))throw Error('Invalid passkey fleet key at '+file);
  return Buffer.from(text,'hex');
}

export const mac=(key,...parts)=>createHmac('sha256',key).update(['dev-tools-auth',...parts].join('\n')).digest('hex');
export const hostToken=key=>mac(key,'host');
export function proofValid(key,action,id,proof) {
  const want=Buffer.from(mac(key,action,String(id)),'hex');
  const got=/^[a-f0-9]{64}$/.test(proof||'')?Buffer.from(proof,'hex'):Buffer.alloc(0);
  return got.length===want.length&&timingSafeEqual(got,want);
}
// The client verifies the exact payload string, then parses it.
export function signedRequest(key,viewer,{id,kind,origin,publicKey,expiresAt}) {
  const payload=JSON.stringify({viewer,id,kind,origin,publicKey,expiresAt});
  return {payload,sig:mac(key,'request',payload)};
}

export function createAuthHost({key,viewer,now=Date.now}) {
  const relay=new AuthRelay({origins:['*'],maxPending:16,now,ttl:TTL});
  const results=new Map();
  const token='Bearer '+hostToken(key);
  const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  async function body(req){let size=0;const parts=[];for await(const part of req){size+=part.length;if(size>100000)throw Error('Body too large');parts.push(part);}return JSON.parse(Buffer.concat(parts)||'{}');}
  const server=http.createServer(async(req,res)=>{try{
    if(!['localhost:'+AUTH_PORT,'127.0.0.1:'+AUTH_PORT].includes(req.headers.host))return json(res,{error:'Invalid host'},403);
    // Public request metadata for the viewer feed; no challenge or response.
    if(req.method==='GET'&&req.url==='/agent/state')
      return json(res,relay.list().map(r=>({type:'extension',origin:r.origin,code:r.id.slice(0,8).toUpperCase(),kind:r.kind,expiresAt:r.expiresAt})));
    if(req.method==='GET'&&req.url==='/pending')return json(res,relay.list().map(r=>signedRequest(key,viewer,r)));
    if(req.method!=='POST')return json(res,{error:'Not found'},404);
    if(req.url.startsWith('/host/')&&req.headers.authorization!==token)return json(res,{error:'Unpaired host extension'},403);
    const data=await body(req);
    if(req.url==='/host/start'){
      const origin=data.options?.extensions?.remoteDesktopClientOverride?.origin;
      const options=localOptions(data.kind,data.options,origin);
      const request=relay.start(data.kind,options,origin);
      for(const [id,r]of results)if(now()>r.expiresAt)results.delete(id);
      const result={status:'pending',expiresAt:now()+TTL};results.set(request.id,result);
      request.promise.then(response=>Object.assign(result,{status:'delivered',response}),()=>Object.assign(result,{status:'canceled'}));
      console.log('Passkey '+data.kind+' requested by '+new URL(origin).hostname+' ('+request.id.slice(0,8)+')');
      return json(res,{id:request.id});
    }
    if(req.url==='/host/result'){
      const result=results.get(data.id);if(!result||now()>=result.expiresAt)throw Error('Request expired');
      json(res,result);
      if(result.status!=='pending')results.delete(data.id);
      return;
    }
    if(req.url==='/host/cancel')return json(res,relay.cancel(data.id));
    if(req.url==='/complete'||req.url==='/cancel'){
      const action=req.url.slice(1);
      if(!proofValid(key,action,data.id,data.proof))return json(res,{error:'Unpaired approval client'},403);
      return json(res,action==='complete'?relay.complete(data.id,data.response):relay.cancel(data.id));
    }
    json(res,{error:'Not found'},404);
  }catch(error){json(res,{error:error.message},400);}});
  return {relay,server};
}

// Chrome derives an unpacked extension's ID from its absolute path.
export const unpackedExtensionId=dir=>createHash('sha256').update(dir).digest('hex').slice(0,32)
  .replace(/./g,c=>String.fromCharCode(97+parseInt(c,16)));

// The unpacked extension must live where Chrome can read it (Snap Chromium
// cannot read the hidden state directory). Reinstalling replaces its service
// worker while Puppeteer may be attaching to it, so skip an unchanged reload.
export async function installHostExtension(browser,{key,dataDir}) {
  const dir=path.join(dataDir,'auth-host-extension');
  const manifest=JSON.parse(await fs.readFile(path.join(root,'auth-host-extension/manifest.json'),'utf8'));
  manifest.name='Dev Tools Auth host';
  const files={'manifest.json':JSON.stringify(manifest,null,2),
    'host.js':await fs.readFile(path.join(root,'auth-host-extension/host.js'),'utf8'),
    'config.js':'const AUTH_HOST = '+JSON.stringify({relay:'http://localhost:'+AUTH_PORT,token:hostToken(key)})+';\n'};
  const id=unpackedExtensionId(dir);
  const loaded=browser.targets().some(t=>t.type()==='service_worker'&&t.url().startsWith('chrome-extension://'+id+'/'));
  const current=await Promise.all(Object.entries(files).map(async([name,text])=>
    (await fs.readFile(path.join(dir,name),'utf8').catch(()=>null))===text));
  if(loaded&&current.every(Boolean))return id;
  await fs.rm(dir,{recursive:true,force:true});
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  for(const [name,text] of Object.entries(files))await fs.writeFile(path.join(dir,name),text,{mode:0o600});
  return browser.installExtension(dir);
}

export async function startAuthHost({browser,viewer,dataDir,keyFile=fleetKeyPath()}) {
  const key=await readFleetKey(keyFile);
  if(!key){console.log('Passkey approval disabled: no fleet key at '+keyFile);return null;}
  const {server}=createAuthHost({key,viewer});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(AUTH_PORT,'127.0.0.1',resolve);});
  const id=await installHostExtension(browser,{key,dataDir});
  console.log(JSON.stringify({event:'passkey-approval-ready',extension:id}));
  return server;
}
