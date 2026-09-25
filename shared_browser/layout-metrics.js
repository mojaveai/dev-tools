// Native scrollbar gutters affect wrapping and hit coordinates across OSes.
export function installLayoutMetrics() {
  if (window.__sharedLayoutMetricsV2) return;
  window.__sharedLayoutMetricsV2 = true;
  const update = () => {
    const root = document.documentElement;
    if (!root) return;
    const value = JSON.stringify([innerWidth-root.clientWidth, innerHeight-root.clientHeight, root.getBoundingClientRect().width, root.clientHeight]);
    if (root.getAttribute('data-shared-gutters') !== value) root.setAttribute('data-shared-gutters', value);
  };
  setInterval(update, 200);
  addEventListener('resize', update);
  update();
}
export function matchLayoutMetrics(doc) {
  const root = doc.documentElement;
  if (!root) return;
  const value = root.getAttribute('data-shared-gutters');
  if (value && root.__sharedGutters !== value) {
    try {
      const [width,height] = JSON.parse(value);
      if ([width,height].every(n=>Number.isFinite(n)&&n>=0&&n<=100)) {
        let style = doc.querySelector('style[data-shared-layout]');
        if (!style) {style=doc.createElement('style');style.setAttribute('data-shared-layout','');(doc.head||root).append(style);}
        style.textContent = `html {overflow-anchor:none!important;scrollbar-gutter:${width ? "stable" : "auto"}!important} html::-webkit-scrollbar {width:${width}px!important;height:${height}px!important}`;
        root.__sharedGutters = value;
      }
    } catch {}
  }
  // Overlay-scrollbar systems can ignore scrollbar-gutter. Match the source
  // content viewport rather than leaving centered controls half a gutter off.
  try {
    const [, , width, height] = JSON.parse(value || '[]');
    const frame = doc.defaultView.frameElement;
    if (frame && Number.isFinite(width) && width > 0) {
      const delta = width - root.getBoundingClientRect().width;
      if (Math.abs(delta) > 0.5) frame.style.width = (parseFloat(frame.ownerDocument.defaultView.getComputedStyle(frame).width) + delta) + 'px';
    }
  } catch {}
  for (const frame of doc.querySelectorAll('iframe')) {
    try {if(frame.contentDocument)matchLayoutMetrics(frame.contentDocument);}catch{}
  }
}
