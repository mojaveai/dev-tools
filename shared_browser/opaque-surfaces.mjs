import { createHash } from 'node:crypto';

// Closed shadow roots are deliberately invisible to page JavaScript and rrweb.
// CDP can locate their hosts without changing attachShadow or the site's DOM.
export function closedShadowHosts(root) {
  const hosts=[];
  function visit(node, insideClosed=false) {
    if (!node) return;
    const closed=node.shadowRoots?.some(shadow=>shadow.shadowRootType==='closed');
    if (closed && !insideClosed && node.backendNodeId) hosts.push(node.backendNodeId);
    for (const child of node.children||[]) visit(child,insideClosed);
    for (const shadow of node.shadowRoots||[]) visit(shadow,insideClosed||shadow.shadowRootType==='closed');
    if (node.contentDocument) visit(node.contentDocument,insideClosed);
  }
  visit(root);
  return hosts;
}

export async function captureOpaqueSurfaces(page, cdp) {
  const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});
  const hosts=closedShadowHosts(root), surfaces=[];
  let pixelsRemaining=2_000_000;
  for (const backendNodeId of hosts.slice(0,12)) {
    let objectId;
    try {
      ({object:{objectId}}=await cdp.send('DOM.resolveNode',{backendNodeId}));
      if (!objectId) continue;
      const {result}=await cdp.send('Runtime.callFunctionOn',{objectId,returnByValue:true,functionDeclaration:`function() {
        const r=this.getBoundingClientRect();
        return {id:window.__sharedMirror?.getId(this),x:r.x,y:r.y,width:r.width,height:r.height,
          viewportWidth:innerWidth,viewportHeight:innerHeight};
      }`});
      const box=result.value;
      if (!Number.isInteger(box?.id) || box.id<0) continue;
      const x=Math.max(0,box.x),y=Math.max(0,box.y);
      const right=Math.min(box.viewportWidth,box.x+box.width);
      const bottom=Math.min(box.viewportHeight,box.y+box.height);
      const width=Math.floor(right-x),height=Math.floor(bottom-y);
      if (width<1 || height<1 || width*height>1_500_000 || width*height>pixelsRemaining) continue;
      const image=await page.screenshot({type:'png',encoding:'base64',clip:{x,y,width,height},captureBeyondViewport:false});
      if(image.length>4_000_000)continue;
      pixelsRemaining-=width*height;
      surfaces.push({id:box.id,offsetX:x-box.x,offsetY:y-box.y,width,height,image});
    } catch { /* A host may disappear while the challenge updates. */ }
    finally {if(objectId)await cdp.send('Runtime.releaseObject',{objectId}).catch(()=>{});}
  }
  return surfaces;
}

export function opaqueSignature(surfaces) {
  const hash=createHash('sha256');
  for(const surface of surfaces)hash.update(`${surface.id}:${surface.offsetX}:${surface.offsetY}:${surface.width}:${surface.height}:`).update(surface.image);
  return hash.digest('hex');
}
