// Runs against pilot.mjs; disposable virtual credentials only.
import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const local=new URL('../local/',import.meta.url);
const {endpoint,origin}=JSON.parse(await fs.readFile(new URL('test-browser.json',local)));
const context=vm.createContext({});vm.runInContext((await fs.readFile(new URL('extension/config.js',local),'utf8'))+';globalThis.config=AUTH_CONFIG',context);
const {token,relay}=context.config;
const request=async(path,body)=>{const r=await fetch(relay+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
const wait=async fn=>{for(let i=0;i<100;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw Error('Test timed out');};
const browser=await puppeteer.connect({browserWSEndpoint:endpoint,defaultViewport:null});
const remote=(await browser.pages()).find(p=>p.url()===origin+'/');
const phone=await browser.newPage();
try{
  await phone.goto(origin+'/approval');
  console.log('Test approval context loaded');
  const cdp=await phone.createCDPSession();await cdp.send('WebAuthn.enable');
  console.log('Virtual authenticator domain enabled');
  await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  assert.equal((await fetch(relay+'/pending')).status,403);
  console.log('Unpaired relay check passed');
  for(const kind of ['create','get']){
    await remote.bringToFront();
    await remote.click('#'+kind);
    const r=await wait(async()=>(await request('/pending')).data[0]);
    await phone.bringToFront();
    const response=await phone.evaluate(async({kind,publicKey})=>{
      const options=kind==='create'?PublicKeyCredential.parseCreationOptionsFromJSON(publicKey):PublicKeyCredential.parseRequestOptionsFromJSON(publicKey);
      return (await navigator.credentials[kind]({publicKey:options})).toJSON();
    },r);
    assert.equal((await request('/complete',{id:r.id,response})).status,200);
    await wait(async()=>{const state=await(await fetch(origin+'/status')).json();return kind==='create'?state.registered:state.authenticated;});
    assert.equal((await request('/complete',{id:r.id,response})).status,400);
    console.log('PASS original verifier accepted '+kind+' from separate browser context; replay rejected');
  }
  await remote.bringToFront();await remote.click('#get');const pending=await wait(async()=>(await request('/pending')).data[0]);
  await remote.click('#cancel');await wait(async()=>!(await request('/pending')).data.length);
  assert.equal((await request('/complete',{id:pending.id,response:{}})).status,400);
  console.log('PASS unpaired access and late completion after cancellation rejected');
}finally{await phone.close();browser.disconnect();}
