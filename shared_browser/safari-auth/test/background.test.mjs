import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createHmac,webcrypto} from 'node:crypto';
const source=await fs.readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const key='ab'.repeat(32),viewerURL='https://coder-pod.asg.ts.net:8443/';
const viewerOrigin=new URL(viewerURL).origin;
const mac=(k,...parts)=>createHmac('sha256',Buffer.from(k,'hex')).update(['dev-tools-auth',...parts].join('\n')).digest('hex');
function signed(request,{signer=key,viewer=viewerOrigin}={}){
  const payload=JSON.stringify({viewer,...request});return {payload,sig:mac(signer,'request',payload)};
}
async function setup({chrome=false,items}={}){
  let listener,updated,state={},calls=[],tabCalls=[],injected=[];
  const request={id:'abcdef0123456789',origin:'https://auth.nebius.com',kind:'get',publicKey:{challenge:'challenge'},expiresAt:Date.now()+120000};
  const pending=items||[signed(request)];
  const browser={runtime:{getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener:fn=>listener=fn}},
    storage:{local:{get:async k=>k?{[k]:state[k]}:state,set:async value=>Object.assign(state,value),remove:async k=>delete state[k]}},
    scripting:{executeScript:async options=>injected.push(options)},
    tabs:{create:async()=>{tabCalls.push(['create']);return {id:42};},get:async id=>({id,url:state.tabURL||request.origin}),
      update:async(...args)=>{tabCalls.push(['update',...args]);if(args[1].url)state.tabURL=args[1].url;},
      remove:async(...args)=>{tabCalls.push(['remove',...args]);},onRemoved:{addListener:()=>{}},onUpdated:{addListener:fn=>updated=fn}}};
  vm.runInNewContext(source,{...(chrome?{chrome:browser}:{browser}),URL,AbortSignal,TextEncoder,crypto:webcrypto,Uint8Array,
    AUTH_CONFIG:{fleetKey:key},
    fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/pending')?pending:{delivered:true}};}});
  const send=(message,sender)=>chrome?new Promise(resolve=>{assert.equal(listener(message,sender,resolve),true);}):listener(message,sender);
  return {send,calls,request,tabCalls,injected,updated:(...a)=>updated(...a),state};
}
const viewer={url:viewerURL,frameId:0,tab:{id:7}};
const open=app=>({type:'viewer-open',code:app.request.id.slice(0,8).toUpperCase(),origin:app.request.origin});
const approval=app=>({url:app.request.origin+'/login',frameId:0,tab:{id:7}});
const plain=value=>JSON.parse(JSON.stringify(value));
const posts=(app,path)=>app.calls.filter(c=>c.url===viewerOrigin+'/auth-companion'+path);

test('web content and non-viewer pages cannot list or open approvals',async()=>{
  const app=await setup();
  for(const type of ['list','open'])assert.ok((await app.send({type,id:app.request.id},{url:app.request.origin,frameId:0,tab:{id:1}})).error);
  for(const sender of [{...viewer,frameId:1},{...viewer,url:'https://coder-pod.asg.ts.net:23581/'},{...viewer,url:'https://evil.example:8443/'},
    {...viewer,url:viewerURL+'other'},{...viewer,url:'http://coder-pod.asg.ts.net:8443/'}])
    assert.ok((await app.send(open(app),sender)).error);
  assert.equal(app.calls.length,0);
});

test('only requests signed by the fleet key for this exact viewer are opened',async()=>{
  const base={id:'abcdef0123456789',origin:'https://auth.nebius.com',kind:'get',publicKey:{challenge:'c'},expiresAt:Date.now()+120000};
  for(const items of [[signed(base,{signer:'cd'.repeat(32)})],[signed(base,{viewer:'https://evil-node.asg.ts.net:8443'})],
    [{...signed(base),payload:signed(base).payload.replace('challenge','changed')}],[{payload:signed(base).payload,sig:'zz'}]]){
    const app=await setup({items});
    assert.match((await app.send(open(app),viewer)).error,/not from one of your hosts/);
    assert.equal(app.tabCalls.length,0);
  }
});

test('approval is bound to the viewer tab, proves completion, and returns to the viewer',async()=>{
  const app=await setup();
  assert.ok((await app.send({...open(app),code:'WRONG'},viewer)).error);
  assert.equal((await app.send(open(app),viewer)).opened,true);
  assert.deepEqual(plain(app.tabCalls.at(-1)),['update',7,{url:app.request.origin+'/',active:true}]);
  for(const invalid of [{...approval(app),frameId:1},{...approval(app),tab:{id:8}},{...approval(app),url:'https://other.example/'}])
    assert.ok((await app.send({type:'complete',id:app.request.id,response:{}},invalid)).error);
  assert.ok((await app.send({type:'complete',id:'other',response:{}},approval(app))).error);
  assert.equal(posts(app,'/complete').length,0);
  const ready=await app.send({type:'ready'},approval(app));
  assert.equal(ready.autoStart,true);assert.equal(ready.request.viewer,viewerOrigin);
  assert.equal((await app.send({type:'complete',id:app.request.id,response:{id:'cred'}},approval(app))).delivered,true);
  const body=JSON.parse(posts(app,'/complete')[0].options.body);
  assert.equal(body.proof,mac(key,'complete',app.request.id));assert.equal(body.response.id,'cred');
  assert.equal(posts(app,'/complete')[0].options.credentials,'omit');
  assert.ok((await app.send({type:'complete',id:app.request.id,response:{}},approval(app))).error);
  assert.equal(app.tabCalls.at(-1)[2].url,viewerURL);
  assert.equal(app.tabCalls.filter(c=>c[0]==='create'||c[0]==='remove').length,0);
});

test('cancel proves cancellation and restores the original viewer URL',async()=>{
  const app=await setup();const sender={...viewer,url:viewerURL+'?view=active#controls'};
  await app.send(open(app),sender);
  await app.send({type:'cancel',id:app.request.id},approval(app));
  assert.equal(JSON.parse(posts(app,'/cancel')[0].options.body).proof,mac(key,'cancel',app.request.id));
  assert.equal(app.tabCalls.at(-1)[2].url,sender.url);
});

test('approval script is injected only into the bound tab at the request origin',async()=>{
  const app=await setup();await app.send(open(app),viewer);
  await app.updated(8,{status:'complete'},{url:app.request.origin+'/'});
  await app.updated(7,{status:'complete'},{url:'https://nebius.com/'});
  await app.updated(7,{status:'loading'},{url:app.request.origin+'/'});
  assert.equal(app.injected.length,0);
  await app.updated(7,{status:'complete'},{url:app.request.origin+'/ui/login'});
  assert.deepEqual(plain(app.injected),[{target:{tabId:7},files:['approval.js']}]);
});

test('popup lists the last viewer and Chrome callback messaging works',async()=>{
  const app=await setup({chrome:true});
  assert.deepEqual(plain((await app.send({type:'list'},{url:'chrome-extension://test/popup.html'})).requests),[]);
  assert.equal((await app.send(open(app),viewer)).opened,true);
  const listed=await app.send({type:'list'},{url:'chrome-extension://test/popup.html'});
  assert.equal(listed.viewer,viewerOrigin);assert.equal(listed.requests[0].id,app.request.id);
  assert.equal((await app.send({type:'complete',id:app.request.id,response:{}},approval(app))).delivered,true);
  assert.ok((await app.send({type:'list'},approval(app))).error);
});
