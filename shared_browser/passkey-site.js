const $=id=>document.getElementById(id);
async function api(path,post=false){const response=await fetch('/fixture/'+path,post?{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}:{});const value=await response.json();if(!response.ok)throw Error(value.error);return value;}
async function refresh(){try{const s=await api('status');$('heading').textContent=s.authenticated?'Signed in as Demo Owner':'Signed out';$('login').disabled=!s.registered||s.request?.status==='pending';$('login').hidden=s.authenticated;$('logout').hidden=!s.authenticated;$('open-report').disabled=!s.authenticated;$('code').textContent=s.request?.status==='pending'?s.request.code:'';
$('status').textContent=s.authenticated?'Passkey approval verified. The agent can continue.':!s.registered?'First, create your demo passkey on your phone.':s.request?.status==='pending'?'Waiting for your phone’s passkey approval. Match the code above.':s.request?.status==='canceled'?'Request denied. Still signed out.':s.request?.status==='expired'?'Approval expired. Still signed out.':'Ready to request your phone’s approval.';
if(!s.authenticated)$('report').textContent='Sign in to view this report.';
}catch(error){$('status').textContent=error.message;}}
$('login').onclick=async()=>{try{await api('login',true);await refresh();}catch(error){$('status').textContent=error.message;}};
$('logout').onclick=async()=>{await api('logout',true);await refresh();};
$('open-report').onclick=async()=>{try{$('report').textContent=(await api('workspace')).report;}catch(error){$('report').textContent=error.message;}};
refresh();setInterval(refresh,1000);
