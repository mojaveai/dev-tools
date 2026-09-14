// Tracks latest local position independently of network latency.
export class ScrollSync {
  constructor() { this.sequence=0; this.pending=new Map(); }
  update(node,x,y) {
    const value={node,x,y,sequence:++this.sequence};
    this.pending.set(node,value); return value;
  }
  acknowledge(value) {
    const current=this.pending.get(value.node);
    if (!current || current.sequence!==value.sequence) return false;
    this.pending.delete(value.node); return true;
  }
  clear() { this.pending.clear(); }
}
