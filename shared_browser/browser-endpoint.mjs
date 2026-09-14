import fs from 'node:fs/promises';
import path from 'node:path';
import {browserSettings} from './settings.mjs';

export function loopbackEndpoint(value) {
  const u=new URL(value);
  if(!['http:','ws:'].includes(u.protocol) || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.username || u.password)
    throw Error('Browser endpoint must be uncredentialed loopback HTTP or WebSocket');
  return u.href;
}

// Re-resolve on every reconnect. Native Chrome uses a nonzero debugging port
// and does not update the legacy DevToolsActivePort file in its profile.
export async function browserConnection({stateDir,endpoint}={}) {
  if(endpoint)return {browserWSEndpoint:loopbackEndpoint(endpoint)};
  stateDir ||= (await browserSettings()).stateDir;
  try {
    const host=JSON.parse(await fs.readFile(path.join(stateDir,'browser-host.json'),'utf8'));
    return {browserWSEndpoint:loopbackEndpoint(host.browserWSEndpoint)};
  } catch(error) {
    // A malformed/unsafe managed endpoint must not silently select an older
    // browser. The old file is supported only when no host file exists.
    if(error.code!=='ENOENT')throw error;
  }
  const [port]= (await fs.readFile(path.join(stateDir,'profile/DevToolsActivePort'),'utf8')).split('\n');
  if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535)throw Error('Invalid legacy browser port');
  return {browserURL:'http://127.0.0.1:'+port};
}
