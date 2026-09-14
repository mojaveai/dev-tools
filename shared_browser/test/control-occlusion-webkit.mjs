import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const {webkit}=await import(process.env.SHARED_BROWSER_WEBKIT_MODULE);
const code=await fs.readFile(new URL('../control-occlusion.js',import.meta.url),'utf8');
const browser=await webkit.launch({headless:true});
try {
  const page=await browser.newPage();
  await page.setContent('<iframe style="width:800px;height:500px;pointer-events:none"></iframe>');
  const results=await page.evaluate(code=>{
    const doc=document.querySelector('iframe').contentDocument;
    doc.body.innerHTML='<style>input,textarea{display:block;width:400px;height:80px;border:1px solid;border-radius:6px;margin:20px}</style><input><textarea></textarea><div id="cover" style="display:none;position:fixed;background:white;z-index:2"></div>';
    const factory=new Function(code.replace('export function','function')+';return controlOcclusion;')();
    const visible=e=>{
      const r=e.getBoundingClientRect(),check=factory(doc);
      try{return check.visible(e,{bounds:{left:r.left,top:r.top,right:r.right,bottom:r.bottom}});}finally{check.dispose();}
    };
    const input=doc.querySelector('input'),area=doc.querySelector('textarea');
    const rounded=visible(input),before=visible(area);area.style.opacity='0';const transparent=visible(area);
    const r=area.getBoundingClientRect(),cover=doc.querySelector('#cover');
    Object.assign(cover.style,{display:'block',left:r.left+'px',top:r.top+'px',width:'30px',height:'30px'});
    const covered=visible(area);cover.remove();
    return {rounded,before,transparent,covered,restored:visible(area)};
  },code);
  assert.deepEqual(results,{rounded:true,before:true,transparent:true,covered:false,restored:true});
  console.log('PASS: WebKit rounded fields and transparent textarea corners remain editable; actual partial occlusion still blocks overlays');
}finally{await browser.close()}
