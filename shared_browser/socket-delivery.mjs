// A single snapshot can exceed the old 8 MiB bufferedAmount threshold. Sending
// it and then disconnecting on the next event caused endless reconnects.
export function createSocketDelivery({maxQueuedBytes=64*1024*1024}={}) {
  const queues=new WeakMap();
  return (ws,raw)=>{
    if(ws.readyState!==1)return;
    let queue=queues.get(ws);
    if(!queue){queue={items:[],bytes:0,busy:false};queues.set(ws,queue);}
    const bytes=Buffer.byteLength(raw);
    if(queue.bytes+bytes>maxQueuedBytes){
      queue.items=[];queue.bytes=0;
      ws.close(1013,'Viewer cannot keep up; reconnect for current state');return;
    }
    queue.items.push({raw,bytes});queue.bytes+=bytes;
    const drain=()=>{
      if(queue.busy)return;
      if(ws.readyState!==1){queue.items=[];queue.bytes=0;return;}
      const item=queue.items.shift();if(!item)return;
      queue.busy=true;
      ws.send(item.raw,error=>{
        queue.busy=false;queue.bytes=Math.max(0,queue.bytes-item.bytes);
        if(error){queue.items=[];queue.bytes=0;ws.terminate();return;}
        queueMicrotask(drain);
      });
    };
    drain();
  };
}
