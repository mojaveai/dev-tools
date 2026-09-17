import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {browserSettings} from './settings.mjs';

const run=promisify(execFile);
let ensured;
export async function startServices() {
  const {stateDir}=await browserSettings();
  if(await fs.stat(path.join(stateDir,'supervisor.conf')).then(()=>true,()=>false)) {
    await run('python3',[fileURLToPath(new URL('./services.py',import.meta.url)),'start',stateDir],{timeout:55000});
  } else {
    await run('systemctl',['--user','start','dev-tools-shared-browser.service'],{timeout:30000});
  }
}

export async function ensureServices() {
  const {stateDir}=await browserSettings();
  // Container services restart on first use after a pod restart, before an
  // action is dispatched. Never retry an action following a disconnect.
  if(!await fs.stat(path.join(stateDir,'supervisor.conf')).then(()=>true,()=>false))return;
  const socketExists=await fs.stat(path.join(stateDir,'server.sock')).then(()=>true,()=>false);
  if(ensured && socketExists)return;
  if(!socketExists)ensured=null;
  ensured ??= startServices().catch(error=>{ensured=null;throw error;});
  await ensured;
  for(let n=0;n<150;n++) {
    if(await fs.stat(path.join(stateDir,'server.sock')).then(()=>true,()=>false))return;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw Error('Shared browser startup timed out; inspect receiver.log and chrome.log in '+stateDir);
}
