// WebKit paints composited HTML transforms inside SVG foreignObject at the
// SVG origin. Sites may emit different markup for Safari, but replay receives
// the source browser's markup. Transfer a single chain of 2D HTML transforms
// to an equivalent SVG matrix without changing text, links, or recorder IDs.
export class ForeignObjectTransforms {
  constructor(doc) {
    this.doc=doc;this.entries=new Map();
    doc.fonts?.addEventListener('loadingdone',()=>this.refresh(true));
  }
  restore(entry) {
    for(const {node,value,priority} of entry.transforms) {
      if(node.style.getPropertyValue('transform')==='none' && node.style.getPropertyPriority('transform')==='important')
        node.style.setProperty('transform',value,priority);
    }
    if(entry.wrapper.contains(entry.node))entry.wrapper.replaceWith(entry.node);
    else entry.wrapper.remove();
  }
  refresh(force=false) {
    const doc=this.doc,win=doc.defaultView;
    for(const [node,entry] of this.entries) {
      if(!node.isConnected){entry.wrapper.remove();this.entries.delete(node);}
    }
    for(const node of doc.querySelectorAll('foreignObject')) {
      const previous=this.entries.get(node);
      if(previous && !force && previous.signature===node.outerHTML && previous.wrapper.contains(node))continue;
      if(previous){this.restore(previous);this.entries.delete(node);}
      const ctm=node.getScreenCTM();
      // Restrict normalization to ordinary scaled/translated SVG coordinates;
      // complex existing SVG rotations and branching HTML layouts stay intact.
      if(!ctm || ctm.b || ctm.c || ctm.a<=0 || ctm.d<=0)continue;
      const chain=[];
      let element=node;
      while(element.children.length===1 && ![...element.childNodes].some(n=>n.nodeType===3 && n.textContent.trim())) {
        element=element.firstElementChild;
        if(element.namespaceURI!=='http://www.w3.org/1999/xhtml')break;
        chain.push(element);
      }
      if([...element.children].some(child=>child.tagName!=='BR') || !chain.length)continue;
      const transforms=[];
      let supported=true;
      for(const child of chain) {
        const css=win.getComputedStyle(child);
        if(css.transform==='none')continue;
        const matrix=new win.DOMMatrix(css.transform);
        if(!matrix.is2D || css.animationName!=='none'){supported=false;break;}
        const origin=css.transformOrigin.split(' ').map(parseFloat);
        if(!origin.slice(0,2).every(Number.isFinite)){supported=false;break;}
        transforms.push({node:child,matrix,origin,value:child.style.getPropertyValue('transform'),priority:child.style.getPropertyPriority('transform')});
      }
      if(!supported || !transforms.length)continue;
      for(const item of transforms)item.node.style.setProperty('transform','none','important');
      const box=node.getBoundingClientRect();
      let matrix=new win.DOMMatrix();
      for(const item of transforms) {
        const r=item.node.getBoundingClientRect();
        const x=(r.x-box.x)/ctm.a+item.origin[0],y=(r.y-box.y)/ctm.d+item.origin[1];
        matrix=matrix.translate(x,y).multiply(item.matrix).translate(-x,-y);
      }
      const x=node.x.baseVal.value,y=node.y.baseVal.value;
      matrix=new win.DOMMatrix().translate(x,y).multiply(matrix).translate(-x,-y);
      const wrapper=doc.createElementNS('http://www.w3.org/2000/svg','g');
      wrapper.setAttribute('transform',`matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`);
      node.before(wrapper);wrapper.append(node);
      this.entries.set(node,{node,wrapper,transforms,signature:node.outerHTML});
    }
  }
}
