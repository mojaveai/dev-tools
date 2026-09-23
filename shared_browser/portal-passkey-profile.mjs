export function portalProfile(env={}) {
  if(env.PORTAL_PROFILE && env.PORTAL_PROFILE!=='canonical-dev')throw Error('Unknown portal profile');
  const canonical=env.PORTAL_PROFILE==='canonical-dev';
  const origin=canonical?'https://procbox.agent-trace.ts.net:3581':env.PORTAL_ORIGIN || 'https://procbox.agent-trace.ts.net:23581';
  if(canonical && env.PORTAL_ORIGIN && env.PORTAL_ORIGIN!==origin)throw Error('Canonical origin is fixed');
  if(canonical && env.PORTAL_VIEWER_ORIGIN && env.PORTAL_VIEWER_ORIGIN!=='https://procbox.agent-trace.ts.net:8443')throw Error('Canonical viewer origin is fixed');
  return {origin,names:canonical?'__canonicalPortalPasskey':'__portalPasskey',edgeIdentity:canonical?'canonical-dev-dashboard':'qa-dashboard',port:canonical?8798:Number(env.PORTAL_BRIDGE_PORT || 8797)};
}
export function portalHook(source,profile) {
  return source.replaceAll('https://procbox.agent-trace.ts.net:23581',new URL(profile.origin).origin).replaceAll('__portalPasskey',profile.names);
}

// Canonical mode never consults user-selected browser settings or legacy endpoints.
export async function canonicalBrowserConnection() {
  const fs=await import('node:fs/promises'),{constants}=await import('node:fs');
  const {loopbackEndpoint}=await import('./browser-endpoint.mjs');
  const file='/home/manbir/.local/state/dev-tools/shared-browser-primary/browser-host.json';
  const owners=new Set([0,process.getuid()]);
  for(let p=file;p!=='/';p=p.slice(0,p.lastIndexOf('/')) || '/') {
    const s=await fs.lstat(p);
    if(s.isSymbolicLink() || !owners.has(s.uid) || (s.mode&0o022))throw Error('Untrusted canonical browser descriptor path');
  }
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await handle.stat();
    if(!stat.isFile() || !owners.has(stat.uid) || (stat.mode&0o022) || stat.size>16384)throw Error('Untrusted canonical browser descriptor');
    const descriptor=JSON.parse(await handle.readFile('utf8'));
    return {browserWSEndpoint:loopbackEndpoint(descriptor.browserWSEndpoint)};
  } finally {await handle.close();}
}
