// Controlled manual-solver diagnostic. No challenge answer inference or token capture.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createInterface} from 'node:readline';import puppeteer from 'puppeteer-core';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),wait=ms=>new Promise(r=>setTimeout(r,ms));
const servicePort=Number(process.env.TRIAL_SERVICE_PORT||8792),cdpPort=Number(process.env.TRIAL_CDP_PORT||46415),origin=process.env.TRIAL_ORIGIN||'https://procbox.agent-trace.ts.net:8444';
const out=await fs.mkdtemp('/tmp/captcha-trials-');await fs.chmod(out,0o700);
const proxySockets=new Set();const proxy=http.createServer((req,res)=>{const p=http.request('http://127.0.0.1:'+servicePort+req.url,{headers:{...req.headers,'tailscale-user-login':'manbir@asgroup.ai'}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});p.on('error',()=>res.end());req.pipe(p);});
proxy.on('connection',s=>{proxySockets.add(s);s.on('close',()=>proxySockets.delete(s));});
proxy.on('upgrade',(req,socket,head)=>{const p=http.request('http://127.0.0.1:'+servicePort+req.url,{headers:{...req.headers,'tailscale-user-login':'manbir@asgroup.ai',origin}});p.on('upgrade',(r,up,uphead)=>{socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(r.headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');if(head.length)up.write(head);if(uphead.length)socket.write(uphead);socket.pipe(up).pipe(socket);socket.on('error',()=>up.destroy());up.on('error',()=>socket.destroy());socket.on('close',()=>up.destroy());up.on('close',()=>socket.destroy());});p.on('error',()=>socket.destroy());p.end();});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const sourceBrowser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+cdpPort,defaultViewport:null});
const status=()=>fetch('http://127.0.0.1:'+servicePort+'/status',{headers:{'tailscale-user-login':'manbir@asgroup.ai'}}).then(r=>r.json());
let st=await status(),expected=st.tabs.find(t=>t.id===st.activeTab),source;
for(const p of await sourceBrowser.pages())if(await p.evaluate(()=>window.__sharedGeneration).catch(()=>null)===expected.generation){source=p;break;}
if(!source || source.url()!=='https://www.google.com/recaptcha/api2/demo')throw Error('Select the public demo before running');
const viewerBrowser=await puppeteer.launch({executablePath:process.env.SHARED_BROWSER_CHROME,headless:true,args:['--disable-dev-shm-usage']});const viewer=await viewerBrowser.newPage();await viewer.setViewport(await source.evaluate(()=>({width:innerWidth,height:innerHeight})));await viewer.goto('http://127.0.0.1:'+proxy.address().port);await viewer.waitForFunction(()=>getComputedStyle(document.querySelector('#viewport')).visibility==='visible');
const instrument=()=>{if(window.__trialEvents)return;window.__trialEvents=[];for(const type of ['pointermove','pointerdown','pointerup','mousemove','mousedown','mouseup','click','focus','blur','visibilitychange'])addEventListener(type,e=>{const a=window.__trialEvents;a.push({type,time:e.timeStamp,x:e.clientX,y:e.clientY,screenX:e.screenX,screenY:e.screenY,buttons:e.buttons,button:e.button,detail:e.detail,pointerType:e.pointerType,pressure:e.pressure,width:e.width,height:e.height,trusted:e.isTrusted,target:e.target?.id||e.target?.tagName,focus:document.hasFocus(),visibility:document.visibilityState});if(a.length>500)a.shift();},{capture:true});};
async function instruments(){for(const f of source.frames())await f.evaluate(instrument).catch(()=>{});}
const audit=doc=>{const cache=new Map(),hash=i=>{if(cache.has(i.src))return cache.get(i.src);try{const c=doc.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;const x=c.getContext('2d');x.drawImage(i,0,0);let h=2166136261;for(const b of x.getImageData(0,0,c.width,c.height).data)h=Math.imul(h^b,16777619);const v=[c.width,c.height,h>>>0].join(':');cache.set(i.src,v);return v}catch(e){return e.name}};return {text:doc.body?.innerText,images:[...doc.images].map(i=>({pixels:hash(i),loaded:i.complete&&!!i.naturalWidth,selected:i.closest('td')?.className.split(' ').filter(x=>x!==':hover').join(' ')})),tiles:[...doc.querySelectorAll('td')].map((e,i)=>{const r=e.getBoundingClientRect();return {cell:i+1,selected:e.className.split(' ').filter(x=>x!==':hover').join(' '),x:r.x,y:r.y,width:r.width,height:r.height};})};};
// Pixel means distinguish harmless decoder rounding from different/stale content.
const imageDetails=doc=>[...new Map([...doc.images].map(i=>[i.src,i])).values()].map(i=>{
 const c=doc.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;c.getContext('2d').drawImage(i,0,0);
 const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data,sums=Array(48).fill(0),counts=Array(16).fill(0);
 for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const cell=Math.floor(y*4/c.height)*4+Math.floor(x*4/c.width);counts[cell]++;for(let k=0;k<3;k++)sums[cell*3+k]+=d[(y*c.width+x)*4+k];}
 return {src:i.src,width:c.width,height:c.height,means:sums.map((v,j)=>Math.round(v/counts[Math.floor(j/3)]*100)/100)};
});
let trial,seq=0,osOffset,lastCommand;
async function assets(){
 const f=source.frames().find(f=>f.url().includes('/bframe'));if(!f)throw Error('No challenge frame');
 const details=await f.evaluate('('+imageDetails.toString()+')(document)');
 for(const detail of details){const u=new URL('/asset','http://127.0.0.1:'+servicePort);u.searchParams.set('tab',expected.id);u.searchParams.set('url',detail.src);const r=await fetch(u,{headers:{'tailscale-user-login':'manbir@asgroup.ai'}});if(!r.ok)throw Error('Missing cached image');const bytes=Buffer.from(await r.arrayBuffer());detail.bytes=bytes.length;detail.sha256=createHash('sha256').update(bytes).digest('hex');}
 await fs.appendFile(path.join(out,'assets.jsonl'),JSON.stringify({time:new Date().toISOString(),trial,details})+'\n');
 console.log(JSON.stringify({assets:details.map(({src,...rest})=>rest)}));
}
async function targetPoint(route,selector,frameKind){
 if(route==='shared')return viewer.evaluate(({selector,frameKind})=>{const rf=document.querySelector('#replay iframe'),d=rf.contentDocument,f=[...d.querySelectorAll('iframe')].find(f=>frameKind==='anchor'?f.title==='reCAPTCHA':f.title.includes('challenge'));if(!f)throw Error('Missing replay frame');const e=f.contentDocument.querySelector(selector);if(!e)throw Error('Missing replay target');const a=rf.getBoundingClientRect(),b=f.getBoundingClientRect(),c=e.getBoundingClientRect();return{x:a.x+rf.clientLeft+b.x+f.clientLeft+c.x+c.width/2,y:a.y+rf.clientTop+b.y+f.clientTop+c.y+c.height/2};},{selector,frameKind});
 const f=source.frames().find(f=>f.url().includes(frameKind==='anchor'?'/anchor':'/bframe'));const el=await f.$(selector),box=await el?.boundingBox();await el?.dispose();if(!box)throw Error('Missing source target');return{x:box.x+box.width/2,y:box.y+box.height/2};
}
async function pointer(route,p){
 if(route==='shared'||route==='cdp'){await (route==='shared'?viewer:source).mouse.click(p.x,p.y,{delay:trial.pressMs});return;}
 if(route!=='os')throw Error('Unknown route');
 const env={...process.env,DISPLAY:process.env.TRIAL_DISPLAY||':108',XAUTHORITY:process.env.TRIAL_XAUTHORITY||os.homedir()+'/.local/state/dev-tools/browser/sessions/captcha-ab/Xauthority'};
 if(!osOffset){const d=await source.evaluate(()=>({x:screenX,y:screenY,ow:outerWidth,oh:outerHeight,iw:innerWidth,ih:innerHeight}));osOffset={x:d.x+(d.ow-d.iw)/2,y:d.y+d.oh-d.ih-(d.ow-d.iw)/2};}
 await exec('xdotool',['mousemove','--sync',String(Math.round(p.x+osOffset.x)),String(Math.round(p.y+osOffset.y))],{env});
 await exec('xdotool',['mousedown','1'],{env});await wait(trial.pressMs);await exec('xdotool',['mouseup','1'],{env});
}
async function report(action){await instruments();if(await source.evaluate(()=>window.__sharedGeneration)!==expected.generation||await viewer.$eval('#tabs',e=>e.value)!==expected.id)throw Error('Tab/generation changed');
 const f=source.frames().find(f=>f.url().includes('/bframe'));const left=f?await f.evaluate('('+audit.toString()+')(document)'):null;const right=await viewer.evaluate('(()=>{const audit='+audit.toString()+';const f=[...document.querySelector("#replay iframe").contentDocument.querySelectorAll("iframe")].find(f=>f.title.includes("challenge"));return f?.contentDocument?audit(f.contentDocument):null})()');
 const checked=await source.frames().find(f=>f.url().includes('/anchor'))?.$eval('#recaptcha-anchor',e=>e.getAttribute('aria-checked')).catch(()=>null);
 const events=[];for(const f of source.frames())events.push({frame:f.url().includes('/anchor')?'anchor':f.url().includes('/bframe')?'challenge':'top',events:await f.evaluate(()=>window.__trialEvents?.splice(0)||[]).catch(()=>[])});
 const entry={seq:++seq,time:new Date().toISOString(),trial,action,command:lastCommand,checked,promptMatch:left?.text===right?.text,imageMatch:JSON.stringify(left?.images)===JSON.stringify(right?.images),geometryMatch:JSON.stringify(left?.tiles)===JSON.stringify(right?.tiles),source:left,viewer:right,events,error:await viewer.$eval('#error',e=>e.textContent)};
 await fs.appendFile(path.join(out,'observations.jsonl'),JSON.stringify(entry)+'\n');
 const p=trial?.route==='shared'?viewer:source;await p.screenshot({path:path.join(out,'latest.png'),clip:{x:0,y:0,width:520,height:700}});await fs.copyFile(path.join(out,'latest.png'),path.join(out,String(seq).padStart(3,'0')+'.png'));
 console.log(JSON.stringify({seq,trial,action,checked,promptMatch:entry.promptMatch,imageMatch:entry.imageMatch,geometryMatch:entry.geometryMatch,sourceText:left?.text,error:entry.error,screenshot:path.join(out,'latest.png')}));
}
console.log(JSON.stringify({ready:true,out,tab:expected.id,generation:expected.generation}));await instruments();await report('initial');
try{for await(const line of createInterface({input:process.stdin})){try{const c=JSON.parse(line);lastCommand=c;if(c.action==='stop')break;
 if(c.action==='start'){if(!['shared','cdp','os','external'].includes(c.route))throw Error('Unknown input route');const pressMs=c.pressMs??120;if(!Number.isFinite(pressMs)||pressMs<0||pressMs>1000)throw Error('Invalid press duration');trial={id:c.id,route:c.route,pressMs,started:Date.now(),rounds:0,tileSelections:0};await source.bringToFront();await source.reload({waitUntil:'networkidle2'});await wait(500);st=await status();expected=st.tabs.find(t=>t.id===expected.id);await instruments();if(trial.route!=='external')await pointer(trial.route,await targetPoint(trial.route,'#recaptcha-anchor','anchor'));}
 if(c.action==='tiles'){if(![3,4].includes(c.columns)||!Array.isArray(c.cells)||c.cells.some(n=>!Number.isInteger(n)||n<1||n>c.columns*c.columns))throw Error('Use observed cells on a 3x3 or 4x4 grid');for(const cell of c.cells){await pointer(trial.route,await targetPoint(trial.route,`tr:nth-child(${Math.ceil(cell/c.columns)}) td:nth-child(${(cell-1)%c.columns+1})`,'challenge'));trial.tileSelections++;}}
 if(c.action==='verify'){await pointer(trial.route,await targetPoint(trial.route,'#recaptcha-verify-button','challenge'));trial.rounds++;}
 if(c.action==='point')await pointer(trial.route,{x:c.x,y:c.y});
 if(c.action==='assets')await assets();
 if(c.action==='external-result'){trial.rounds=c.rounds;trial.tileSelections=c.tileSelections;}
 await wait(Math.max(0,Math.min(10000,c.waitMs??1200)));await report(c.action);
 }catch(e){console.log(JSON.stringify({error:e.stack}));}}
}finally{process.stdin.pause();sourceBrowser.disconnect();await viewerBrowser.close();for(const s of proxySockets)s.destroy();await new Promise(r=>proxy.close(r));}
