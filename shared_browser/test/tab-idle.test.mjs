import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TabIdle,TAB_IDLE_MS} from '../tab-idle.mjs';
test('72-hour inactivity survives receiver restarts and activity resets the clock',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tab-idle-'));let now=1000;
 try{
  const file=path.join(dir,'state.json'),first=new TabIdle(file,{now:()=>now});await first.load();first.add('a');
  now+=TAB_IDLE_MS-1;assert.equal(first.expired('a'),false);await first.save(['a']);
  const next=new TabIdle(file,{now:()=>now});await next.load();next.add('a');now++;assert.equal(next.expired('a'),true);
  next.touch('a');assert.equal(next.expired('a'),false);next.add('new');assert.equal(next.expired('new'),false);
  await next.save(['new']);assert.equal(JSON.parse(await fs.readFile(file)).a,undefined);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('cleanup closes only expired idle tabs, preserving viewed pages, dialogs, choosers and edits',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tab-cleanup-'));let now=0;const closed=[];
 try{
  const tracker=new TabIdle(path.join(dir,'state.json'),{now:()=>now});
  const tabs=['idle','viewed','dialog','chooser','edited','recent'].map(id=>({id,targetId:id,
   dialog:id==='dialog',chooser:id==='chooser',page:{evaluate:async()=>id==='edited',close:async options=>{assert.equal(options.runBeforeUnload,true);closed.push(id);}}}));
  for(const t of tabs)tracker.add(t.id);
  now=TAB_IDLE_MS;tracker.touch('recent');
  await tracker.sweep(tabs,{active:'viewed',hasViewers:true});
  assert.deepEqual(closed,['idle']);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
