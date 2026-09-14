import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
const $=id=>document.getElementById(id);
let busy=false, signature='';
async function api(path,data){const response=await fetch('/passkey/api/'+path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw Error(result.error||'Request failed');return result;}
async function act(fn){if(busy)return;busy=true;try{await fn();}catch(error){$('status').textContent=error.name==='NotAllowedError'?'Passkey prompt canceled or timed out. The agent is still waiting.':error.message;}finally{busy=false;await refresh();}}
$('register').onclick=()=>act(async()=>{
  $('status').textContent='Follow your phone’s passkey prompt…';
  const optionsJSON=await api('register/options',{});
  const response=await startRegistration({optionsJSON});
  await api('register/verify',{response});
  $('status').textContent='Passkey registered. Tell the agent you’re ready to start the sign-in test.';
});
async function refresh(){
  if(busy)return;
  try{
    const state=await api('state');$('setup').hidden=state.registered;
    const next=JSON.stringify(state.requests);
    if(next!==signature){
      signature=next;$('requests').replaceChildren();
      for(const request of state.requests.slice(0,5)){
        const card=document.createElement('section');card.className='card';card.dataset.request=request.id;
        const title=document.createElement('h2');title.textContent=request.action;
        const code=document.createElement('p');code.className='code';code.textContent=request.code;
        const description=document.createElement('p');description.textContent=request.status==='pending'?'Match this code with the remote test page. Approval expires after two minutes.':'Status: '+request.status;
        card.append(title,code,description);
        if(request.status==='pending'){
          const approve=document.createElement('button');approve.textContent='Approve with passkey';
          approve.onclick=()=>act(async()=>{
            $('status').textContent='Verify with your passkey…';
            const optionsJSON=await api('auth/options',{id:request.id});
            const response=await startAuthentication({optionsJSON});
            await api('auth/verify',{id:request.id,response});
            $('status').textContent='Approved. Your agent can continue in the remote browser.';
          });
          const cancel=document.createElement('button');cancel.className='secondary';cancel.textContent='Deny request';
          cancel.onclick=()=>act(async()=>{await api('cancel',{id:request.id});$('status').textContent='Denied. The remote browser remains signed out.';});
          card.append(approve,cancel);
        }
        $('requests').append(card);
      }
    }
    if($('status').textContent==='Connecting…')$('status').textContent=state.registered?'Ready. Waiting for the agent to request sign-in.':'Create a passkey to begin.';
  }catch(error){$('status').textContent=error.message;}
}
refresh();setInterval(refresh,1500);
