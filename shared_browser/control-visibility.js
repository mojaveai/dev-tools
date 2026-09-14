// Layout boxes alone do not imply paint visibility (notably closed <details>).
// Return the source box plus clipping for its native viewer overlay.
export function controlVisibility(source) {
  const win=source.ownerDocument.defaultView;
  const rect=source.getBoundingClientRect();
  if(!rect.width || !rect.height)return null;
  const own=win.getComputedStyle(source);
  if(own.visibility!=='visible')return null;
  let left=Math.max(0,rect.left),top=Math.max(0,rect.top);
  let right=Math.min(win.innerWidth,rect.right),bottom=Math.min(win.innerHeight,rect.bottom);
  for(let node=source;node;node=node.parentElement) {
    const css=win.getComputedStyle(node);
    if(css.display==='none' || css.contentVisibility==='hidden')return null;
    // Editable replay sources deliberately have opacity zero; ancestor opacity
    // still determines whether their native overlay should exist.
    if(node!==source && Number(css.opacity)===0)return null;
    if(node.tagName==='DETAILS' && !node.open) {
      const summary=[...node.children].find(child=>child.tagName==='SUMMARY');
      if(!summary?.contains(source))return null;
    }
    if(node===source)continue;
    const r=node.getBoundingClientRect();
    if(/^(hidden|clip|auto|scroll)$/.test(css.overflowX)) {
      left=Math.max(left,r.left+node.clientLeft);
      right=Math.min(right,r.left+node.clientLeft+node.clientWidth);
    }
    if(/^(hidden|clip|auto|scroll)$/.test(css.overflowY)) {
      top=Math.max(top,r.top+node.clientTop);
      bottom=Math.min(bottom,r.top+node.clientTop+node.clientHeight);
    }
  }
  if(right<=left || bottom<=top)return null;
  return {rect,bounds:{left,top,right,bottom},clip:`inset(${top-rect.top}px ${rect.right-right}px ${rect.bottom-bottom}px ${left-rect.left}px)`};
}
