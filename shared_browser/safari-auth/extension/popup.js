const list = document.querySelector('#requests');
async function refresh() {
  try {
    // A newly reloaded Safari event page can briefly return no response while
    // its listeners start. Retry read-only discovery, never approval submission.
    let result;
    for(let attempt=0;attempt<3;attempt++){
      result=await browser.runtime.sendMessage({type:'list'});
      if(result)break;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(!result)throw Error('The extension is starting. Try Refresh.');
    if (result.error) throw Error(result.error);
    list.replaceChildren();
    if (!result.requests.length) list.textContent = 'No pending approvals.';
    for (const request of result.requests) {
      const button = document.createElement('button');
      button.textContent = `${request.kind === 'create' ? 'Create test passkey' : 'Sign in'} · ${request.origin} · ${request.id.slice(0,8)}`;
      button.onclick = async () => {
        button.disabled = true;
        const r = await browser.runtime.sendMessage({type:'open',id:request.id});
        if (!r || r.error) {list.textContent=r?.error || 'The extension restarted. Refresh to check your request.';return;}
        window.close();
      };
      list.append(button);
    }
  } catch (error) {list.textContent = error.message;}
}
document.querySelector('#refresh').onclick = refresh;
refresh();
if(AUTH_CONFIG.mobile){
  document.querySelector('#pairing').hidden=false;
  document.querySelector('#pair').onclick=async()=>{
    const field=document.querySelector('#pair-token');
    const token=field.value.trim();field.value='';
    const result=await browser.runtime.sendMessage({type:'pair',token}).catch(error=>({error:error.message}));
    document.querySelector('#pair-status').textContent=result?.paired?'Paired. You can approve from the viewer.':result?.error||'Pairing failed';
    if(result?.paired)await refresh();
  };
}
