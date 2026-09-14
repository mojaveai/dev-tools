// Reattach to a live page without reloading it. Only recover asset URLs that
// Chrome reports as loaded by this page/frame tree, never arbitrary viewer URLs.
export async function resourceRecovery(clients, remember, {maxBytes=8*1024*1024}={}) {
  let known=new Map(),refreshing;
  // A tab can navigate or add frames after attachment. Rebuild the allowlist
  // on a cache miss, sharing one scan across simultaneous icon requests.
  const refresh=()=>refreshing ||= (async()=>{
    const next=new Map(),current=typeof clients==='function'?clients():clients;
    for(const cdp of Array.isArray(current)?current:[current])try {
      const {frameTree}=await cdp.send('Page.getResourceTree'),frames=[];
      const visit=node=>{
        frames.push(node.frame);
        for(const resource of node.resources||[])
          if(['Stylesheet','Image','Font'].includes(resource.type) && !resource.failed && !resource.canceled)
            next.set(resource.url,{cdp,frameId:node.frame.id,type:resource.mimeType,kind:resource.type});
        for(const child of node.childFrames||[])visit(child);
      };
      visit(frameTree);
      await Promise.all(frames.map(async frame=>{
        try {
          // The renderer tree can omit cached CSS backgrounds. Read the native
          // Resource Timing buffer in an isolated world so page scripts cannot
          // forge this allowlist by replacing performance.getEntriesByType.
          const {executionContextId}=await cdp.send('Page.createIsolatedWorld',{
            frameId:frame.id,worldName:'shared-browser-resource-recovery',
          },{timeout:2000});
          const {result}=await cdp.send('Runtime.evaluate',{
            contextId:executionContextId,returnByValue:true,
            expression:'performance.getEntriesByType("resource").filter(e=>e.initiatorType==="css"&&(!e.responseStatus||e.responseStatus<400)).map(e=>e.name)',
          },{timeout:2000});
          for(const url of result.value||[])if(!next.has(url))next.set(url,{cdp,frameId:frame.id,kind:'CSSAsset'});
        } catch {}
      }));
    } catch {}
    known=next;
  })().finally(()=>{refreshing=undefined;});
  return async url=>{
    await refresh();
    const source=known.get(url);if(!source)return;
    const cdp=source.cdp;
    let bytes,type=source.type;
    try {
      const value=await cdp.send('Page.getResourceContent',{frameId:source.frameId,url},{timeout:5000});
      bytes=Buffer.from(value.content,value.base64Encoded?'base64':'utf8');
    } catch {
      // Font and CSS background bodies may be absent from the renderer store. Ask
      // Chrome's own loader/cache in the original frame's credential context.
      // Do not repeat <img> challenge requests or re-fetch old stylesheets.
      if(!['Font','CSSAsset'].includes(source.kind))return;
      let stream;
      try {
        const {resource}=await cdp.send('Network.loadNetworkResource',{
          frameId:source.frameId,url,options:{disableCache:false,includeCredentials:true},
        },{timeout:5000});
        stream=resource.stream;
        if(!resource.success || !stream)return;
        type ||= Object.entries(resource.headers||{}).find(([name])=>name.toLowerCase()==='content-type')?.[1];
        const chunks=[];let total=0;
        while(true){
          const value=await cdp.send('IO.read',{handle:stream,size:65536},{timeout:5000});
          const chunk=Buffer.from(value.data,value.base64Encoded?'base64':'utf8');
          total+=chunk.length;if(total>maxBytes)return;chunks.push(chunk);
          if(value.eof)break;
        }
        bytes=Buffer.concat(chunks);
      } finally {
        if(stream)await cdp.send('IO.close',{handle:stream}).catch(()=>{});
      }
    }
    if(bytes.length<=maxBytes)remember(url,{bytes,type:type||'application/octet-stream'});
  };
}
