import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {authCompanionProxy} from '../auth-companion-proxy.mjs';
async function run(path,method='GET',token='a'.repeat(64),data=''){
 const req=Readable.from(data?[Buffer.from(data)]:[]);Object.assign(req,{url:'/auth-companion'+path,method,headers:{authorization:token?'Bearer '+token:undefined}});
 const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};const calls=[];
 await authCompanionProxy(req,res,{fetcher:async(url,options)=>{calls.push({url,options});return {status:200,text:async()=>'[]'};}});
 return {res,calls};
}
test('mobile proxy limits routes and requires a pairing capability',async()=>{
 for(const path of ['/host/start','/host/result','/agent/state','/pending/../host/start'])assert.equal((await run(path)).res.status,404);
 assert.equal((await run('/pending','POST')).res.status,404);
 assert.equal((await run('/pending','GET','')).res.status,403);
 assert.equal((await run('/pending','GET','invalid')).res.status,403);
});
test('mobile proxy forwards only approved methods with bounded bodies and no caching',async()=>{
 const r=await run('/complete','POST','a'.repeat(64),'{"id":"test"}');
 assert.equal(r.res.status,200);assert.equal(r.res.headers['Cache-Control'],'no-store');
 assert.equal(r.calls[0].url,'http://localhost:8811/complete');
 assert.equal(r.calls[0].options.headers.Authorization,'Bearer '+'a'.repeat(64));
 const large=await run('/complete','POST','a'.repeat(64),'x'.repeat(100001));
 assert.equal(large.res.status,413);assert.equal(large.calls.length,0);
});
