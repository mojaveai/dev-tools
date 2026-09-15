import fs from 'node:fs/promises';
export const TAB_IDLE_MS=72*60*60*1000;
export class TabIdle {
  constructor(file,{now=Date.now}={}) {this.file=file;this.now=now;this.times=new Map();this.pending=Promise.resolve();}
  async load(){try{const saved=JSON.parse(await fs.readFile(this.file,'utf8'));for(const [id,at] of Object.entries(saved))if(Number.isFinite(at))this.times.set(id,at);}catch(e){if(e.code!=='ENOENT')throw e;}}
  touch(id){if(id)this.times.set(id,this.now());}
  add(id){if(!this.times.has(id))this.touch(id);}
  expired(id){const at=this.times.get(id);return at!==undefined && this.now()-at>=TAB_IDLE_MS;}
  async sweep(tabs,{active,hasViewers}){
  for(const tab of tabs){
    if(hasViewers && tab.id===active){this.touch(tab.targetId);continue;}
    if(!this.expired(tab.targetId) || tab.dialog || tab.chooser)continue;
    const busy=await tab.page.evaluate(()=>{
      if(window.__portalPasskeyPending)return true;
      return [...document.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=true]')].some(e=>
        e.isContentEditable || (e.type==='checkbox'||e.type==='radio' ? e.checked!==e.defaultChecked :
        e.tagName==='SELECT' ? [...e.options].some(o=>o.selected!==o.defaultSelected) : e.value!==e.defaultValue));
    }).catch(()=>true);
    if(!busy)await tab.page.close({runBeforeUnload:true});
  }
  await this.save(tabs.map(t=>t.targetId));
  }
  async save(ids){const live=new Set(ids);for(const id of this.times.keys())if(!live.has(id))this.times.delete(id);const data=JSON.stringify(Object.fromEntries(this.times));this.pending=this.pending.catch(()=>{}).then(async()=>{await fs.writeFile(this.file+'.tmp',data,{mode:0o600});await fs.rename(this.file+'.tmp',this.file);});return this.pending;}
}
