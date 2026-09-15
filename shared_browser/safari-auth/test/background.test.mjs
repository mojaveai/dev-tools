import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../extension/background.js',import.meta.url),'utf8');
async function setup(){
  let listener, state={},calls=[],tabCalls=[];
  const request={id:'request',origin:'http://localhost:8812',kind:'get',publicKey:{challenge:'challenge'},expiresAt:Date.now()+120000};
  const browser={runtime:{getURL:p=>'safari-web-extension://test/'+p,onMessage:{addListener:fn=>listener=fn}},storage:{local:{get:async()=>state,set:async value=>Object.assign(state,value),remove:async key=>delete state[key]}},tabs:{create:async()=>{tabCalls.push(['create']);return {id:42};},get:async id=>({id,url:state.tabURL||request.origin}),update:async(...args)=>{tabCalls.push(['update',...args]);if(args[1].url)state.tabURL=args[1].url;},remove:async(...args)=>{tabCalls.push(['remove',...args]);},onRemoved:{addListener:()=>{}}}};
  vm.runInNewContext(source,{browser,URL,AUTH_CONFIG:{site:request.origin,relay:'http://localhost:8811',token:'test-capability'},fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/pending')?[request]:{delivered:true}};}});
  return {send:(message,sender)=>listener(message,sender),calls,request,tabCalls};
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

const viewer={url:'https://procbox.agent-trace.ts.net:8443/',frameId:0,tab:{id:7}};
test('viewer opens only a matched pending request and redirects the same tab back after completion',async()=>{
  const app=await setup();
  const open={type:'viewer-open',code:'REQUEST',origin:app.request.origin};
  for(const sender of [{...viewer,frameId:1},{...viewer,url:'https://procbox.agent-trace.ts.net:23581/'},{...viewer,url:'https://other.example/'},{...viewer,url:'https://procbox.agent-trace.ts.net:8443/other'}])assert.ok((await app.send(open,sender)).error);
  assert.equal(app.calls.length,0);
  assert.ok((await app.send({...open,code:'WRONG'},viewer)).error);
  assert.ok((await app.send({...open,origin:'https://other.example'},viewer)).error);
  assert.equal((await app.send(open,viewer)).opened,true);
  const approval={url:app.request.origin+'/approval',frameId:0,tab:{id:7}};
  assert.equal((await app.send({type:'ready'},approval)).autoStart,true);
  assert.equal((await app.send({type:'complete',id:app.request.id,response:{}},approval)).delivered,true);
  assert.ok(app.tabCalls.some(c=>c[0]==='update'&&c[1]===7&&c[2].active));
  assert.equal(app.tabCalls.filter(c=>c[0]==='create'||c[0]==='remove').length,0);
  assert.equal(app.tabCalls.at(-1)[2].url,viewer.url);
});

test('cancel redirects to the original viewer URL without closing the tab',async()=>{
 const app=await setup();const sender={...viewer,url:viewer.url+'?view=active#controls'};
 await app.send({type:'viewer-open',code:'REQUEST',origin:app.request.origin},sender);
 await app.send({type:'cancel',id:app.request.id},{url:app.request.origin+'/',frameId:0,tab:{id:7}});
 assert.equal(app.tabCalls.at(-1)[2].url,sender.url);
 assert.equal(app.tabCalls.filter(c=>c[0]==='create'||c[0]==='remove').length,0);
});
