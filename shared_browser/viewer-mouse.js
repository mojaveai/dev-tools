// Relay observed mouse input; never synthesize paths or human-like timing.
// Touch keeps its existing tap/scroll path so scrolling cannot press a page control.
export function relayMouse(element,{enabled,context,point,send}) {
  const abort=new AbortController();
  let pending,frame,held,moveInFlight,suppressClick=false;
  const flush=()=>{cancelAnimationFrame(frame);frame=null;if(pending){const m=pending;pending=null;moveInFlight=send(m);}};
  const message=(e,phase)=>({type:'pointer',phase,...context(),...point(e),button:e.button,
    modifiers:(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0),clickCount:Math.max(1,e.detail||1)});
  const cancel=()=>{pending=null;cancelAnimationFrame(frame);frame=null;if(held){send({...held,phase:'cancel'});held=null;}};
  const on=(target,type,fn)=>target.addEventListener(type,fn,{signal:abort.signal});
  on(element,'pointermove',e=>{
    if(!enabled() || e.pointerType!=='mouse' || (e.target!==element && !held))return;
    pending=message(e,'move');
    if(!frame && !moveInFlight)frame=requestAnimationFrame(flush);
  });
  on(element,'pointerdown',e=>{
    suppressClick=false;
    if(!enabled() || e.pointerType!=='mouse' || e.target!==element || e.button!==0)return;
    flush();held=message(e,'down');suppressClick=true;
    element.setPointerCapture(e.pointerId);send(held);
  });
  on(element,'pointerup',e=>{
    if(!held || e.pointerType!=='mouse' || e.button!==0)return;
    flush();send({...message(e,'up'),tab:held.tab,generation:held.generation});held=null;
    if(element.hasPointerCapture(e.pointerId))element.releasePointerCapture(e.pointerId);
  });
  on(element,'pointercancel',cancel);
  on(element,'lostpointercapture',()=>{if(held)cancel();});
  on(window,'blur',cancel);
  return {
    acknowledge(id){if(id!==moveInFlight)return;moveInFlight=null;if(pending && !frame)frame=requestAnimationFrame(flush);},
    consumesClick(e){if(e.detail>0 && suppressClick){suppressClick=false;return true;}return false;},
    dispose(){cancel();abort.abort();},
  };
}
