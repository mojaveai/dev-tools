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
  reset() {clearTimeout(this.timer);this.motion?.cancel();this.id=null;this.event=null;this.layer.classList.remove('visible');}
  locate(event,resolve) {
    const r=resolve(event.node);
    this.rect=r;
    if(r) {
      Object.assign(this.target.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'});
      this.target.hidden=false;
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    }
    this.target.hidden=true;
    return Number.isFinite(event.x)?{x:event.x,y:event.y}:this.position;
  }
  refresh() {
    if(!this.event || !this.resolve || !this.base)return;
    const end=this.locate(this.event,this.resolve);
    this.cursor.style.opacity=this.event.node && this.target.hidden ? "0" : "1";
    this.cursor.style.left=(end.x-this.base.x)+"px";
    this.cursor.style.top=(end.y-this.base.y)+"px";
    this.position=end;
  }
  handle(event,resolve) {
    clearTimeout(this.timer);
    if(event.phase==='start') {
      this.id=event.id;this.event=event;this.resolve=resolve;this.layer.classList.add('visible');
      this.layer.dataset.kind=event.kind;this.layer.dataset.phase='start';
      this.label.textContent={click:'Agent · click',typing:'Agent · typing',select:'Agent · select',scroll:'Agent · scrolling'}[event.kind] || 'Agent';
      const end=this.locate(event,resolve),start=this.position;
      this.base=end;this.cursor.style.left="0px";this.cursor.style.top="0px";this.cursor.style.opacity="1";
      this.motion?.cancel();
      this.cursor.style.transform=`translate(${end.x}px,${end.y}px)`;
      const duration=this.reduced?0:Math.min(400,event.duration||240);
      this.motion=this.cursor.animate([
        {transform:`translate(${start.x}px,${start.y}px) rotate(-5deg)`},
        {transform:`translate(${(start.x+end.x)/2}px,${(start.y+end.y)/2-18}px) rotate(3deg)`,offset:0.55},
        {transform:`translate(${end.x}px,${end.y}px) rotate(0deg)`}
      ],{duration,easing:'cubic-bezier(.2,.8,.25,1)'});
      this.position=end;
    } else if(event.id===this.id) {
      const finish=()=>{
        this.refresh();
        if(event.id!==this.id)return;
        this.layer.dataset.phase=event.phase;
        this.label.textContent=event.phase==='failed'?'Agent · action failed':event.kind==='typing'?'Agent · edited':'Agent';
        if(event.phase==='done' && event.kind==='click') {
          Object.assign(this.ripple.style,{left:this.position.x+'px',top:this.position.y+'px'});
          this.ripple.animate([{opacity:.8,transform:'translate(-50%,-50%) scale(.3)'},{opacity:0,transform:'translate(-50%,-50%) scale(2.4)'}],{duration:this.reduced?0:520,easing:'ease-out'});
          this.cursor.animate([{scale:'1'},{scale:'.82'},{scale:'1'}],{duration:this.reduced?0:220});
        }
        this.timer=setTimeout(()=>this.layer.classList.remove('visible'),10000);
      };
      (this.motion?.finished || Promise.resolve()).then(finish,()=>{});
    }
  }
}
