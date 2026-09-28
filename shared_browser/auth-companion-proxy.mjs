// Called only after the viewer's Tailscale owner check. Never expose host APIs.
// Completion and cancellation carry fleet-key proofs that the relay verifies.
export async function authCompanionProxy(req,res,{fetcher=fetch}={}) {
  const endpoint=new URL(req.url,'http://local').pathname.slice('/auth-companion'.length);
  if(!((req.method==='GET'&&endpoint==='/pending')||
    (req.method==='POST'&&['/complete','/cancel'].includes(endpoint)))){
    res.writeHead(404);res.end();return;
  }
  try{
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>100000){res.writeHead(413);res.end();return;}chunks.push(chunk);}
    const response=await fetcher('http://localhost:8811'+endpoint,{
      method:req.method,headers:{'Content-Type':'application/json'},
      ...(req.method==='POST'?{body:Buffer.concat(chunks)}:{}),signal:AbortSignal.timeout(10000),redirect:'error'});
    res.writeHead(response.status,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(await response.text());
  }catch{res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'Passkey approval is unavailable on this host.'}));}
}
