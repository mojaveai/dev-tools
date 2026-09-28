import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {authCompanionProxy} from '../auth-companion-proxy.mjs';
async function run(path,method='GET',data=''){
 const req=Readable.from(data?[Buffer.from(data)]:[]);Object.assign(req,{url:'/auth-companion'+path,method,headers:{}});
 const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};const calls=[];
 await authCompanionProxy(req,res,{fetcher:async(url,options)=>{calls.push({url,options});return {status:200,text:async()=>'[]'};}});
 return {res,calls};
}
test('viewer proxy never exposes host extension or metadata routes',async()=>{
 for(const path of ['/host/start','/host/result','/host/cancel','/agent/state','/pending/../host/start'])assert.equal((await run(path)).res.status,404);
 assert.equal((await run('/pending','POST')).res.status,404);
 assert.equal((await run('/complete','GET')).res.status,404);
});
test('viewer proxy forwards approved methods with bounded bodies and no caching',async()=>{
 const r=await run('/complete','POST','{"id":"test","proof":"x"}');
 assert.equal(r.res.status,200);assert.equal(r.res.headers['Cache-Control'],'no-store');
 assert.equal(r.calls[0].url,'http://localhost:8811/complete');
 assert.equal(r.calls[0].options.headers.Authorization,undefined);
 const large=await run('/complete','POST','x'.repeat(100001));
 assert.equal(large.res.status,413);assert.equal(large.calls.length,0);
});
