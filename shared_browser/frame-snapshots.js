// A top-level rrweb snapshot cannot read cross-origin descendants. Ask each
// child recorder for its current document; rrweb relays it with mapped node IDs.
// Kept self-contained so an existing Chrome session can receive this repair.
export function installFrameSnapshots() {
  if (window.__sharedFrameSnapshots) return;
  window.__sharedFrameSnapshots=true;
  let snapshot;
  const wrap=fn=>typeof fn!=='function'?fn:()=>{
    try { fn(); } catch (error) {
      // Same-origin child documents are recorded by their parent, so their
      // local rrweb instance has no full-snapshot function.
      if(window===window.top) throw error;
    }
    for(let i=0;i<window.frames.length;i++)
      window.frames[i].postMessage({type:'shared-browser:snapshot-children'},'*');
  };
  snapshot=wrap(window.__sharedSnapshot);
  Object.defineProperty(window,'__sharedSnapshot',{configurable:true,get:()=>snapshot,set:fn=>{snapshot=wrap(fn);}});
  addEventListener('message',event=>{
    if(window!==window.top && event.source===window.parent && event.data?.type==='shared-browser:snapshot-children')
      window.__sharedSnapshot?.();
  });
}
