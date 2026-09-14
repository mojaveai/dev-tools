import { startAuthentication } from '@simplewebauthn/browser';
const root='/_shared-browser-passkey';
const id=new URL(location.href).searchParams.get('request');
const status=document.getElementById('status'),button=document.getElementById('approve');
async function api(action,data){const r=await fetch(root+'/request/'+encodeURIComponent(id)+(action?'/'+action:''),data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});const body=await r.json();if(!r.ok)throw Error(body.error);return body;}
let request;
async function load(){try{request=await api('');document.getElementById('code').textContent=request.code;status.textContent='Approve sign-in to the Agent Trace development dashboard. Match this code with the agent.';button.disabled=false;}catch(e){status.textContent=e.message;}}
button.onclick=async()=>{button.disabled=true;try{const response=await startAuthentication({optionsJSON:request.publicKey});await api('respond',{response});status.textContent='Passkey response sent. The dashboard will verify it before signing the agent in.';}catch(e){status.textContent=e.message;button.disabled=false;}};
document.getElementById('deny').onclick=async()=>{try{await api('cancel',{});status.textContent='Canceled. No passkey response was sent.';button.disabled=true;}catch(e){status.textContent=e.message;}};
if(id)load();else status.textContent='Ask the agent for a sign-in request link.';
