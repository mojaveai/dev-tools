// Relay observed mouse input; never synthesize paths or human-like timing.
// Touch keeps its existing tap/scroll path so scrolling cannot press a page control.
export function relayMouse(element,{enabled,context,point,send}) {
  const abort=new AbortController();
  // Pipeline ordinary frame-rate input across network latency. One outstanding
  // move limits a 200 ms connection to five samples/second. Bound the pipeline
  // so a stalled receiver cannot accumulate an unbounded trail of old positions.
  const movesInFlight=new Set(),maxMovesInFlight=32;
  let pending,frame,held,suppressClick=false;
  const schedule=()=>{if(pending&&!frame&&movesInFlight.size<maxMovesInFlight)frame=requestAnimationFrame(()=>flush());};
  const flush=(force=false)=>{
    cancelAnimationFrame(frame);frame=null;
    if(pending&&(force||movesInFlight.size<maxMovesInFlight)){
      const m=pending;pending=null;const id=send(m);if(id)movesInFlight.add(id);
    }
  };
  const message=(e,phase)=>({type:'pointer',phase,...context(),...point(e),button:e.button,
    pressure:e.pressure,modifiers:(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0),clickCount:Math.max(1,e.detail||1)});
  const cancel=()=>{pending=null;cancelAnimationFrame(frame);frame=null;if(held){send({...held,phase:'cancel'});held=null;}};
  const on=(target,type,fn)=>target.addEventListener(type,fn,{signal:abort.signal});
  on(element,'pointermove',e=>{
    if(!enabled() || e.pointerType!=='mouse' || (e.target!==element && !held))return;
    pending=message(e,'move');
    schedule();
  });
  on(element,'pointerdown',e=>{
    suppressClick=false;
    if(!enabled() || e.pointerType!=='mouse' || e.target!==element || e.button!==0)return;
    e.preventDefault(); // Do not start a competing local text selection.
    flush(true);held=message(e,'down');suppressClick=true;
    element.setPointerCapture(e.pointerId);send(held);
  });
  on(element,'pointerup',e=>{
    if(!held || e.pointerType!=='mouse' || e.button!==0)return;
    flush(true);send({...message(e,'up'),tab:held.tab,generation:held.generation});held=null;
    if(element.hasPointerCapture(e.pointerId))element.releasePointerCapture(e.pointerId);
  });
  on(element,'pointercancel',cancel);
  on(element,'lostpointercapture',()=>{if(held)cancel();});
  on(window,'blur',cancel);
  return {
    acknowledge(id){if(movesInFlight.delete(id))schedule();},
    consumesClick(e){if(e.detail>0 && suppressClick){suppressClick=false;return true;}return false;},
    dispose(){cancel();abort.abort();},
  };
}
