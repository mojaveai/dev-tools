export function localOptions(kind,options,origin){
  if(!['create','get'].includes(kind))throw Error('Unsupported operation');
  // Chromium inserts this after validating the caller origin and RP. It refuses
  // to proxy already-overridden requests. Never obtain caller origin from a tab title.
  const copy=structuredClone(options);
  const override=copy.extensions?.remoteDesktopClientOverride;
  if(override?.origin!==origin||override.sameOriginWithAncestors!==true)
    throw Error('Unsupported origin or cross-origin frame');
  delete copy.extensions.remoteDesktopClientOverride;
  // Safari runs at the actual origin; no remote-origin override is needed there.
  return copy;
}
