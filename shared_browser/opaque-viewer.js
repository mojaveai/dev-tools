// Paint CDP snapshots of closed shadow roots over their rrweb host nodes.
// The interaction layer still forwards pointer coordinates to native Chrome.
export function paintOpaqueSurfaces(layer,mirror,surfaces) {
  const existing=new Map([...layer.querySelectorAll('img[data-opaque-id]')].map(image=>[image.dataset.opaqueId,image]));
  for(const surface of surfaces) {
    const key=String(surface.id);
    const host=mirror?.getNode(surface.id);
    if(!host?.getBoundingClientRect)continue;
    const rect=host.getBoundingClientRect();
    let image=existing.get(key);
    if(!image) {
      image=document.createElement('img');
      image.dataset.opaqueId=key;
      image.alt='';
      image.setAttribute('aria-hidden','true');
      image.style.cssText='position:absolute;pointer-events:none;user-select:none;max-width:none;z-index:0';
      layer.prepend(image);
    }
    const src='data:image/png;base64,'+surface.image;
    if(image.src!==src)image.src=src;
    image.style.left=(rect.left+surface.offsetX)+'px';
    image.style.top=(rect.top+surface.offsetY)+'px';
    image.style.width=surface.width+'px';
    image.style.height=surface.height+'px';
    existing.delete(key);
  }
  for(const image of existing.values())image.remove();
}
