importScripts('config.js');
const active=new Map();
async function relay(path,body){
  const r=await fetch(AUTH_HOST.relay+'/host'+path,{method:'POST',signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+AUTH_HOST.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await r.json();if(!r.ok)throw Error(data.error||'Relay failed');return data;
}
async function handle(kind,request){
  const state={canceled:false};active.set(request.requestId,state);
  try{
    const start=await relay('/start',{kind,options:JSON.parse(request.requestDetailsJson)});state.id=start.id;
    if(state.canceled){await relay('/cancel',{id:state.id});return;}
    while(!state.canceled){
      // Chrome API activity keeps this isolated test worker alive while waiting.
      await chrome.runtime.getPlatformInfo();
      const result=await relay('/result',{id:state.id});
      if(result.status==='delivered'){
        const method=kind==='create'?'completeCreateRequest':'completeGetRequest';
        await chrome.webAuthenticationProxy[method]({requestId:request.requestId,responseJson:JSON.stringify(result.response)});
        return;
      }
      if(result.status!=='pending')throw Error('Approval canceled or expired');
      await new Promise(resolve=>setTimeout(resolve,700));
    }
  }catch(error){
    if(state.id)await relay('/cancel',{id:state.id}).catch(()=>{});
    if(!state.canceled){const method=kind==='create'?'completeCreateRequest':'completeGetRequest';await chrome.webAuthenticationProxy[method]({requestId:request.requestId,error:{name:'NotAllowedError',message:error.message}}).catch(()=>{});}
  }finally{active.delete(request.requestId);}
}
chrome.webAuthenticationProxy.onCreateRequest.addListener(request=>handle('create',request));
chrome.webAuthenticationProxy.onGetRequest.addListener(request=>handle('get',request));
chrome.webAuthenticationProxy.onIsUvpaaRequest.addListener(request=>chrome.webAuthenticationProxy.completeIsUvpaaRequest({requestId:request.requestId,isUvpaa:true}));
chrome.webAuthenticationProxy.onRequestCanceled.addListener(requestId=>{const state=active.get(requestId);if(state){state.canceled=true;if(state.id)relay('/cancel',{id:state.id}).catch(()=>{});}});
chrome.webAuthenticationProxy.attach().then(()=>console.log('Authentication proxy attached')).catch(console.error);
