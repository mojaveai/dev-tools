import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceRecovery} from '../resource-recovery.mjs';
import {AssetDelivery} from '../asset-delivery.mjs';

test('recovery only reads observed visual resources, including child frames',async()=>{
  const calls=[],saved=new Map();
  const cdp={send:async(method,args)=>{
    calls.push([method,args]);
    if(method==='Page.getResourceTree')return {frameTree:{frame:{id:'top'},resources:[{url:'https://cdn.test/style',type:'Stylesheet',mimeType:'text/css'},{url:'https://cdn.test/script',type:'Script'}],childFrames:[{frame:{id:'child'},resources:[{url:'https://cdn.test/image',type:'Image',mimeType:'image/png'}]}]}};
    if(method==='Page.getResourceContent')return args.frameId==='child'?{content:'aW1hZ2U=',base64Encoded:true}:{content:'body{margin:27px}',base64Encoded:false};
    throw Error('Unexpected network request');
  }};
  const recover=await resourceRecovery(cdp,(url,asset)=>saved.set(url,asset));
  const reads=calls.length;
  await recover('https://not-observed.test/private');await recover('https://cdn.test/script');
  assert.equal(calls.length,reads);
  await recover('https://cdn.test/style');await recover('https://cdn.test/image');
  assert.equal(saved.get('https://cdn.test/image').bytes.toString(),'image');
  assert.equal(saved.get('https://cdn.test/style').type,'text/css');
  assert.equal(calls.at(-1)[1].frameId,'child');
});

test('cached CSS backgrounds come from isolated native timing observations',async()=>{
  const saved=new Map(),calls=[];
  const cdp={send:async(method,args)=>{
    calls.push([method,args]);
    if(method==='Page.getResourceTree')return {frameTree:{frame:{id:'frame'},resources:[]}};
    if(method==='Page.createIsolatedWorld'){assert.equal(args.grantUniveralAccess,undefined);return {executionContextId:72};}
    if(method==='Runtime.evaluate'){assert.equal(args.contextId,72);return {result:{value:['https://cdn.test/logo.png']}};}
    if(method==='Page.getResourceContent')throw Error('Resource omitted from renderer store');
    if(method==='Network.loadNetworkResource')return {resource:{success:true,stream:'logo',headers:{'Content-Type':'image/png'}}};
    if(method==='IO.read')return {data:'UE5H',base64Encoded:true,eof:true};
    if(method==='IO.close')return {};
    throw Error('Unexpected command');
  }};
  const recover=await resourceRecovery(cdp,(url,asset)=>saved.set(url,asset));
  await recover('https://cdn.test/logo.png');
  assert.equal(saved.get('https://cdn.test/logo.png').bytes.toString(),'PNG');
  assert.equal(saved.get('https://cdn.test/logo.png').type,'image/png');
  assert.equal(calls.at(-1)[0],'IO.close');
});

test('missing font bytes use Chrome cache/context and always close bounded streams',async()=>{
  const calls=[],saved=[];
  const cdp={send:async(method,args)=>{
    calls.push([method,args]);
    if(method==='Page.getResourceTree')return {frameTree:{frame:{id:'frame'},resources:[{url:'https://cdn.test/font',type:'Font',mimeType:'font/woff2'},{url:'https://cdn.test/image',type:'Image'}]}};
    if(method==='Page.getResourceContent')throw Error('No resource content');
    if(method==='Network.loadNetworkResource')return {resource:{success:true,stream:'font-stream'}};
    if(method==='IO.read')return {data:Buffer.from('too large').toString('base64'),base64Encoded:true,eof:true};
    if(method==='IO.close')return {};
    throw Error('Unexpected command');
  }};
  const recover=await resourceRecovery(cdp,(...args)=>saved.push(args),{maxBytes:4});
  await recover('https://cdn.test/image');
  assert.equal(calls.some(([m])=>m==='Network.loadNetworkResource'),false);
  await recover('https://cdn.test/font');
  assert.deepEqual(calls.find(([m])=>m==='Network.loadNetworkResource')[1],{frameId:'frame',url:'https://cdn.test/font',options:{disableCache:false,includeCredentials:true}});
  assert.equal(calls.at(-1)[0],'IO.close');assert.equal(saved.length,0);
});

test('concurrent viewers share one asset recovery and both receive restored bytes',async()=>{
  const resources=new Map();let finish,calls=0;
  const delivery=new AssetDelivery(resources,{recover:async url=>{calls++;await new Promise(r=>finish=r);resources.set(url,{bytes:Buffer.from('restored')});}});
  const a=delivery.get('style'),b=delivery.get('style');await Promise.resolve();
  assert.equal(calls,1);finish();
  assert.equal((await a).bytes.toString(),'restored');assert.equal(await a,await b);
});
