import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Read the receiver's installed dependency, before its unit is replaced. The
// new settings file already names the destination and cannot identify the old
// browser. Disabling startup alone leaves its authenticated tabs polling.
export function retirePreviousHost(next, run = args => execFileSync('systemctl', ['--user', ...args], {encoding:'utf8'})) {
  if (!/^[a-zA-Z0-9_-]+\.service$/.test(next)) throw Error('Invalid destination browser service');
  const dependencies = run(['show', 'dev-tools-shared-browser.service', '--property=Wants', '--value']).trim().split(/\s+/);
  const previous = dependencies.filter(name => /^dev-tools-shared-chrome(?:-[a-zA-Z0-9_-]+)?\.service$/.test(name));
  if (previous.length > 1) throw Error('Multiple browser host dependencies; resolve the migration explicitly');
  const host = previous[0];
  if (!host || host === next) return null;
  const command = run(['show', host, '--property=ExecStart', '--value']);
  if (!/\/browser-host\.mjs(?:\s|;|$)/.test(command)) throw Error('Previous host is not a managed shared browser');
  run(['disable', '--now', host]);
  return host;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const retired = retirePreviousHost(process.argv[2]);
  if (retired) console.log(`Stopped retired browser ${retired}; its profile is preserved.`);
}
