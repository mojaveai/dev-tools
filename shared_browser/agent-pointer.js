import './agent-pointer.css';
// A visual indicator of agent intent and confirmed completion. It never
// injects website events or blocks the human's pointer/keyboard.
export class AgentPointer {
  constructor(root) {
    this.root=root;this.position={x:28,y:36};
    this.layer=document.createElement('div');this.layer.className='agent-feedback';
    this.layer.setAttribute('aria-hidden','true');
    this.layer.innerHTML='<div class="agent-target"></div><div class="agent-cursor"><svg viewBox="0 0 24 24" width="27" height="27"><path d="M1.50001 4.07491C0.897091 2.46714 2.46715 0.897094 4.07491 1.50001L21.2155 7.92774C23.1217 8.64256 22.8657 11.4162 20.8609 11.77L13.1336 13.1336L11.77 20.8609C11.4162 22.8657 8.64255 23.1217 7.92774 21.2155L1.50001 4.07491Z" fill="#202124" stroke="white" stroke-width=".8"/></svg><span class="agent-label">Agent</span></div><div class="agent-ripple"></div>';
    root.append(this.layer);this.cursor=this.layer.querySelector('.agent-cursor');
    this.target=this.layer.querySelector('.agent-target');this.ripple=this.layer.querySelector('.agent-ripple');
    this.label=this.layer.querySelector('.agent-label');
    this.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  reset() {
    clearTimeout(this.timer);cancelAnimationFrame(this.frame);
    this.rippleMotion?.cancel();this.pressMotion?.cancel();
    this.id=null;this.event=null;this.pending=null;this.moving=false;
    this.layer.classList.remove('visible');
  }
  locate(event,resolve) {
    const r=resolve(event.node);
    if(r && r.width>0 && r.height>0) {
      Object.assign(this.target.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'});
      this.target.hidden=false;
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    }
    this.target.hidden=true;
    // Removed/replaced targets must not hide the cursor or send it back to
    // stale server coordinates after scrolling. Retain the last known point.
    return this.destination || (Number.isFinite(event.x) && Number.isFinite(event.y)
      ? {x:event.x,y:event.y} : this.position);
  }
  paint(point) {
    this.position={...point};
    this.cursor.style.transform=`translate(${point.x}px,${point.y}px)`;
  }
  refresh() {
    if(!this.event || this.pending || this.layer.dataset.phase!=='start')return;
    this.destination=this.locate(this.event,this.resolve);
    if(!this.moving)this.paint(this.destination);
  }
  finish(event) {
    if(event.id!==this.id)return;
    this.layer.dataset.phase=event.phase;
    this.label.textContent=event.phase==='failed'?'Agent · action failed':event.kind==='typing'?'Agent · edited':'Agent';
    if(event.phase==='done' && event.kind==='click') {
      Object.assign(this.ripple.style,{left:this.position.x+'px',top:this.position.y+'px'});
      this.rippleMotion?.cancel();
      this.rippleMotion=this.ripple.animate([{opacity:.8,transform:'translate(-50%,-50%) scale(.3)'},{opacity:0,transform:'translate(-50%,-50%) scale(2.4)'}],{duration:this.reduced?0:520,easing:'ease-out'});
      this.pressMotion?.cancel();
      this.pressMotion=this.cursor.querySelector('svg').animate([{transform:'scale(1)'},{transform:'scale(.82)'},{transform:'scale(1)'}],{duration:this.reduced?0:220});
    }
    this.timer=setTimeout(()=>this.layer.classList.remove('visible'),10000);
  }
  handle(event,resolve) {
    if(event.phase==='start') {
      clearTimeout(this.timer);cancelAnimationFrame(this.frame);
      this.rippleMotion?.cancel();this.pressMotion?.cancel();
      this.id=event.id;this.event=event;this.resolve=resolve;this.pending=null;
      this.destination=null;
      this.layer.classList.add('visible');
      this.layer.dataset.kind=event.kind;this.layer.dataset.phase='start';
      this.label.textContent={click:'Agent · click',typing:'Agent · typing',select:'Agent · select',scroll:'Agent · scrolling'}[event.kind] || 'Agent';
      this.destination=this.locate(event,resolve);
      const start={...this.position},began=performance.now();
      const duration=this.reduced?0:Math.min(400,event.duration||240);
      this.moving=true;
      const step=now=>{
        if(event.id!==this.id)return;
        if(!this.pending)this.destination=this.locate(event,resolve);
        const t=duration?Math.min(1,(now-began)/duration):1;
        const ease=1-Math.pow(1-t,3);
        this.paint({x:start.x+(this.destination.x-start.x)*ease,y:start.y+(this.destination.y-start.y)*ease});
        if(t<1)this.frame=requestAnimationFrame(step);
        else {
          this.moving=false;
          if(this.pending)this.finish(this.pending);
        }
      };
      this.frame=requestAnimationFrame(step);
    } else if(event.id===this.id) {
      // Freeze the last observed target when the action completes. Its click
      // handler may already have removed it or laid out an entirely new page.
      this.pending=event;
      if(!this.moving)this.finish(event);
    }
  }
}
