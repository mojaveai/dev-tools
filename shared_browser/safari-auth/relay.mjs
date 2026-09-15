import {randomBytes} from 'node:crypto';

// This pilot accepts requests only from its trusted test driver, never a website API.
export class AuthRelay {
  constructor({origin, now=Date.now, ttl=120000,maxPending=1}) {
    Object.assign(this,{origin,now,ttl,maxPending});this.requests=new Map();
  }
  start(kind, publicKey) {
    if (!['create','get'].includes(kind)) throw Error('Unsupported credential operation');
    const rp=kind==='create'?publicKey.rp?.id:publicKey.rpId;
    if (rp!==new URL(this.origin).hostname || !publicKey.challenge) throw Error('Invalid relying party');
    if(this.maxPending===1){for (const r of this.requests.values()) this.cancel(r.id);this.requests.clear();}
    else{
      for(const [id,r]of this.requests)if(r.status!=='pending'||this.now()>=r.expiresAt){this.cancel(id);this.requests.delete(id);}
      if(this.requests.size>=this.maxPending)throw Error('Too many pending approvals');
    }
    const id=randomBytes(24).toString('hex');let resolve,reject;
    const promise=new Promise((a,b)=>{resolve=a;reject=b;});
    const r={id,kind,origin:this.origin,publicKey:structuredClone(publicKey),expiresAt:this.now()+this.ttl,status:'pending',resolve,reject};
    this.requests.set(id,r);
    r.timer=setTimeout(()=>this.cancel(id),this.ttl);r.timer.unref();
    return {id,promise};
  }
  pending(id) {
    const r=this.requests.get(id);
    if(!r || r.status!=='pending' || this.now()>=r.expiresAt) throw Error('Request expired, canceled, or already used');
    return r;
  }
  list() {
    return [...this.requests.values()].filter(r=>r.status==='pending' && this.now()<r.expiresAt)
      .map(({id,kind,origin,publicKey,expiresAt})=>({id,kind,origin,publicKey,expiresAt}));
  }
  complete(id,response) {
    const r=this.pending(id);
    if(response?.type!=='public-key')throw Error('Invalid credential type');
    const client=JSON.parse(Buffer.from(response.response.clientDataJSON,'base64url').toString());
    if(client.origin!==r.origin || client.challenge!==r.publicKey.challenge ||
       client.type!==`webauthn.${r.kind}` || client.crossOrigin===true || client.topOrigin!==undefined)
      throw Error('Response origin, challenge, or operation does not match');
    if(r.kind==='get' && r.publicKey.allowCredentials?.length && !r.publicKey.allowCredentials.some(c=>c.id===response.id))
      throw Error('Unexpected credential');
    r.status='delivered';clearTimeout(r.timer);r.resolve(response);
    // The original site's verifier, not this transport, decides authentication success.
    return {delivered:true};
  }
  cancel(id) {
    const r=this.requests.get(id);
    if(r?.status==='pending'){r.status='canceled';clearTimeout(r.timer);r.reject(Error('Approval canceled or expired'));}
    return {canceled:true};
  }
}
