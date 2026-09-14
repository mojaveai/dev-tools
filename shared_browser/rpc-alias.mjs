// MCP processes started before profile selection was configurable still use
// this socket path. Keep them attached to the same receiver as new clients.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {browserSettings} from './settings.mjs';

export async function installRpcAlias({stateDir,home=os.homedir()}) {
  const alias=path.join(home,'.local/state/dev-tools/shared-browser/server.sock');
  const target=path.join(stateDir,'server.sock');
  if(path.resolve(alias)===path.resolve(target))return;
  await fs.mkdir(path.dirname(alias),{recursive:true,mode:0o700});
  let stat;
  try{stat=await fs.lstat(alias);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(stat && !stat.isSymbolicLink())
    throw Error('RPC compatibility path is occupied; preserve the existing receiver before migrating: '+alias);
  if(stat && path.resolve(path.dirname(alias),await fs.readlink(alias))===path.resolve(target))return;
  const temp=alias+'.'+randomUUID();
  try{await fs.symlink(target,temp);await fs.rename(temp,alias);}
  finally{await fs.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  await installRpcAlias(await browserSettings());
