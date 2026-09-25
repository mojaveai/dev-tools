// Own a normal desktop Chrome independently of the DOM receiver. Xvfb renders
// locally; no desktop/video listener is started. Keep Chrome's normal properties.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';
import {loopbackEndpoint} from './browser-endpoint.mjs';
import {browserSettings} from './settings.mjs';
export {loopbackEndpoint} from './browser-endpoint.mjs';

export function xauthority(cookie) {
  const field=value=>{const b=Buffer.isBuffer(value)?value:Buffer.from(value);const n=Buffer.alloc(2);n.writeUInt16BE(b.length);return Buffer.concat([n,b]);};
  // FamilyWild permits the display chosen by Xvfb -displayfd. The random cookie
  // and its private file still authenticate both Chrome and the X server.
  return Buffer.concat([Buffer.from([255,255]),field(''),field(''),field('MIT-MAGIC-COOKIE-1'),field(cookie)]);
}

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort() {
  const s=net.createServer();await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve);});
  const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port;
}
function outputLine(child,stream,match,label) {
  return new Promise((resolve,reject)=>{
    let data='';const timer=setTimeout(()=>done(Error(label+' readiness timed out')),30000);
    const onData=chunk=>{data=(data+chunk).slice(-8192);const value=match(data);if(value)done(null,value);};
    const onExit=(code,signal)=>done(Error(label+' exited before readiness ('+(signal||code)+')'));
    const onError=error=>done(error);
    function done(error,value){clearTimeout(timer);stream.off('data',onData);child.off('exit',onExit);child.off('error',onError);error?reject(error):resolve(value);}
    stream.on('data',onData);child.once('exit',onExit);child.once('error',onError);
  });
}
async function terminate(child) {
  if(!child || child.exitCode!==null || child.signalCode)return;
  child.kill('SIGTERM');
  for(let i=0;i<50 && child.exitCode===null && !child.signalCode;i++)await delay(100);
  if(child.exitCode===null && !child.signalCode)child.kill('SIGKILL');
}
async function closeChrome(endpoint) {
  if(!endpoint)return;
  await new Promise(resolve=>{
    const ws=new WebSocket(endpoint);const timer=setTimeout(()=>{ws.terminate();resolve();},3000);
    ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'Browser.close'})));
    const done=()=>{clearTimeout(timer);resolve();};ws.on('close',done);ws.on('error',done);
  });
}

export async function runBrowserHost() {
  const settings=await browserSettings();
  const state=settings.stateDir;
  const executable=settings.chrome||'/usr/bin/google-chrome';
  await fs.mkdir(state,{recursive:true,mode:0o700});
  // Strictly confined Snap Chromium may read its own common data directory,
  // but cannot read the hidden dev-tools state directory in HOME.
  const snap=executable.startsWith('/snap/bin/chromium');
  const browserData=snap?path.join(process.env.HOME,'snap/chromium/common/dev-tools-shared-browser'):state;
  await fs.mkdir(browserData,{recursive:true,mode:0o700});
  // OS advisory locking is supplied by the systemd unit's flock. The endpoint
  // file is published only after the owned Chrome process announces readiness.
  const endpointFile=path.join(state,'browser-host.json');
  const auth=path.join(browserData,'browser-host.Xauthority');
  let display,chrome,endpoint,stopping=false;
  const stop=async(code=0)=>{
    if(stopping)return;stopping=true;
    await fs.unlink(endpointFile).catch(()=>{});
    await closeChrome(endpoint);await terminate(chrome);await terminate(display);
    await fs.unlink(auth).catch(()=>{});process.exit(code);
  };
  process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
  try {
    await fs.unlink(endpointFile).catch(()=>{});
    await fs.writeFile(auth,xauthority(randomBytes(16)),{mode:0o600});await fs.chmod(auth,0o600);
    display=spawn(process.env.SHARED_BROWSER_XVFB||'/usr/bin/Xvfb',[
      '-displayfd','3','-screen','0','2560x1600x24','-auth',auth,'-nolisten','tcp',
    ],{stdio:['ignore','ignore','pipe','pipe']});
    display.stderr.resume();
    const number=await outputLine(display,display.stdio[3],text=>text.match(/^(\d+)\n/)?.[1],'Xvfb');
    display.once('exit',()=>{if(!stopping)void stop(1);});
    const port=await freePort();
    chrome=spawn(executable,[
      '--user-data-dir='+path.join(browserData,'profile'),
      '--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,
      '--no-first-run','--no-default-browser-check','--disable-dev-shm-usage',
      '--window-size=1280,900','about:blank',
    ],{env:{...process.env,DISPLAY:':'+number,XAUTHORITY:auth},stdio:['ignore','ignore','pipe']});
    endpoint=await outputLine(chrome,chrome.stderr,text=>text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/)?.[1],'Chrome');
    chrome.stderr.resume();loopbackEndpoint(endpoint);
    if(Number(new URL(endpoint).port)!==port)throw Error('Chrome announced an unexpected debugging port');
    chrome.once('exit',()=>{if(!stopping)void stop(1);});
    const temp=endpointFile+'.'+process.pid;
    await fs.writeFile(temp,JSON.stringify({engine:'native',browserWSEndpoint:endpoint,pid:chrome.pid,display:Number(number),startedAt:new Date().toISOString()})+'\n',{mode:0o600});
    await fs.rename(temp,endpointFile);
    console.log(JSON.stringify({event:'browser-ready',engine:'native',display:Number(number)}));
    // Keep ownership in this process until a signal or child exit.
    await new Promise(()=>{});
  } catch(error) {
    console.error('Browser host failed: '+error.message);await stop(1);
  }
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runBrowserHost();
