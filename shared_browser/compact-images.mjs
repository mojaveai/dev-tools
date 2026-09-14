// Preserve inline-only images. When original bytes are already in the relay,
// repeated DOM nodes can share that URL instead of repeating a base64 bitmap.
export function compactImages(event, available) {
  const walk=node=>{
    if(!node || typeof node!=='object')return;
    if(node.tagName==='img' && node.attributes?.rr_dataURL && available.has(node.attributes.src))
      delete node.attributes.rr_dataURL;
    for(const value of Object.values(node))
      if(value && typeof value==='object')Array.isArray(value)?value.forEach(walk):walk(value);
  };
  walk(event);return event;
}
