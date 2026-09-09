// Supported Codex OAuth flow plus bounded, visible login-form assistance.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {spawn,execFileSync}=require('child_process');
const readline=require('readline');
const {selectors,origins}=require('./login-step.cjs');
const repo=path.resolve(__dirname,'..');
const cfg=JSON.parse(fs.readFileSync(process.env.DEVTOOLS_BROWSER_CONFIG || process.env.HOME+'/.config/dev-tools/browser.json'));
const {chromium}=require(cfg.runtime+'/node_modules/playwright');
const session='codex-login-'+crypto.randomBytes(6).toString('hex');
const command=(...args)=>JSON.parse(execFileSync(path.join(repo,'bin/dev-tools'),['browser',...args,'--json'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
 let browser,server,handoff,loginId,completed,serverFailed=false,sequence=0;
 const pending=new Map();
 try{
  execFileSync('sh',[path.join(__dirname,'pass-stage.sh'),'verify'],{env:{...process.env,REPO_DIR:repo},stdio:'ignore',timeout:30000});
  const meta=command('start',session);
  if(meta.viewer_url) console.log('Codex sign-in viewer: '+meta.viewer_url);
  server=spawn('codex',['app-server','--listen','stdio://'],{stdio:['pipe','pipe','ignore']});
  server.on('error',()=>{serverFailed=true;});
  server.stdin.on('error',()=>{serverFailed=true;});
  server.on('exit',()=>{serverFailed=true;});
  readline.createInterface({input:server.stdout}).on('line',line=>{
   try{const r=JSON.parse(line);
    if(r.method==='account/login/completed' && r.params.loginId===loginId) completed=r.params;
    const waiter=pending.get(r.id);if(waiter){pending.delete(r.id);clearTimeout(waiter.timer);r.error?waiter.reject(new Error('Codex login request failed')):waiter.resolve(r.result);}
   }catch{}
  });
  const rpc=(method,params)=>new Promise((resolve,reject)=>{
   const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Codex login request timed out'));},20000);
   pending.set(id,{resolve,reject,timer});server.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  await rpc('initialize',{clientInfo:{name:'dev_tools_login',version:'1.0.0'}});
  server.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const login=await rpc('account/login/start',{type:'chatgpt'});loginId=login.loginId;
  if(!origins.has(new URL(login.authUrl).origin))throw new Error('Unexpected login origin');
  browser=await chromium.connectOverCDP('http://127.0.0.1:'+meta.cdp_port);
  const page=browser.contexts()[0].pages()[0];await page.goto(login.authUrl,{timeout:30000});
  const used=new Set(),deadline=Date.now()+600000,automaticDeadline=Date.now()+60000;
  let consentUsed=false;
  while(Date.now()<deadline){
   if(completed){if(!completed.success)throw new Error('Codex login did not complete');return;}
   if(serverFailed)throw new Error('Codex login server stopped');
   if(!handoff && !used.has('failed') && Date.now()<automaticDeadline && origins.has(new URL(page.url()).origin)){
    let stage;
    for(const kind of ['totp','password','email']){
     if(!used.has(kind)&&await page.locator(selectors[kind]).first().isVisible().catch(()=>false)){stage=kind;break;}
    }
    if(stage){
     used.add(stage);
     // Resolve TOTP just before entry, leaving enough of its 30-second window.
     if(stage==='totp' && Date.now()%30000>20000)await delay(30000-Date.now()%30000+500);
     const child=spawn('sh',[path.join(__dirname,'pass-stage.sh'),stage],{env:{...process.env,REPO_DIR:repo,DEVTOOLS_LOGIN_CDP:'http://127.0.0.1:'+meta.cdp_port},stdio:['ignore','ignore','ignore'],detached:true});
     const code=await new Promise(resolve=>{const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM')}catch{}},30000);child.once('error',()=>{clearTimeout(timer);resolve(1)});child.once('exit',code=>{clearTimeout(timer);resolve(code??1)});});
     if(code!==0)used.add('failed');
     await delay(1000);continue;
    }
    const passwordChoice=page.getByRole('button',{name:/^(Use password|Log in with password)$/i});
    if(!used.has('password-choice') && await passwordChoice.first().isVisible().catch(()=>false)){
     used.add('password-choice');await passwordChoice.first().click();await delay(1000);continue;
    }
    if(!consentUsed && /consent|authorize|codex/.test(new URL(page.url()).pathname)){
     const button=page.getByRole('button',{name:/^(Continue|Allow|Authorize|Confirm)$/i}).first();
     if(await button.isVisible().catch(()=>false)){consentUsed=true;await button.click();await delay(1000);continue;}
    }
   }
   if(!handoff && (Date.now()>=automaticDeadline||used.has('failed'))){
    if(!meta.viewer_url)throw new Error('Automatic login needs human input, but no private viewer is available');
    handoff=command('request-input',session,'--message','Complete the Codex sign-in, then click Done.');
    console.log('Additional sign-in approval is needed in the viewer. Waiting up to ten minutes.');
   }
   await delay(500);
  }
  throw new Error('Codex sign-in timed out');
 }finally{
  for(const waiter of pending.values())clearTimeout(waiter.timer);
  if(handoff){try{command('cancel-input',session,'--request-id',handoff.id);}catch{}}
  if(browser)await browser.close().catch(()=>{});
  if(server){server.stdin.end();server.kill('SIGTERM');}
  try{command('stop',session);command('delete-profile',session,'--yes');}catch{}
 }
}
main().catch(()=>{console.error('Codex automatic sign-in did not complete; existing task browsers were preserved.');process.exitCode=1;});
