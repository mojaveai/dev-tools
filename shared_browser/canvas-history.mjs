// Keep only the latest bitmap for each rrweb node. Canvas pixels are a current
// visual state, not a reason to rebuild the DOM after every few animation frames.
// Returns bytes excluded from the DOM checkpoint budget. Self-contained so this
// function can also be installed in a retained receiver's existing emit callback.
export function compactCanvasHistory(event, state) {
  if (event.type === 2) state.canvasHistory = new Map();
  const history = state.canvasHistory ||= new Map();
  let bytes = 0;
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    const attrs = node.attributes;
    if (Number.isInteger(node.id) && attrs && typeof attrs['data-shared-canvas'] === 'string') {
      const value = attrs['data-shared-canvas'];
      bytes += JSON.stringify(value).length;
      const old = history.get(node.id);
      if (old && old !== attrs) delete old['data-shared-canvas'];
      history.set(node.id, attrs);
    }
    for (const child of node.childNodes || []) visit(child);
  };
  if (event.type === 2) visit(event.data.node);
  if (event.type === 3 && event.data.source === 0) {
    for (const {node} of event.data.adds || []) visit(node);
    for (const mutation of event.data.attributes || []) visit(mutation);
    for (const {id} of event.data.removes || []) history.delete(id);
  }
  return bytes;
}
