// page.exposeFunction without Puppeteer's puppeteer_-prefixed binding and
// wrapper. Cloudflare JS detection flags those on every site in the browser,
// so helpers attached to all pages must not use them. Calls return promises
// resolved from Node with the handler's JSON-serializable result.
import {randomBytes} from 'node:crypto';

export async function exposeQuietFunction(page,name,handler) {
  const cdp=await page.createCDPSession();
  const tag=randomBytes(6).toString('hex'),binding='__b'+tag,deliver='__d'+tag;
  cdp.on('Runtime.bindingCalled',async({name:called,payload,executionContextId})=>{
    if(called!==binding)return;
    let id,result,error;
    try {({id}=JSON.parse(payload));result=await handler(...JSON.parse(payload).args);}
    catch(err){error=String(err?.message||err);}
    if(id===undefined)return;
    await cdp.send('Runtime.evaluate',{contextId:executionContextId,
      expression:`globalThis[${JSON.stringify(deliver)}]?.(${JSON.stringify(id)},${JSON.stringify(JSON.stringify(result??null))},${JSON.stringify(error??null)})`,
    }).catch(()=>{});
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.addBinding',{name:binding});
  const install=(binding,deliver,name)=>{
    const call=globalThis[binding];if(typeof call!=='function')return;
    const pending=new Map();let seq=0;
    const hidden=(key,value)=>Object.defineProperty(globalThis,key,{value,configurable:true,writable:true,enumerable:false});
    hidden(deliver,(id,result,error)=>{const p=pending.get(id);if(!p)return;pending.delete(id);error===null?p.resolve(JSON.parse(result)):p.reject(new Error(error));});
    hidden(name,(...args)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});call(JSON.stringify({id,args}));}));
  };
  const source=`(${install})(${JSON.stringify(binding)},${JSON.stringify(deliver)},${JSON.stringify(name)})`;
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source});
  await cdp.send('Runtime.evaluate',{expression:source}).catch(()=>{});
  return cdp;
}
