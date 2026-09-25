// A replay selection belongs to a sandboxed child document while keyboard
// focus stays in the viewer. Supply its text to the browser's normal copy event.
export function replaySelection(doc) {
  if (!doc) return '';
  const selected = doc.getSelection()?.toString();
  if (selected) return selected;
  for (const frame of doc.querySelectorAll('iframe')) {
    try { const value = replaySelection(frame.contentDocument); if (value) return value; } catch {}
  }
  return '';
}
export function copyReplaySelection(event, doc, localDocument = document) {
  const focused = localDocument.activeElement;
  // Native fields and contenteditable keep native copy, including masked fields.
  if (focused?.matches('input,textarea,select') || focused?.isContentEditable ||
      localDocument.getSelection()?.toString()) return false;
  const text = replaySelection(doc);
  if (!text || !event.clipboardData) return false;
  event.clipboardData.setData('text/plain', text);
  event.preventDefault();
  return true;
}

export function handleReplayCopyKey(event, doc, localDocument = document, clipboard = navigator.clipboard, onError = () => {}, pendingSelection, ClipboardItemType = globalThis.ClipboardItem) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'c') return false;
  const focused = localDocument.activeElement;
  if (focused?.matches('input,textarea,select') || focused?.isContentEditable) return false;
  const local = localDocument.getSelection();
  if (local?.toString() && (!local.anchorNode || local.anchorNode.ownerDocument===localDocument)) return false;
  const pending = clipboard?.write && ClipboardItemType && pendingSelection?.();
  if (pending) {
    event.preventDefault();
    clipboard.write([new ClipboardItemType({'text/plain': pending.then(text => new Blob([text], {type:'text/plain'}))})]).catch(onError);
    return true;
  }
  const text = replaySelection(doc);
  if (!text || !clipboard?.writeText) return false;
  event.preventDefault();
  // Safari can dispatch its copy event inside the script-disabled replay frame.
  // Use the keyboard gesture in the focused viewer to write the local clipboard.
  clipboard.writeText(text).catch(onError);
  return true;
}

export async function settledReplaySelection(read, acknowledged, {timeout=1500, interval=40} = {}) {
  let timer;
  try {
    const ok = await Promise.race([acknowledged, new Promise((_, reject) => {timer=setTimeout(() => reject(Error('Pointer acknowledgement timed out')), timeout);})]);
    if (ok===false) throw Error('Pointer input was rejected');
  } finally {clearTimeout(timer);}
  const until = Date.now() + timeout;
  let previous='', stableSince=0;
  while (Date.now() < until) {
    const text=read();
    if (text && text===previous && Date.now()-stableSince>=120) return text;
    if (text!==previous) {previous=text;stableSince=Date.now();}
    await new Promise(resolve=>setTimeout(resolve,interval));
  }
  throw Error('Selection did not arrive');
}
