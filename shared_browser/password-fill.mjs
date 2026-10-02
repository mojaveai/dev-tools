import {randomBytes, timingSafeEqual} from 'node:crypto';
import {mac} from './auth-host.mjs';

// Runs in the real Chrome document. Keep credentials out of request metadata.
export function passwordFields() {
  if (location.protocol !== 'https:') throw Error('Saved-password filling requires HTTPS');
  const visible = e => !e.disabled && !e.readOnly && e.getClientRects().length &&
    getComputedStyle(e).visibility !== 'hidden';
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const passwords = inputs.filter(e => e.type === 'password' && e.autocomplete !== 'new-password');
  if (passwords.length > 1) throw Error('Select a page with one sign-in form');
  if (inputs.some(e => e.type === 'password' && e.autocomplete === 'new-password'))
    throw Error('Use your password manager directly when creating or changing a password');
  const password = passwords[0];
  const candidates = inputs.filter(e => ['text', 'email', 'tel'].includes(e.type) &&
    (!password || e.form === password.form));
  const preferred = candidates.filter(e => e.autocomplete === 'username' || e.type === 'email' || /user|email|login/i.test(e.name || e.id));
  const username = preferred.length === 1 ? preferred[0] : candidates.length === 1 ? candidates[0] : null;
  if (!password && !username) throw Error('No unambiguous sign-in fields found on this page');
  const fields = [username && {role:'username', e:username}, password && {role:'password', e:password}].filter(Boolean);
  return {url:location.href, origin:location.origin, fields:fields.map(({role,e}) => {
    const action = e.form?.action || location.href;
    if (new URL(action).origin !== location.origin) throw Error('Cross-origin sign-in forms are not supported');
    const node = window.__sharedMirror?.getId(e);
    if (!Number.isInteger(node) || node <= 0) throw Error('Wait for the page to finish loading');
    return {role,node,type:e.type,name:e.name,autocomplete:e.autocomplete,action};
  })};
}

export async function applyPasswordFields({url,origin,fields,values}) {
  if (location.href !== url || location.origin !== origin) throw Error('Sign-in page changed; start again');
  // Validate every destination before writing any credential.
  const validate = (field,e) => {
    if (!e?.isConnected || e.tagName !== 'INPUT' || e.disabled || e.readOnly || !e.getClientRects().length ||
        getComputedStyle(e).visibility === 'hidden' || e.type !== field.type || e.name !== field.name ||
        e.autocomplete !== field.autocomplete || (e.form?.action || location.href) !== field.action)
      throw Error('Sign-in fields changed; start again');
  };
  const elements = fields.map(field => {
    const e = window.__sharedMirror?.getNode(field.node);
    validate(field,e);
    return {field,e};
  });
  // Let controlled forms store each value before setting the next one. Setting
  // both first lets the username's render overwrite the uncommitted password.
  for (const {field,e} of elements) {
    if (location.href !== url || location.origin !== origin || !e.isConnected)
      throw Error('Sign-in fields changed; start again');
    validate(field,e);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,values[field.role]);
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  // Controlled forms can reject or reset programmatic input on their next
  // render. Confirm what the real page kept before reporting success.
  await new Promise(resolve=>setTimeout(resolve,0));
  if (location.href !== url || location.origin !== origin || elements.some(({field,e})=>
      !e.isConnected || e.value !== values[field.role]))
    throw Error('The site did not keep the filled fields. Check the sign-in page before trying again.');
  return {filled:true};
}

export class PasswordFill {
  constructor({key,viewer,getTab,active,serial,now=Date.now,ttl=120000}) {
    Object.assign(this,{key,viewer,getTab,active,serial,now,ttl}); this.requests = new Map();
  }
  valid(r) {
    const tab = this.getTab(r.tab);
    return r.expiresAt > this.now() && tab && this.active() === r.tab &&
      tab.generation === r.generation && tab.page.url() === r.url;
  }
  async start({tab:id,generation}) {
    if (!this.key) throw Error('Dev Tools Auth is not paired on this host');
    const tab = this.getTab(id);
    if (!tab || this.active() !== id || !generation || tab.generation !== generation) throw Error('Page changed; start again');
    const form = await tab.page.evaluate(passwordFields);
    const r = {...form,id:randomBytes(24).toString('hex'),tab:id,generation,kind:'password',expiresAt:this.now()+this.ttl};
    if (!this.valid(r)) throw Error('Page changed; start again');
    // One human credential operation at a time. No secrets persist here.
    this.requests.clear(); this.requests.set(r.id,r);
    return {code:r.id.slice(0,8).toUpperCase(),origin:r.origin};
  }
  pending() {
    const result = [];
    for (const [id,r] of this.requests) {
      if (!this.valid(r)) {this.requests.delete(id); continue;}
      const payload = JSON.stringify({viewer:this.viewer,id:r.id,kind:r.kind,origin:r.origin,
        fields:r.fields.map(({role})=>({role})),expiresAt:r.expiresAt});
      result.push({payload,sig:mac(this.key,'request',payload)});
    }
    return result;
  }
  async finish(action,{id,proof,values}) {
    const r = this.requests.get(id);
    if (!r || !this.valid(r)) {this.requests.delete(id); throw Error('Sign-in page changed or request expired; start again');}
    const extra = action === 'complete' ? JSON.stringify(values) : '';
    const want = Buffer.from(mac(this.key,'password-'+action,id,extra),'hex');
    const got = /^[a-f0-9]{64}$/.test(proof || '') ? Buffer.from(proof,'hex') : Buffer.alloc(0);
    if (got.length !== want.length || !timingSafeEqual(got,want)) throw Error('Unpaired approval client');
    if (action === 'cancel') {this.requests.delete(id); return {canceled:true};}
    if (!values || Object.keys(values).length !== r.fields.length || r.fields.some(({role}) =>
        typeof values[role] !== 'string' || !values[role] || values[role].length > 4096)) throw Error('Fill the sign-in fields first');
    this.requests.delete(id); // Never retry an uncertain credential delivery.
    return this.serial(async()=> {
      if (!this.valid(r)) throw Error('Sign-in page changed; start again');
      return this.getTab(r.tab).page.evaluate(applyPasswordFields,{...r,values});
    });
  }
}
