// Preserve tab addresses during the one-time engine migration. Receiver-only
// updates keep the existing Chrome process and do not need restoration.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {rpc} from './rpc.mjs';
const state=process.env.SHARED_BROWSER_STATE||path.join(os.homedir(),'.local/state/dev-tools/shared-browser');
const file=path.join(state,'engine-migration-tabs.json');
if(process.argv[2]==='save'){
  const s=await rpc('state');
  const tabs=s.tabs.filter(t=>t.id!==s.activeTab).concat(s.tabs.filter(t=>t.id===s.activeTab));
  await fs.writeFile(file,JSON.stringify(tabs.map(({url})=>url)),{mode:0o600});await fs.chmod(file,0o600);
  console.log('Saved '+tabs.length+' tab addresses for engine migration.');
}else if(process.argv[2]==='restore'){
  const urls=JSON.parse(await fs.readFile(file,'utf8'));
  let current;
  for(let i=0;i<150;i++){
    try{current=await rpc('state');break;}catch(error){if(i===149)throw error;await new Promise(r=>setTimeout(r,200));}
  }
  const used=new Set();let failed=0;
  for(const url of urls){
    const found=current.tabs.find(t=>!used.has(t.id)&&t.url===url);if(found){used.add(found.id);continue;}
    try{await rpc('js',{context:'engine-migration',code:'await (await cua.getBrowser()).tabs.new('+JSON.stringify(url)+');'});}
    catch{failed++;}
  }
  if(failed)throw Error(failed+' tab addresses could not be reopened; private recovery list retained at '+file);
  await fs.unlink(file);console.log('Restored tab addresses after engine migration.');
}else throw Error('Use save or restore');
