// DOM mutations can precede the source browser's resource response. Keep the
// viewer request pending until those bytes arrive instead of returning a sticky
// broken image. This never fetches URLs independently of the source browser.
export class AssetDelivery {
  constructor(resources,{timeoutMs=15000}={}){this.resources=resources;this.timeoutMs=timeoutMs;this.pending=new Map();}
  get(url,signal){
    if(this.resources.has(url))return Promise.resolve(this.resources.get(url));
    if(signal?.aborted)return Promise.resolve(undefined);
    return new Promise(resolve=>{
      let timer;
      const finish=value=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);const set=this.pending.get(url);set?.delete(finish);if(!set?.size)this.pending.delete(url);resolve(value);};
      const abort=()=>finish(undefined);
      const set=this.pending.get(url)||new Set();set.add(finish);this.pending.set(url,set);
      timer=setTimeout(abort,this.timeoutMs);timer.unref?.();signal?.addEventListener('abort',abort,{once:true});
    });
  }
  available(url){for(const finish of [...(this.pending.get(url)||[])])finish(this.resources.get(url));}
}
export function rewriteStylesheet(text,tab,stylesheetURL){
  const asset=raw=>{
    if(/^(data:|blob:|#)/i.test(raw))return raw;
    try{const url=new URL(raw,stylesheetURL);if(!/^https?:$/.test(url.protocol))return raw;const hash=url.hash;url.hash='';return `/asset?tab=${encodeURIComponent(tab)}&url=${encodeURIComponent(url.href)}${hash}`;}catch{return raw;}
  };
  // Quoted CSS URLs may contain spaces; unquoted URLs may not. Leave inline
  // data and local SVG fragments untouched. Imported sheets use the same route.
  return text.replace(/url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s)'"]+))\s*\)/gi,(_,double,single,bare)=>`url("${asset(double??single??bare)}")`)
    .replace(/(@import\s+)(["'])([^"']+)\2/gi,(_,prefix,q,url)=>`${prefix}"${asset(url)}"`);
}
