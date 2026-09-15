(async () => {
  if (window.top !== window) return;
  let result;
  for (let attempt=0; attempt<10; attempt++) {
    result = await browser.runtime.sendMessage({type:'ready'});
    if (result?.request) break;
    await new Promise(resolve => setTimeout(resolve,200));
  }
  if (!result?.request) return;
  const request = result.request;
  if (location.origin !== request.origin || Date.now() >= request.expiresAt) return;
  const host = document.createElement('div');
  host.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#eef2f6;display:grid;place-items:center';
  const root = host.attachShadow({mode:'closed'});
  root.innerHTML='<style>article{font:16px system-ui;background:white;color:#17202a;border-radius:18px;padding:32px;max-width:460px;box-shadow:0 10px 45px #0002}h1{font-size:24px}button{padding:12px 18px;margin-right:8px;cursor:pointer}p{overflow-wrap:anywhere}</style><article><h1></h1><p id="site"></p><p id="status">This approves the request in the shared browser. Your passkey stays with your credential provider.</p><button id="approve">Continue with passkey</button><button id="cancel">Cancel</button></article>';
  root.querySelector('h1').textContent=request.kind==='create'?'Create a passkey for the remote browser':'Approve remote sign-in';
  root.querySelector('#site').textContent=request.origin+' · Request '+request.id.slice(0,8);
  document.documentElement.append(host);
  const status=root.querySelector('#status'), approve=root.querySelector('#approve'),cancel=root.querySelector('#cancel');
  if(result.returnsToViewer){
    cancel.textContent='Cancel and return';
    status.textContent='Approve to sign in to your shared browser. You’ll return there automatically.';
  }
  const controller=new AbortController();
  let finished=false;
  const timer=setTimeout(()=>{controller.abort();approve.disabled=true;status.textContent='Request expired. Start a new request in the shared browser.';},Math.max(1,request.expiresAt-Date.now()));
  cancel.onclick=async()=>{
    controller.abort();approve.disabled=true;clearTimeout(timer);finished=true;
    const r=await browser.runtime.sendMessage({type:'cancel',id:request.id});
    cancel.disabled=true;status.textContent=r?.error || 'Canceled. You can close this tab.';
  };
  const poll=setInterval(async()=>{
    if(finished){clearInterval(poll);return;}
    const r=await browser.runtime.sendMessage({type:'ready'}).catch(()=>({error:'Connection lost'}));
    if(finished)return;
    if(!r || r.error){controller.abort();approve.disabled=true;clearInterval(poll);clearTimeout(timer);status.textContent='Request ended or connection lost. Start a new request.';}
  },1500);
  const authenticate=async(automatic=false)=>{
    if(approve.disabled)return;
    approve.disabled=true;
    try {
      if(Date.now()>=request.expiresAt)throw Error('Request expired');
      // Safari can dispatch the first click while its newly opened document is
      // still acquiring focus. Briefly yield while preserving click activation.
      if(!automatic)for(let attempt=0;attempt<10&&!document.hasFocus();attempt++)
        await new Promise(resolve=>setTimeout(resolve,25));
      if(!document.hasFocus())throw Error('Focus this page, then click Continue with passkey.');
      // Invoke directly in the content-script click handler to preserve activation.
      // The Mac test establishes whether Safari binds this isolated world to the site.
      const publicKey=request.kind==='create'
        ? PublicKeyCredential.parseCreationOptionsFromJSON(request.publicKey)
        : PublicKeyCredential.parseRequestOptionsFromJSON(request.publicKey);
      const credential=await navigator.credentials[request.kind]({publicKey,signal:controller.signal});
      const r=await browser.runtime.sendMessage({type:'complete',id:request.id,response:credential.toJSON()});
      if(!r || r.error)throw Error(r?.error || 'Connection lost. Check the shared browser before retrying.');
      finished=true;clearTimeout(timer);clearInterval(poll);
      cancel.disabled=true;
      status.textContent='Response delivered. Check the shared browser for the site’s verification result.';
    } catch(error) {
      status.textContent=automatic?'Click Continue with passkey to approve this request.':error.name+': '+error.message;
      if(!controller.signal.aborted)approve.disabled=false;
    }
  };
  approve.onclick=()=>authenticate(false);
  if(result.autoStart && request.kind==='get')void authenticate(true);
})();
