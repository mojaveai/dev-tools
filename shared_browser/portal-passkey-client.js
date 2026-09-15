import { startAuthentication } from '@simplewebauthn/browser';
import { phoneOptions } from './portal-passkey-options.mjs';
const root='/_shared-browser-passkey';
const params=new URL(location.href).searchParams;
const id=params.get('request');
const automatic=params.get('auto')==='1';
const status=document.getElementById('status'),button=document.getElementById('approve');
async function api(action,data){const r=await fetch(root+'/request/'+encodeURIComponent(id)+(action?'/'+action:''),data?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{});const body=await r.json();if(!r.ok)throw Error(body.error);return body;}
let request;
async function load(){try{request=await api('');document.getElementById('code').textContent=request.code;status.textContent='Approve sign-in to the Agent Trace development dashboard. Match this code with the agent.';button.disabled=false;if(automatic)await approve();}catch(e){status.textContent=e.message;}}
async function approve(){button.disabled=true;try{const response=await startAuthentication({optionsJSON:phoneOptions(request.publicKey)});await api('respond',{response});status.textContent='Passkey response sent. You can return to the shared browser.';if(automatic)setTimeout(()=>window.close(),700);}catch(e){status.textContent=e.message;button.disabled=false;}}
button.onclick=approve;
document.getElementById('deny').onclick=async()=>{try{await api('cancel',{});status.textContent='Canceled. No passkey response was sent.';button.disabled=true;}catch(e){status.textContent=e.message;}};
if(id)load();else status.textContent='Ask the agent for a sign-in request link.';
