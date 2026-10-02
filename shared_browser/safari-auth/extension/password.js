(async()=> {
  if (window.top !== window || window.__devToolsPasswordFill) return;
  window.__devToolsPasswordFill=true;
  const api=globalThis.browser || globalThis.chrome;
  const result=await api.runtime.sendMessage({type:'ready'});
  const request=result?.request;
  if (!request || request.kind !== 'password' || location.origin !== request.origin || Date.now() >= request.expiresAt) return;
  // A script-free plain-text document keeps the form visible to password-manager
  // extensions without letting the site's application code inspect its contents.
  if (document.contentType !== 'text/plain') {
    await api.runtime.sendMessage({type:'cancel',id:request.id});return;
  }
  const style=document.createElement('style');
  style.textContent='body{margin:0;background:#f5f7fa;color:#17202a;font:16px system-ui;display:grid;min-height:100vh;place-items:center}main{background:white;border:1px solid #dce3ea;border-radius:18px;padding:28px;width:min(420px,calc(100vw - 70px));box-shadow:0 10px 35px #0001}h1{font-size:24px;margin-top:0}p{line-height:1.5;overflow-wrap:anywhere}label{display:block;margin-top:14px}input{display:block;box-sizing:border-box;width:100%;margin-top:6px;padding:12px;border:1px solid #becbd9;border-radius:8px;font:inherit}button{margin:20px 8px 0 0;padding:12px 16px;border:0;border-radius:8px;background:#1766b5;color:white;font:inherit;cursor:pointer}#status{font-size:14px;color:#536579}';
  document.head.append(style);
  const main=document.createElement('main');
  const title=document.createElement('h1');title.textContent='Use your saved login';
  const site=document.createElement('p');site.textContent=new URL(request.origin).host;
  const hint=document.createElement('p');hint.textContent='Choose your saved login to fill the shared browser and return automatically.';
  const form=document.createElement('form');form.autocomplete='on';
  const inputs={};
  for (const {role} of request.fields) {
    if (!['username','password'].includes(role) || inputs[role]) return;
    const label=document.createElement('label');label.textContent=role==='password'?'Password':'Username or email';
    const input=document.createElement('input');input.name=role;input.id=role;input.type=role==='password'?'password':'text';
    input.autocomplete=role==='password'?'current-password':'username';input.required=true;
    input.spellcheck=false;input.autocapitalize='none';label.append(input);form.append(label);inputs[role]=input;
  }
  // A native form submission can make Chrome offer to save this helper's
  // password. Send through the extension without submitting the local form.
  const send=document.createElement('button');send.type='button';send.textContent='Fill and return';
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';cancel.style.background='#edf1f5';cancel.style.color='#17202a';
  const status=document.createElement('p');status.id='status';status.setAttribute('role','status');
  status.textContent='Your login goes to the sign-in fields in your shared browser.';
  form.append(send,cancel);main.append(title,site,hint,form,status);document.body.replaceChildren(main);
  document.title='Saved login · '+new URL(request.origin).host;
  Object.values(inputs)[0]?.focus();
  let finished=false,busy=false,autofillTimer;
  const clear=()=>{for (const input of Object.values(inputs)) input.value='';};
  const stop=message=>{finished=true;clear();send.disabled=true;status.textContent=message;clearInterval(poll);clearTimeout(timer);clearTimeout(autofillTimer);};
  const timer=setTimeout(()=>stop('Request expired. Return to the shared browser and start again.'),Math.max(1,request.expiresAt-Date.now()));
  const poll=setInterval(async()=>{
    if (finished || busy) return;
    const r=await api.runtime.sendMessage({type:'ready'}).catch(()=>null);
    if (!finished && !busy && (!r?.request || r.error)) stop('The sign-in page changed or disconnected. Return and start again.');
  },1500);
  const deliver=async()=> {
    if (finished || busy || Date.now()>=request.expiresAt || !form.reportValidity()) return;
    busy=true;send.disabled=true;
    const values=Object.fromEntries(Object.entries(inputs).map(([role,input])=>[role,input.value]));
    // No credential is saved in extension storage or exposed to viewer scripts.
    const r=await api.runtime.sendMessage({type:'complete',id:request.id,values}).catch(()=>null);
    for (const role of Object.keys(values)) values[role]='';
    if (!r || r.error) {
      stop(r?.error || 'Connection lost. Check the shared browser before trying again.');
    } else stop('Filled. Returning to the shared browser…');
    busy=false;
  };
  send.addEventListener('click',event=> {if(event.isTrusted)void deliver();});
  form.addEventListener('submit',event=>event.preventDefault());
  form.addEventListener('keydown',event=> {
    if(event.isTrusted && event.key==='Enter') {event.preventDefault();void deliver();}
  });
  const managerFilled=event=> {
    // Proton Pass emits synthetic input/change events when the user picks a
    // login. Ordinary trusted typing retains the explicit button/Enter path.
    if (event.isTrusted && event.inputType!=='insertReplacementText') return;
    clearTimeout(autofillTimer);
    if (!Object.values(inputs).every(input=>input.value)) return;
    const chosen=Object.values(inputs).map(input=>input.value);
    status.textContent='Filling your shared browser…';
    autofillTimer=setTimeout(()=> {
      if(Object.values(inputs).every((input,index)=>input.value===chosen[index]))void deliver();
    },250);
  };
  form.addEventListener('input',managerFilled);
  form.addEventListener('change',managerFilled);
  cancel.addEventListener('click',async event=> {
    if (!event.isTrusted || busy) return;
    stop('Canceled. Returning…');
    await api.runtime.sendMessage({type:'cancel',id:request.id}).catch(()=>{});
  });
  window.addEventListener('pagehide',clear,{once:true});
})();
