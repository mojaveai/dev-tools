import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PasskeyGate } from './passkey-gate.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PASSKEY_PORT || 8795);
const origin=process.env.PASSKEY_ORIGIN || 'https://procbox.agent-trace.ts.net:8443';
const fixtureOrigin='http://127.0.0.1:'+port;
const owner=process.env.SHARED_BROWSER_OWNER || 'manbir@asgroup.ai';
const stateDir=process.env.PASSKEY_STATE || path.join(os.homedir(),'.local/state/dev-tools/passkey-fixture');
await fs.mkdir(stateDir,{recursive:true,mode:0o700});
const credentialPath=path.join(stateDir,'credential.json');
let credential=null;
try {credential=JSON.parse(await fs.readFile(credentialPath,'utf8'));credential.publicKey=Buffer.from(credential.publicKey,'base64url');}
catch(error){if(error.code!=='ENOENT')throw error;}
const persist=async credential=>{
  const temp=credentialPath+'.'+randomUUID();
  try {
    await fs.writeFile(temp,JSON.stringify({...credential,publicKey:Buffer.from(credential.publicKey).toString('base64url')}),{mode:0o600,flag:'wx'});
    await fs.rename(temp,credentialPath);
  } finally {await fs.rm(temp,{force:true});}
};
const gate=new PasskeyGate({origin,credential,persist});
const devices=new Map(), sessions=new Map();
let queue=Promise.resolve();
function serial(fn){const r=queue.then(fn);queue=r.catch(()=>{});return r;}
function cookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').filter(s=>s.includes('=')).map(s=>s.trim().split('=')));}
function identity(req,res,name,collection,cookiePath,secure=false){
  let id=cookies(req)[name];
  if(!id || !collection.has(id)){
    if(collection.size>=64){for(const [key,s]of collection)if(Date.now()-s.created>3600000)collection.delete(key);}
    if(collection.size>=64)throw Error('Too many demo sessions');
    id=randomUUID();collection.set(id,{created:Date.now(),authenticated:false});
    res.setHeader('Set-Cookie',`${name}=${id}; HttpOnly; SameSite=Strict; Path=${cookiePath}${secure?'; Secure':''}`);
  }
  return id;
}
function json(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function body(req){let size=0;const parts=[];for await(const part of req){size+=part.length;if(size>100000)throw Error('Request too large');parts.push(part);}return JSON.parse(Buffer.concat(parts).toString()||'{}');}
async function file(res,name,type){
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
  res.end(await fs.readFile(path.join(root,'dist',name)));
}
const server=http.createServer(async(req,res)=>{
  try {
    const u=new URL(req.url,'http://local');
    const route=u.pathname.replace(/^\/passkey(?=\/|$)/,'')||'/';
    // The synthetic site is loopback-only; approval API additionally requires the owner proxy identity.
    if(route.startsWith('/fixture')){
      if(req.headers['tailscale-user-login'])return json(res,{error:'Open the test site in remote Chrome'},403);
      const sid=identity(req,res,'demo_site_session',sessions,'/fixture');
      const session=sessions.get(sid);
      if(req.method==='GET'&&route==='/fixture')return await file(res,'passkey-site.html','text/html');
      if(req.method==='GET'&&route==='/fixture/site.js')return await file(res,'passkey-site.js','text/javascript');
      if(req.method==='GET'&&route==='/fixture/status'){
        let request=session.request && gate.requests.has(session.request) ? gate.public(gate.get(session.request)) : null;
        if(request && gate.consume(request.id,sid)){session.authenticated=true;request=gate.public(gate.get(request.id));}
        return json(res,{registered:!!gate.credential,authenticated:session.authenticated,request,
          approvalUrl:origin+'/passkey/',...(session.authenticated?{workspace:'Welcome, Demo Owner. Your agent can now continue.'}:{})});
      }
      if(req.method==='GET'&&route==='/fixture/workspace'){
        if(!session.authenticated)return json(res,{error:'Sign-in required'},401);
        return json(res,{report:'Demo project report: 3 tasks complete, 1 task ready for review.'});
      }
      if(req.method==='POST'){
        if(req.headers.origin!==fixtureOrigin)return json(res,{error:'Invalid fixture origin'},403);
        await body(req);
        if(route==='/fixture/login')return serial(()=>{
          session.authenticated=false;const request=gate.start(sid);session.request=request.id;
          return json(res,{request});
        }).catch(err=>json(res,{error:err.message},400));
        if(route==='/fixture/logout'){session.authenticated=false;if(session.request)gate.cancel(session.request);delete session.request;return json(res,{signedOut:true});}
      }
      return json(res,{error:'Not found'},404);
    }
    if(req.headers['tailscale-user-login']!==owner)return json(res,{error:'Connect through your authorized Tailscale identity'},403);
    const device=identity(req,res,'demo_approval_device',devices,'/passkey',origin.startsWith('https:'));
    if(req.method==='GET'&&route==='/')return await file(res,'passkey-phone.html','text/html');
    if(req.method==='GET'&&route==='/phone.js')return await file(res,'passkey-phone.js','text/javascript');
    if(req.method==='GET'&&route==='/api/state')return json(res,{registered:!!gate.credential,requests:gate.list()});
    if(req.method!=='POST')return json(res,{error:'Not found'},404);
    if(req.headers.origin!==origin)return json(res,{error:'Invalid approval origin'},403);
    const data=await body(req);
    await serial(async()=>{
      if(route==='/api/register/options')return json(res,await gate.registrationOptions(device));
      if(route==='/api/register/verify')return json(res,await gate.register(device,data.response));
      if(route==='/api/auth/options')return json(res,await gate.authenticationOptions(data.id,device));
      if(route==='/api/auth/verify')return json(res,await gate.approve(data.id,device,data.response));
      if(route==='/api/cancel')return json(res,gate.cancel(data.id));
      return json(res,{error:'Not found'},404);
    });
  }catch(error){json(res,{error:error.message},400);}
});
server.listen(port,'127.0.0.1',()=>console.log('Passkey fixture ready on loopback port '+port));
