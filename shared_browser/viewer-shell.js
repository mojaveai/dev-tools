// Browser chrome floats over the page; opening it never resizes remote Chrome.
export class ViewerShell {
  constructor() {
    this.handle=document.getElementById('viewer-handle');
    this.toolbar=document.getElementById('viewer-toolbar');
    if(!this.handle || !this.toolbar)return;
    const show=()=>{clearTimeout(this.timer);this.toolbar.hidden=false;this.handle.setAttribute('aria-expanded','true');};
    const hide=()=>{clearTimeout(this.timer);this.pinned=false;this.toolbar.hidden=true;this.handle.setAttribute('aria-expanded','false');};
    this.handle.onclick=()=>{if(this.pinned)hide();else{show();this.pinned=true;}};
    this.handle.onpointerenter=e=>{if(e.pointerType==='mouse')show();};
    this.toolbar.onpointerenter=()=>clearTimeout(this.timer);
    this.toolbar.onpointerleave=()=>{this.timer=setTimeout(()=>{if(!this.pinned&&!this.toolbar.contains(document.activeElement))hide();},500);};
    this.handle.onpointerleave=()=>{this.timer=setTimeout(()=>{if(!this.pinned&&!this.toolbar.matches(':hover')&&!this.toolbar.contains(document.activeElement))hide();},500);};
    document.getElementById('viewer-close').onclick=()=>{hide();this.handle.focus();};
    document.addEventListener('pointerdown',e=>{if(!this.toolbar.contains(e.target)&&!this.handle.contains(e.target))hide();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!this.toolbar.hidden){hide();this.handle.focus();}});
  }
  update({connected,message}) {
    if(!this.handle)return;
    this.handle.dataset.connected=String(connected);
    this.handle.title=connected?'Shared browser controls':'Reconnecting to shared browser';
    document.getElementById('notice').textContent=message || '';
    document.getElementById('agent-note').hidden=!message;
  }
}
