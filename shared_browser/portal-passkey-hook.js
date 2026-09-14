(() => {
  if(location.origin !== 'https://procbox.agent-trace.ts.net:23581' || location.pathname.startsWith('/_shared-browser-passkey') || window.__portalPasskeyHook) return;
  window.__portalPasskeyHook=true;
  const nativeGet=navigator.credentials.get.bind(navigator.credentials);
  const encode=value=>{const a=value instanceof ArrayBuffer?new Uint8Array(value):new Uint8Array(value.buffer,value.byteOffset,value.byteLength);let s='';for(const b of a)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
  const decode=value=>{const s=atob(value.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(s,c=>c.charCodeAt(0)).buffer;};
  navigator.credentials.get=async options=>{
    if(!options?.publicKey)return nativeGet(options);
    if(options.signal?.aborted)throw new DOMException('Request canceled','AbortError');
    const pk=options.publicKey;
    const id=await window.__portalPasskeyStart({...pk,challenge:encode(pk.challenge),allowCredentials:pk.allowCredentials?.map(c=>({...c,id:encode(c.id)}))});
    const abort=()=>window.__portalPasskeyCancel(id).catch(()=>{});
    options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted)abort();
    try {
      const result=await window.__portalPasskeyWait(id);
      if(options.signal?.aborted)throw new DOMException('Request canceled','AbortError');
      if(result.error)throw new DOMException(result.error,'NotAllowedError');
      const response=Object.create(AuthenticatorAssertionResponse.prototype);
      for(const name of ['authenticatorData','clientDataJSON','signature','userHandle'])Object.defineProperty(response,name,{value:result.response[name]?decode(result.response[name]):null});
      const credential=Object.create(PublicKeyCredential.prototype);
      Object.defineProperties(credential,{id:{value:result.id},rawId:{value:decode(result.rawId)},type:{value:'public-key'},authenticatorAttachment:{value:result.authenticatorAttachment || null},response:{value:response},getClientExtensionResults:{value:()=>result.clientExtensionResults || {}},toJSON:{value:()=>result}});
      return credential;
    } finally {options.signal?.removeEventListener('abort',abort);}
  };
})();
