// Bounded manual-solver comparison of normal browser binaries/profiles. Owns
// isolated hosts only; never attaches to or restarts the installed shared session.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import puppeteer from 'puppeteer-core';
const exec=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const out=await fs.mkdtemp('/tmp/captcha-environments-');await fs.chmod(out,0o700);
const binaries={cft:process.env.TRIAL_CFT_CHROME,chrome:process.env.TRIAL_STABLE_CHROME||'/usr/bin/google-chrome'};
const hosts=new Map();let trial,current,last,seq=0;
async function host(name){
  if(hosts.has(name))return hosts.get(name);
  if(!binaries[name])throw Error('Set binary path for '+name);
  const state=path.join(out,name);await fs.mkdir(state,{mode:0o700});
  const child=spawn(process.execPath,[new URL('../browser-host.mjs',import.meta.url).pathname],{
    env:{...process.env,SHARED_BROWSER_STATE:state,SHARED_BROWSER_CHROME:binaries[name]},stdio:['ignore','pipe','pipe'],
  });
  child.stdout.resume();child.stderr.on('data',b=>process.stderr.write(b));
  const h={child,state};hosts.set(name,h);
  for(let i=0;i<150;i++){
    try{h.info=JSON.parse(await fs.readFile(path.join(state,'browser-host.json'),'utf8'));break;}catch{}
    if(child.exitCode!==null)throw Error('Browser host exited');await sleep(100);
  }
  if(!h.info)throw Error('Browser host not ready');
  h.browser=await puppeteer.connect({browserWSEndpoint:h.info.browserWSEndpoint,defaultViewport:null});
  h.page=(await h.browser.pages())[0];return h;
}
async function click(selector,kind){
  const frame=current.page.frames().find(f=>f.url().includes(kind==='anchor'?'/anchor':'/bframe'));
  const element=await frame.$(selector),box=await element?.boundingBox();await element?.dispose();
  if(!box)throw Error('Missing observed target');
  const x=box.x+box.width/2,y=box.y+box.height/2;
  if(trial.route==='cdp')return current.page.mouse.click(x,y,{delay:trial.pressMs});
  const view=await current.page.evaluate(()=>({x:screenX,y:screenY,ow:outerWidth,oh:outerHeight,iw:innerWidth,ih:innerHeight}));
  const border=(view.ow-view.iw)/2;
  const env={...process.env,DISPLAY:':'+current.info.display,XAUTHORITY:path.join(current.state,'browser-host.Xauthority')};
  await exec('xdotool',['mousemove','--sync',String(Math.round(x+view.x+border)),String(Math.round(y+view.y+view.oh-view.ih-border))],{env});
  await exec('xdotool',['mousedown','1'],{env});await sleep(trial.pressMs);await exec('xdotool',['mouseup','1'],{env});
}
async function report(command){
  const frames=[];
  for(const frame of current.page.frames()){
    const kind=frame.url().includes('/anchor')?'anchor':frame.url().includes('/bframe')?'challenge':'top';
    if(!['anchor','challenge'].includes(kind))continue;
    frames.push({kind,...await frame.evaluate(()=>({text:document.body?.innerText,
      checked:document.querySelector('#recaptcha-anchor')?.getAttribute('aria-checked'),
      recording:!!window.__sharedStop,binding:typeof window.__sharedEmit==='function',
    }))});
  }
  const anchor=frames.find(f=>f.kind==='anchor');
  const terminal=anchor?.checked==='true'||anchor?.text.includes('expired')||trial.rounds>=3;
  last={seq:++seq,time:new Date().toISOString(),trial:{...trial},command,frames,terminal,
    properties:await current.page.evaluate(()=>({ua:navigator.userAgent,webdriver:navigator.webdriver,
      screen:[screen.width,screen.height],viewport:[innerWidth,innerHeight],outer:[outerWidth,outerHeight],
      recording:!!window.__sharedStop,visibility:document.visibilityState})),
  };
  await fs.appendFile(path.join(out,'observations.jsonl'),JSON.stringify(last)+'\n');
  const screenshot=path.join(out,'latest.png');await current.page.screenshot({path:screenshot,clip:{x:0,y:0,width:520,height:700}});
  await fs.copyFile(screenshot,path.join(out,String(seq).padStart(3,'0')+'.png'));
  console.log(JSON.stringify({...last,screenshot}));
}
console.log(JSON.stringify({ready:true,out}));
try{
  for await(const line of createInterface({input:process.stdin}))try{
    const c=JSON.parse(line);if(c.action==='stop')break;
    if(c.action==='preflight'){
      for(const binary of ['cft','chrome'])await host(binary);
      console.log(JSON.stringify({preflight:true,binaries:Object.keys(binaries),out}));continue;
    }
    if(c.action==='start'){
      if(last&&!last.terminal&&!c.abortReason)throw Error('Current trial is not terminal; retain an explicit abortReason to interrupt');
      if(!['chrome','cft'].includes(c.binary)||!['os','cdp'].includes(c.route))throw Error('Specify binary and input route');
      if(c.abortReason)await fs.appendFile(path.join(out,'interruptions.jsonl'),JSON.stringify({trial,reason:c.abortReason})+'\n');
      current=await host(c.binary);await current.page.bringToFront();
      trial={id:c.id,binary:c.binary,route:c.route,pressMs:c.pressMs??120,started:Date.now(),rounds:0,tiles:0};
      if(!Number.isFinite(trial.pressMs)||trial.pressMs<0||trial.pressMs>1000)throw Error('Invalid press duration');
      await current.page.goto('https://www.google.com/recaptcha/api2/demo',{waitUntil:'domcontentloaded'});
      for(let i=0;i<300;i++){
        const anchor=current.page.frames().find(f=>f.url().includes('/anchor'));
        const checkbox=anchor&&await anchor.$('#recaptcha-anchor');
        if(checkbox){await checkbox.dispose();break;}
        await sleep(100);
      }
      await click('#recaptcha-anchor','anchor');
    }
    if(c.action==='tiles'){
      if(![3,4].includes(c.columns)||!Array.isArray(c.cells)||c.cells.some(n=>!Number.isInteger(n)||n<1||n>c.columns*c.columns))throw Error('Invalid grid');
      for(const cell of c.cells){await click(`tr:nth-child(${Math.ceil(cell/c.columns)}) td:nth-child(${(cell-1)%c.columns+1})`,'challenge');trial.tiles++;}
    }
    if(c.action==='verify'){await click('#recaptcha-verify-button','challenge');trial.rounds++;}
    await sleep(Math.max(0,Math.min(10000,c.waitMs??1200)));await report(c);
  }catch(error){
    const failure={time:new Date().toISOString(),trial,error:error.stack};
    await fs.appendFile(path.join(out,'errors.jsonl'),JSON.stringify(failure)+'\n');
    console.log(JSON.stringify(failure));
  }
}finally{
  process.stdin.pause();
  for(const h of hosts.values()){
    h.browser?.disconnect();if(h.child.exitCode===null)h.child.kill('SIGTERM');
    for(let i=0;i<100&&h.child.exitCode===null&&!h.child.signalCode;i++)await sleep(100);
    if(h.child.exitCode===null&&!h.child.signalCode)h.child.kill('SIGKILL');
  }
}
