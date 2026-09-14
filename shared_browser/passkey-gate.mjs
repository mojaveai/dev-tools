import { randomUUID } from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

// The only transition into approved is a verified assertion from the enrolled key.
export class PasskeyGate {
  constructor({origin, credential = null, persist, now = Date.now, ttl = 120000}) {
    Object.assign(this, {origin, credential, persist, now, ttl});
    this.rpID = new URL(origin).hostname;
    this.enrollments = new Map(); this.requests = new Map();
  }
  prune() {
    for (const [id,r] of this.requests) if (this.now() > r.expiresAt + this.ttl) this.requests.delete(id);
    for (const [id,r] of this.enrollments) if (this.now() > r.expiresAt) this.enrollments.delete(id);
  }
  async registrationOptions(device) {
    if (this.credential) throw Error('A passkey is already registered for this demo');
    this.prune();
    if (this.enrollments.size >= 32) throw Error('Too many registration attempts; try later');
    const options = await generateRegistrationOptions({
      rpName:'Shared browser approval demo', rpID:this.rpID,
      userID:new TextEncoder().encode('shared-browser-demo-owner'), userName:'Browser demo owner',
      attestationType:'none', timeout:this.ttl,
      authenticatorSelection:{residentKey:'required', userVerification:'required', authenticatorAttachment:'platform'},
      supportedAlgorithmIDs:[-7, -257],
    });
    this.enrollments.set(device,{challenge:options.challenge,expiresAt:this.now()+this.ttl});
    return options;
  }
  async register(device, response) {
    const enrollment=this.enrollments.get(device); this.enrollments.delete(device);
    if (this.credential || !enrollment || this.now() >= enrollment.expiresAt) throw Error('Registration expired or already completed');
    const result=await verifyRegistrationResponse({response,expectedChallenge:enrollment.challenge,
      expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserVerification:true});
    if (!result.verified || !result.registrationInfo) throw Error('Passkey registration was not verified');
    const {credential}=result.registrationInfo;
    await this.persist(credential); this.credential=credential; this.enrollments.clear();
    return {registered:true};
  }
  start(session) {
    if (!this.credential) throw Error('Register your phone passkey first');
    this.prune();
    if(this.requests.size>=64)throw Error('Too many demo requests; try later');
    for (const r of this.requests.values()) if(r.session===session&&r.status==='pending')r.status='canceled';
    const request={id:randomUUID(),session,status:'pending',expiresAt:this.now()+this.ttl,
      action:'Sign in to the demo workspace'};
    this.requests.set(request.id,request);
    return this.public(request);
  }
  get(id) {
    const r=this.requests.get(id); if(!r)throw Error('Request not found');
    if(r.status==='pending'&&this.now()>=r.expiresAt){r.status='expired';delete r.challenge;}
    return r;
  }
  public(r) { return {id:r.id,code:r.id.slice(0,8).toUpperCase(),status:r.status,expiresAt:r.expiresAt,action:r.action}; }
  list() { this.prune();return [...this.requests.values()].map(r=>this.public(this.get(r.id))).reverse(); }
  async authenticationOptions(id,device) {
    const r=this.get(id);if(r.status!=='pending')throw Error('Request is no longer pending');
    const options=await generateAuthenticationOptions({rpID:this.rpID, userVerification:'required',
      timeout:Math.max(1,r.expiresAt-this.now()),allowCredentials:[{id:this.credential.id,transports:this.credential.transports}]});
    r.challenge=options.challenge;r.device=device;
    return options;
  }
  async approve(id,device,response) {
    const r=this.get(id);
    if(r.status!=='pending'||!r.challenge||r.device!==device)throw Error('Approval expired, used, or belongs to another device');
    const challenge=r.challenge;delete r.challenge;
    if(response?.id!==this.credential.id)throw Error('Use the registered demo passkey');
    const result=await verifyAuthenticationResponse({response,expectedChallenge:challenge,
      expectedOrigin:this.origin,expectedRPID:this.rpID,credential:this.credential,requireUserVerification:true});
    if(!result.verified)throw Error('Passkey signature was not verified');
    if(this.get(id).status!=='pending')throw Error('Request expired while authenticating');
    const credential={...this.credential,counter:result.authenticationInfo.newCounter};
    await this.persist(credential);this.credential=credential;
    if(this.get(id).status!=='pending')throw Error('Request expired while saving authentication');
    r.status='approved';r.approvedAt=this.now();
    return this.public(r);
  }
  cancel(id) {const r=this.get(id);if(r.status==='pending'){r.status='canceled';delete r.challenge;}return this.public(r);}
  consume(id,session) {
    const r=this.get(id);if(r.session!==session)throw Error('Request belongs to another browser session');
    if(r.status!=='approved')return false;
    if(this.now()>=r.expiresAt){r.status='expired';return false;}
    r.status='consumed';return true;
  }
}
