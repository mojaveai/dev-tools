// Button state belongs to the originating connection. A disconnected viewer
// must never leave Chrome dragging. All calls run inside the session queue.
export class RemoteMouse {
  held=new Map();
  async release(client) {
    const held=this.held.get(client);if(!held)return;
    this.held.delete(client);
    // Releasing on the pressed control would accidentally activate it during
    // disconnect/cancel. Release outside the page instead.
    await held.tab.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:-1,y:-1,button:'left',buttons:0,clickCount:1}).catch(()=>{});
  }
  async dispatch(client,tab,m) {
    if(m.phase==='cancel'){await this.release(client);return;}
    if(!['move','down','up'].includes(m.phase) || ![m.x,m.y].every(Number.isFinite) ||
      !Number.isInteger(m.modifiers) || m.modifiers<0 || m.modifiers>15 ||
      (m.phase!=='move' && m.button!==0))throw Error('Invalid mouse event');
    let held=this.held.get(client);
    if(held && (held.tab!==tab || held.generation!==m.generation)){await this.release(client);held=null;}
    if(m.phase==='up' && !held)return;
    if(m.phase==='down'){
      await this.release(client);
      // A second participant pressing takes over the single physical pointer.
      for(const [other,state] of this.held)if(state.tab===tab)await this.release(other);
      held={tab,generation:m.generation,x:m.x,y:m.y};this.held.set(client,held);
    }
    if(held){held.x=m.x;held.y=m.y;}
    await tab.cdp.send('Input.dispatchMouseEvent',{
      type:m.phase==='move'?'mouseMoved':m.phase==='down'?'mousePressed':'mouseReleased',
      x:m.x,y:m.y,button:held?'left':'none',buttons:held && m.phase!=='up'?1:0,
      modifiers:m.modifiers,clickCount:m.phase==='move'?0:Math.max(1,Math.min(3,Number(m.clickCount)||1)),
    });
    if(m.phase==='up')this.held.delete(client);
  }
}
