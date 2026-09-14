import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import puppeteer from 'puppeteer-core';
const root=path.dirname(fileURLToPath(import.meta.url));
const origin=process.env.PORTAL_ORIGIN || 'https://procbox.agent-trace.ts.net:23581', prefix='/_shared-browser-passkey';
const requests=new Map(),attached=new WeakSet();
const hook=(await fs.readFile(path.join(root,'portal-passkey-hook.js'),'utf8')).replaceAll('https://procbox.agent-trace.ts.net:23581',new URL(origin).origin);
const code=id=>id.slice(0,8).toUpperCase();
const json=(res,body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
function cancel(r,message='Request canceled'){if(r.status==='pending'){r.status='canceled';r.resolve({error:message});}}
function get(id){const r=requests.get(id);if(!r || r.status!=='pending' || Date.now()>=r.expiresAt)throw Error('Request expired or already used');return r;}
async function attach(page){
 if(attached.has(page))return;attached.add(page);
 const cancelAll=()=>{for(const r of requests.values())if(r.page===page)cancel(r,'Page changed or closed');};
 page.on('framenavigated',frame=>{if(frame===page.mainFrame())cancelAll();});page.on('close',cancelAll);
 for(const name of ['__portalPasskeyStart','__portalPasskeyWait','__portalPasskeyCancel'])await page.removeExposedFunction(name).catch(()=>{});
 await page.exposeFunction('__portalPasskeyStart',publicKey=>{
   if(new URL(page.url()).origin!==origin || (publicKey.rpId && publicKey.rpId!==new URL(origin).hostname))throw Error('Unsupported passkey origin');
   if(typeof publicKey.challenge!=='string'||publicKey.challenge.length>4096)throw Error('Invalid challenge');
   cancelAll();
   for(const [id,r]of requests)if(Date.now()>r.expiresAt+120000)requests.delete(id);
   if(requests.size>=32)throw Error('Too many requests');
   const id=randomBytes(24).toString('hex');let resolve;
   const promise=new Promise(r=>{resolve=r;});
   const r={id,page,publicKey:{...publicKey,userVerification:'required'},status:'pending',expiresAt:Date.now()+120000,promise,resolve};
   requests.set(id,r);const timer=setTimeout(()=>cancel(r,'Passkey request expired'),120000);timer.unref();
   return id;
 });
 await page.exposeFunction('__portalPasskeyWait',async id=>{const r=requests.get(id);if(!r||r.page!==page)throw Error('Unknown request');return r.promise;});
 await page.exposeFunction('__portalPasskeyCancel',id=>{const r=requests.get(id);if(r?.page===page)cancel(r);});
 await page.evaluateOnNewDocument(hook);await page.evaluate(hook).catch(()=>{});
}
const server=http.createServer(async(req,res)=>{
 try{
   const u=new URL(req.url,'http://local');
   if(u.pathname==='/agent/state'&&req.method==='GET')return json(res,[...requests.values()].filter(r=>r.status==='pending').map(r=>({code:code(r.id),url:origin+prefix+'/?request='+r.id,expiresAt:r.expiresAt})));
   if(req.headers['x-shared-browser-edge']!=='qa-dashboard')return json(res,{error:'Use the development portal URL'},403);
   const files={[prefix+'/']:['portal-passkey.html','text/html'],[prefix+'/client.js']:['portal-passkey-client.js','text/javascript']};
   if(req.method==='GET'&&files[u.pathname]){
     const [name,type]=files[u.pathname];res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff'});return res.end(await fs.readFile(path.join(root,'dist',name)));
   }
   const match=u.pathname.match(/^\/_shared-browser-passkey\/request\/([a-f0-9]{48})(?:\/(respond|cancel))?$/);
   if(!match)return json(res,{error:'Not found'},404);
   const r=get(match[1]);
   if(req.method==='GET'&&!match[2])return json(res,{code:code(r.id),publicKey:r.publicKey,expiresAt:r.expiresAt});
   if(req.method!=='POST'||req.headers.origin!==origin)return json(res,{error:'Invalid request origin'},403);
   let size=0;const parts=[];for await(const part of req){size+=part.length;if(size>100000)throw Error('Request too large');parts.push(part);}
   const body=JSON.parse(Buffer.concat(parts).toString()||'{}');get(r.id);
   if(match[2]==='cancel'){cancel(r);return json(res,{canceled:true});}
   if(match[2]!=='respond')return json(res,{error:'Not found'},404);
   const response=body.response;
   const client=JSON.parse(Buffer.from(response.response.clientDataJSON,'base64url').toString());
   const auth=Buffer.from(response.response.authenticatorData,'base64url');
   if(client.type!=='webauthn.get'||client.origin!==origin||client.challenge!==r.publicKey.challenge||client.crossOrigin===true||auth.length<37||(auth[32]&5)!==5)throw Error('Passkey response does not match this request or lacks user verification');
   if(r.publicKey.allowCredentials?.length&&!r.publicKey.allowCredentials.some(c=>c.id===response.id))throw Error('Unexpected credential');
   if(new URL(r.page.url()).origin!==origin)throw Error('Dashboard navigation changed');
   // The original portal server remains the signature verifier. Never report login success here.
   r.status='delivered';r.resolve(response);return json(res,{delivered:true});
 }catch(error){json(res,{error:error.message},400);}
});
server.listen(Number(process.env.PORTAL_BRIDGE_PORT || 8797),'127.0.0.1');
let browser;
while(true){
 try{
   const [port]=process.env.PORTAL_BROWSER_WS ? [''] : (await fs.readFile(path.join(os.homedir(),'.local/state/dev-tools/shared-browser/profile/DevToolsActivePort'),'utf8')).split('\n');
   browser=await puppeteer.connect({...process.env.PORTAL_BROWSER_WS ? {browserWSEndpoint:process.env.PORTAL_BROWSER_WS} : {browserURL:'http://127.0.0.1:'+port},defaultViewport:null});
   browser.on('targetcreated',async target=>{try{if(target.type()==='page'){const p=await target.page();if(p)await attach(p);}}catch(e){console.error('Passkey hook attach failed:',e.message);}});
   for(const page of await browser.pages())await attach(page);
   console.log('Passkey handoff connected to shared Chrome');
   await new Promise(resolve=>browser.once('disconnected',resolve));
 }catch(error){console.error('Passkey handoff waiting for Chrome:',error.message);}
 for(const r of requests.values())cancel(r,'Remote browser disconnected');
 await new Promise(resolve=>setTimeout(resolve,2000));
}
