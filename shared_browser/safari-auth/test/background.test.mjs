import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../extension/background.js',import.meta.url),'utf8');
async function setup(){
  let listener, state={},calls=[];
  const request={id:'request',origin:'http://localhost:8812',kind:'get',publicKey:{challenge:'challenge'},expiresAt:Date.now()+120000};
  const browser={runtime:{getURL:p=>'safari-web-extension://test/'+p,onMessage:{addListener:fn=>listener=fn}},storage:{local:{get:async()=>state,set:async value=>Object.assign(state,value),remove:async key=>delete state[key]}},tabs:{create:async()=>({id:42}),update:async()=>{},remove:async()=>{},onRemoved:{addListener:()=>{}}}};
  vm.runInNewContext(source,{browser,URL,AUTH_CONFIG:{site:request.origin,relay:'http://localhost:8811',token:'test-capability'},fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/pending')?[request]:{delivered:true}};}});
  return {send:(message,sender)=>listener(message,sender),calls,request};
}
const popup={url:'safari-web-extension://test/popup.html'};
test('web content cannot list requests or open approval tabs',async()=>{const app=await setup();for(const type of ['list','open'])assert.ok((await app.send({type,id:'request'},{url:'http://localhost:8812',frameId:0,tab:{id:1}})).error);assert.equal(app.calls.length,0);});
test('completion is bound to the extension-created top-level tab and request',async()=>{
  const app=await setup();assert.equal((await app.send({type:'open',id:'request'},popup)).opened,true);
  const sender={url:'http://localhost:8812/approval',frameId:0,tab:{id:42}};
  for(const invalid of [{...sender,frameId:1},{...sender,tab:{id:43}},{...sender,url:'https://other.example/approval'}])assert.ok((await app.send({type:'complete',id:'request',response:{}},invalid)).error);
  assert.ok((await app.send({type:'complete',id:'wrong',response:{}},sender)).error);
  assert.equal(app.calls.filter(c=>c.url.endsWith('/complete')).length,0);
  assert.equal((await app.send({type:'complete',id:'request',response:{}},sender)).delivered,true);
  assert.ok((await app.send({type:'complete',id:'request',response:{}},sender)).error);
  assert.equal(app.calls.filter(c=>c.url.endsWith('/complete')).length,1);
});
