import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {AuthRelay} from './relay.mjs';
import {localOptions} from './host-options.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),local=path.join(root,'local');
const origin='https://demo.yubico.com',relayURL='http://localhost:8811';
const previous=await fs.readFile(path.join(local,'extension/config.js'),'utf8');
const token=JSON.parse(previous.slice('const AUTH_CONFIG = '.length).trim().replace(/;$/,'')).token;
if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid pairing');
const hostToken=randomBytes(32).toString('hex');
await fs.cp(path.join(root,'extension'),path.join(local,'extension'),{recursive:true});
const manifest=JSON.parse(await fs.readFile(path.join(local,'extension/manifest.json'),'utf8'));
manifest.description='Approve authentication on Yubico’s demo for the isolated procbox test browser.';
manifest.host_permissions.push(origin+'/*');manifest.content_scripts[0].matches.push(origin+'/*');
await fs.writeFile(path.join(local,'extension/manifest.json'),JSON.stringify(manifest,null,2));
await fs.writeFile(path.join(local,'extension/config.js'),'const AUTH_CONFIG = '+JSON.stringify({relay:relayURL,site:origin,token})+';\n',{mode:0o600});
await fs.cp(path.join(root,'host-extension'),path.join(local,'host-extension'),{recursive:true});
await fs.writeFile(path.join(local,'host-extension/config.js'),'const AUTH_HOST = '+JSON.stringify({relay:relayURL,token:hostToken})+';\n',{mode:0o600});
const relay=new AuthRelay({origin});
const results=new Map();
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
async function body(req){let size=0;const parts=[];for await(const part of req){size+=part.length;if(size>100000)throw Error('Body too large');parts.push(part);}return JSON.parse(Buffer.concat(parts));}
http.createServer(async(req,res)=>{try{
  if(req.headers.host!=='localhost:8811')return json(res,{error:'Invalid host'},403);
  const host=req.url.startsWith('/host/');
  if(req.headers.authorization!=='Bearer '+(host?hostToken:token))return json(res,{error:'Unpaired client'},403);
  if(!host&&req.method==='GET'&&req.url==='/pending')return json(res,relay.list());
  if(req.method!=='POST')return json(res,{error:'Not found'},404);
  const data=await body(req);
  if(host){
    if(req.url==='/host/start'){
      const options=localOptions(data.kind,data.options,origin);
      const request=relay.start(data.kind,options);
      for(const [id,r]of results)if(Date.now()>r.expiresAt)results.delete(id);
      const result={status:'pending',expiresAt:Date.now()+120000};results.set(request.id,result);
      request.promise.then(response=>Object.assign(result,{status:'delivered',response}),()=>Object.assign(result,{status:'canceled'}));
      console.log('Pending Yubico '+data.kind+' request '+request.id.slice(0,8));
      return json(res,{id:request.id});
    }
    if(req.url==='/host/result'){
      const result=results.get(data.id);if(!result||Date.now()>=result.expiresAt)throw Error('Request expired');
      json(res,result);
      if(result.status==='delivered'){console.log('Response returned to original Chrome request '+data.id.slice(0,8));results.delete(data.id);}
      return;
    }
    if(req.url==='/host/cancel')return json(res,relay.cancel(data.id));
  }else{
    if(req.url==='/complete')return json(res,relay.complete(data.id,data.response));
    if(req.url==='/cancel')return json(res,relay.cancel(data.id));
  }
  json(res,{error:'Not found'},404);
}catch(error){console.log('Relay rejected:',error.message);json(res,{error:error.message},400);}}).listen(8811,'127.0.0.1',()=>console.log('Yubico relay ready; isolated host extension generated.'));
