// Forward canvas pixels as inert images. Keep rrweb's script-free replay sandbox;
// replaying arbitrary canvas commands requires enabling scripts in that sandbox.
export function installCanvasSnapshots() {
  if (window.__sharedCanvasSnapshots) return;
  window.__sharedCanvasSnapshots = true;
  const previous = new WeakMap();
  const capture = () => {
    for (const canvas of document.querySelectorAll('canvas')) {
      const rect = canvas.getBoundingClientRect();
      if (!canvas.width || !canvas.height || canvas.width * canvas.height > 4_000_000 ||
          !rect.width || !rect.height || rect.bottom < 0 || rect.right < 0 ||
          rect.top > innerHeight || rect.left > innerWidth) continue;
      try {
        const bitmap = canvas.toDataURL('image/png');
        if (bitmap.length > 4_000_000 || bitmap === previous.get(canvas)) continue;
        previous.set(canvas, bitmap);
        canvas.setAttribute('data-shared-canvas', bitmap);
      } catch { /* Tainted canvases cannot be read by the recorder. */ }
    }
  };
  setInterval(capture, 200);
  capture();
}

export function paintCanvasSnapshots(doc) {
  for (const canvas of doc.querySelectorAll('canvas[data-shared-canvas]')) {
    const bitmap = canvas.getAttribute('data-shared-canvas');
    if (!bitmap?.startsWith('data:image/png;base64,') || bitmap.length > 4_000_000 || (canvas.__sharedBitmap === bitmap && canvas.style.backgroundImage.includes(bitmap))) continue;
    canvas.__sharedBitmap = bitmap;
    // With scripts disabled, browsers render canvas fallback content instead
    // of its drawing surface. Paint an inert CSS image on the same element so
    // canvas selectors, sizing, transforms and rrweb node IDs stay intact.
    const computed = doc.defaultView.getComputedStyle(canvas);
    if (computed.width === 'auto') canvas.style.width = canvas.width + 'px';
    if (computed.height === 'auto') canvas.style.height = canvas.height + 'px';
    if (computed.display === 'inline')
      canvas.style.display = 'inline-block';
    canvas.style.backgroundImage = `url("${bitmap}")`;
    canvas.style.backgroundSize = '100% 100%';
    canvas.style.backgroundRepeat = 'no-repeat';
  }
  for (const frame of doc.querySelectorAll('iframe')) {
    try { if (frame.contentDocument) paintCanvasSnapshots(frame.contentDocument); } catch {}
  }
}
