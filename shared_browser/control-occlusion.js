// Native controls live above the replay iframe. Only create them where the
// corresponding source control is actually reachable in the page's paint stack.
export function controlOcclusion(doc) {
  const style=doc.createElement('style');
  // Replay disables iframe input. Restore iframe hit-testing only while
  // measuring so dialogs inside those frames can occlude background fields.
  style.textContent='iframe { pointer-events: auto !important; }';
  // Pages without embedded frames need no temporary stylesheet. Inserting
  // and removing one otherwise invalidates style during every scroll frame.
  if(doc.querySelector('iframe'))doc.documentElement.append(style);
  const transparent=new Map();
  const invisible=element=>{
    if(transparent.has(element))return transparent.get(element);
    const result=doc.defaultView.getComputedStyle(element).opacity==='0' ||
      (element.parentElement ? invisible(element.parentElement) : false);
    transparent.set(element,result);return result;
  };
  return {
    visible(source,{bounds}) {
      const {left,top,right,bottom}=bounds;
      const dx=Math.min(2,(right-left)/2),dy=Math.min(2,(bottom-top)/2);
      const points=[[(left+right)/2,(top+bottom)/2],[left+dx,top+dy],[right-dx,top+dy],[left+dx,bottom-dy],[right-dx,bottom-dy]];
      let reached=false;
      const unobscured=points.every(([x,y])=>{
        for(const node of doc.elementsFromPoint(x,y)){
          if(node===source || source.contains(node)){reached=true;return true;}
          if(node.contains(source) || invisible(node))continue;
          return false;
        }
        // Rounded corners and WebKit's transparent textarea resize corner can
        // hit only ancestors. That is empty space, not an occluding element.
        return true;
      });
      return unobscured && reached;
    },
    dispose(){style.remove();},
  };
}
