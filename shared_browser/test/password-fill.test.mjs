import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PasswordFill} from '../password-fill.mjs';
import {mac} from '../auth-host.mjs';
const key=Buffer.alloc(32,42),viewer='https://procbox.agent-trace.ts.net:8443';
const form={url:'https://example.com/login',origin:'https://example.com',fields:[{role:'username',node:1},{role:'password',node:2}]};
function setup() {
  let active='tab',now=0,calls=[];
  const tab={generation:'generation',page:{url:()=>form.url,evaluate:async(fn,args)=>{if(args){calls.push(args);return {filled:true};}return structuredClone(form);}}};
  const fill=new PasswordFill({key,viewer,getTab:id=>id==='tab'?tab:null,active:()=>active,serial:fn=>fn(),now:()=>now});
  return {fill,tab,calls,changeActive:()=>active='other',expire:()=>now=120001};
}
const start=app=>app.fill.start({tab:'tab',generation:'generation'});
const values={username:'dummy-user',password:'dummy-password'};
const complete=(app,id,v=values)=>app.fill.finish('complete',{id,values:v,proof:mac(key,'password-complete',id,JSON.stringify(v))});

test('password requests disclose only signed destination metadata; delivery is single use',async()=> {
  const app=setup();const opened=await start(app);const [signed]=app.fill.pending();
  assert.equal(signed.sig,mac(key,'request',signed.payload));
  const request=JSON.parse(signed.payload);
  assert.equal(request.viewer,viewer);assert.equal(request.kind,'password');assert.equal(opened.origin,form.origin);
  assert.deepEqual(request.fields,[{role:'username'},{role:'password'}]);
  assert.ok(!signed.payload.includes('dummy'));
  assert.deepEqual(await complete(app,request.id),{filled:true});
  assert.equal(app.calls.length,1);assert.deepEqual(app.calls[0].values,values);
  await assert.rejects(complete(app,request.id),/expired/);
});

test('substituted credential payloads, unpaired proofs and incomplete values cannot fill',async()=> {
  const app=setup();await start(app);const {id}=JSON.parse(app.fill.pending()[0].payload);
  await assert.rejects(app.fill.finish('complete',{id,values,proof:mac(key,'password-complete',id,JSON.stringify({...values,password:'changed'}))}),/Unpaired/);
  await assert.rejects(app.fill.finish('complete',{id,values,proof:mac(key,'complete',id)}),/Unpaired/);
  await assert.rejects(complete(app,id,{username:'dummy-user'}),/Fill the sign-in/);
  await assert.rejects(complete(app,id,{...values,extra:'unexpected'}),/Fill the sign-in/);
  assert.equal(app.calls.length,0);
});

test('tab switch, navigation generation, expiration and replacement request invalidate delivery',async()=> {
  for(const invalidate of [app=>app.changeActive(),app=>app.tab.generation='new',app=>app.expire(),app=>{app.tab.page.url=()=>form.url+'?changed';}]) {
    const app=setup();await start(app);const {id}=JSON.parse(app.fill.pending()[0].payload);invalidate(app);
    await assert.rejects(complete(app,id),/changed|expired/);assert.equal(app.calls.length,0);assert.deepEqual(app.fill.pending(),[]);
  }
  const app=setup();await start(app);const {id}=JSON.parse(app.fill.pending()[0].payload);await start(app);
  await assert.rejects(complete(app,id),/expired/);
});

test('navigation while delivery is queued is rejected; cancel uses a distinct proof',async()=> {
  const app=setup();await start(app);const {id}=JSON.parse(app.fill.pending()[0].payload);
  app.fill.serial=async fn=>{app.tab.generation='new';return fn();};
  await assert.rejects(complete(app,id),/changed/);assert.equal(app.calls.length,0);
  const other=setup();await start(other);const request=JSON.parse(other.fill.pending()[0].payload);
  await assert.rejects(other.fill.finish('cancel',{id:request.id,proof:mac(key,'password-complete',request.id,'')}),/Unpaired/);
  assert.deepEqual(await other.fill.finish('cancel',{id:request.id,proof:mac(key,'password-cancel',request.id,'')}),{canceled:true});
  await assert.rejects(complete(other,request.id),/expired/);
});
