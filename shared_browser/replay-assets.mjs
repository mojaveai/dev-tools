// Only rewrite render assets; navigation links and user text remain untouched.
export function rewriteAssets(event, tab, pageURL='https://invalid.local/') {
  const clone=structuredClone(event);
  const asset=raw=>{
    if(!/^(https?:|\/\/)/i.test(raw))return raw;
    try {
      const url=new URL(raw,pageURL),fragment=url.hash;
      url.hash=''; // Chrome caches the fetched resource, without its SVG fragment.
      return `/asset?tab=${encodeURIComponent(tab)}&url=${encodeURIComponent(url.href)}${fragment}`;
    }catch{return raw;}
  };
  const css=text=>text.replace(/url\(\s*(['"]?)((?:https?:|\/\/)[^)'"\s]+)\1\s*\)/gi,(_,q,url)=>`url("${asset(url)}")`);
  const walk=value=>{
    if(!value || typeof value!=='object')return;
    if(value.attributes){
      const a=value.attributes;
      for(const key of ['src','poster','xlink:href'])if(typeof a[key]==='string')a[key]=asset(a[key]);
      if(value.tagName==='link' && /^(preload|modulepreload|prefetch|preconnect|dns-prefetch)$/.test(a.rel || '')) {delete a.href;delete a.imagesrcset;}
      if(['link','use','image'].includes(value.tagName) && typeof a.href==='string')a.href=asset(a.href);
      if(a.srcset)delete a.srcset;
      for(const key of ['style','_cssText'])if(typeof a[key]==='string')a[key]=css(a[key]);
    }
    if(value.type===3 && value.isStyle && typeof value.textContent==='string')value.textContent=css(value.textContent);
    for(const [key,v] of Object.entries(value)) {
      if(['rule','replace','replaceSync'].includes(key) && typeof v==='string')value[key]=css(v);
      else if(typeof v==='object')Array.isArray(v)?v.forEach(walk):walk(v);
    }
  };
  walk(clone);
  if(clone.type===3 && clone.data.source===10 && !clone.data.buffer)clone.data.fontSource=css(clone.data.fontSource);
  if(clone.type===3 && clone.data.source===13 && typeof clone.data.set?.value==='string')clone.data.set.value=css(clone.data.set.value);
  return clone;
}
