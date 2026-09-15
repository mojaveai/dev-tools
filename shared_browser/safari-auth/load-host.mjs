// Optional procbox service: install this owner's auth extension after each Chrome start.
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const endpointFile=process.env.AUTH_BROWSER_STATE;
if(!endpointFile)throw Error('AUTH_BROWSER_STATE is required');
let lastEndpoint='';
while(true){
  let browser;
  try{
    const {browserWSEndpoint}=JSON.parse(await fs.readFile(endpointFile,'utf8'));
    if(browserWSEndpoint!==lastEndpoint){
      browser=await puppeteer.connect({browserWSEndpoint,defaultViewport:null});
      const id=await browser.installExtension(path.join(root,'host-extension'));
      lastEndpoint=browserWSEndpoint;console.log('Auth companion loaded:',id);
    }
  }catch(error){console.error('Auth companion waiting:',error.message);}
  finally{browser?.disconnect();}
  await new Promise(resolve=>setTimeout(resolve,3000));
}
