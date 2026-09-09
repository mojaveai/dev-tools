// Synthetic form test: no vault access and no OpenAI login.
const assert=require('assert/strict'),http=require('http'),fs=require('fs');
const {step}=require('../auth/login-step.cjs');
const cfg=JSON.parse(fs.readFileSync(process.env.HOME+'/.config/dev-tools/browser.json'));
const {chromium}=require(cfg.runtime+'/node_modules/playwright');
(async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<form><input type="email"><button>Continue</button></form><script>
 window.values=[];document.querySelector('form').onsubmit=e=>{e.preventDefault();values.push(document.querySelector('input').value);if(values.length===1)document.querySelector('input').outerHTML='<input type="password">';else if(values.length===2)document.querySelector('input').outerHTML='<input autocomplete="one-time-code">';else document.body.textContent='Signed in';};
 </script>`);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,chromiumSandbox:true});
 try{
  const page=await browser.newPage(),origin='http://127.0.0.1:'+server.address().port;
  await page.goto(origin);
  await assert.rejects(()=>step(page,'email','fake@example.test'),/Unapproved/);
  const allowed=new Set([origin]);
  await assert.rejects(()=>step(page,'email','pass://unresolved',allowed),/unavailable/);
  await step(page,'email','fake@example.test',allowed);
  await step(page,'password','synthetic-password',allowed);
  await step(page,'totp','123456',allowed);
  assert.equal(await page.locator('body').innerText(),'Signed in');
  assert.deepEqual(await page.evaluate(()=>window.values),['fake@example.test','synthetic-password','123456']);
  console.log('Synthetic email/password/TOTP flow and origin restrictions passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e.message);process.exit(1)});
