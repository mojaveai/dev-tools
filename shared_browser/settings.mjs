// One persistent selection for MCP, CLI, receiver, Chrome host and passkey
// helper. Read per connection so clients do not retain a previous default.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export async function browserSettings({env=process.env,home=os.homedir()}={}) {
  const file=path.join(home,'.config/dev-tools/shared-browser.json');
  let config={};
  try {config=JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const stateDir=env.SHARED_BROWSER_STATE || config.stateDir || path.join(home,'.local/state/dev-tools/shared-browser');
  const chrome=env.SHARED_BROWSER_CHROME || config.chrome || '';
  const hostService=env.SHARED_BROWSER_HOST_SERVICE || config.hostService || 'dev-tools-shared-chrome.service';
  // These values are also written into systemd units by the installer.
  for(const [name,value] of [['stateDir',stateDir],['chrome',chrome]])
    if(typeof value!=='string' || (value && (!path.isAbsolute(value) || /[\r\n\0"\\%]/.test(value))))
      throw Error(`Invalid shared-browser ${name} in ${file}`);
  if(typeof hostService!=='string' || !/^[a-zA-Z0-9_-]+\.service$/.test(hostService))
    throw Error(`Invalid shared-browser hostService in ${file}`);
  return {stateDir,chrome,hostService};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const settings=await browserSettings();
  if(!(process.argv[2] in settings))throw Error('Use stateDir, chrome, or hostService');
  console.log(settings[process.argv[2]]);
}
