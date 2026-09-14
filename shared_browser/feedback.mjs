import { randomUUID } from 'node:crypto';
export class ActionFeedback {
  constructor({send,hasViewers,delay=ms=>new Promise(r=>setTimeout(r,ms)),leadMs=240}) {
    Object.assign(this,{send,hasViewers,delay,leadMs});
  }
  async run(metadata,action) {
    if(!this.hasViewers()) return action();
    const event={type:'agentActivity',id:randomUUID(),...metadata,duration:this.leadMs};
    this.send({...event,phase:'start'});
    try {
      await this.delay(this.leadMs);
      const result=await action();
      this.send({...event,phase:'done'});
      return result;
    } catch(error) {
      this.send({...event,phase:'failed'});
      throw error;
    }
  }
}
