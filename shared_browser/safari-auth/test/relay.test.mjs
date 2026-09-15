import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AuthRelay} from '../relay.mjs';
const origin='http://localhost:8812';
function setup(){let now=0;const relay=new AuthRelay({origin,now:()=>now});const r=relay.start('get',{rpId:'localhost',challenge:'one',allowCredentials:[{id:'key'}]});r.promise.catch(()=>{});return {relay,r,expire:()=>now=120000};}
function response(changes={}){return {type:'public-key',id:'key',response:{clientDataJSON:Buffer.from(JSON.stringify({type:'webauthn.get',origin,challenge:'one',crossOrigin:false,...changes})).toString('base64url')}};}
test('delivers the original response exactly once',async()=>{const {relay,r}=setup();const value=response();assert.deepEqual(relay.complete(r.id,value),{delivered:true});assert.strictEqual(await r.promise,value);assert.throws(()=>relay.complete(r.id,value),/already used/);});
test('rejects challenge, origin, operation and frame substitution',()=>{for(const change of [{challenge:'two'},{origin:'https://evil.example'},{type:'webauthn.create'},{crossOrigin:true},{topOrigin:origin}]){const {relay,r}=setup();assert.throws(()=>relay.complete(r.id,response(change)),/does not match/);relay.cancel(r.id);}});
test('rejects wrong credential and unknown request',()=>{const {relay,r}=setup();assert.throws(()=>relay.complete(r.id,{...response(),id:'other'}),/Unexpected credential/);assert.throws(()=>relay.complete('other',response()),/expired/);relay.cancel(r.id);});
test('cancellation and expiry cannot deliver',async()=>{for(const expired of [false,true]){const {relay,r,expire}=setup();if(expired)expire();else relay.cancel(r.id);assert.throws(()=>relay.complete(r.id,response()),/expired/);relay.cancel(r.id);await assert.rejects(r.promise,/canceled/);}});
test('new request cancels old and RP is exact',async()=>{const {relay,r}=setup();assert.throws(()=>relay.start('get',{rpId:'example.com',challenge:'x'}),/relying party/);const next=relay.start('create',{rp:{id:'localhost'},challenge:'next'});next.promise.catch(()=>{});await assert.rejects(r.promise,/canceled/);assert.throws(()=>relay.complete(r.id,response()),/expired/);relay.cancel(next.id);});
test('companion keeps simultaneous browser requests independent',async()=>{
 const relay=new AuthRelay({origin,maxPending:2});
 const one=relay.start('get',{rpId:'localhost',challenge:'one'});
 const two=relay.start('get',{rpId:'localhost',challenge:'two'});two.promise.catch(()=>{});
 assert.equal(relay.list().length,2);
 assert.throws(()=>relay.start('get',{rpId:'localhost',challenge:'three'}),/Too many/);
 assert.throws(()=>relay.complete(two.id,response()),/does not match/);
 relay.complete(one.id,response());await one.promise;
 assert.equal(relay.list().length,1);relay.cancel(two.id);await assert.rejects(two.promise);
});

test('multiple approved sites stay isolated by origin and relying party',async()=>{
 const origins=['https://demo.yubico.com','https://cryptoagent-1-1.agent-trace.ts.net:3581'];
 const relay=new AuthRelay({origins,maxPending:16});
 const requests=origins.map(site=>relay.start('get',{rpId:new URL(site).hostname,challenge:'one'},site));
 for(const r of requests)r.promise.catch(()=>{});
 assert.deepEqual(relay.list().map(r=>r.origin),origins);
 assert.throws(()=>relay.start('get',{rpId:'evil.example',challenge:'one'},'https://evil.example'),/Unsupported origin/);
 assert.throws(()=>relay.start('get',{rpId:'demo.yubico.com',challenge:'one'},origins[1]),/relying party/);
 assert.throws(()=>relay.complete(requests[1].id,response({origin:origins[0]})),/does not match/);
 for(let i=0;i<requests.length;i++){relay.complete(requests[i].id,response({origin:origins[i]}));await requests[i].promise;}
 assert.equal(relay.list().length,0);
});
