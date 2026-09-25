import { replaySelection } from './viewer-clipboard.js';

// Clipboard access happens only after the user chooses a menu action.
export function installContextMenu({root, replayDocument, valid, reportError}) {
  let menu;
  const listeners = new AbortController();
  const options = {capture:true, signal:listeners.signal};
  const close = () => { menu?.remove(); menu = null; };
  document.addEventListener('pointerdown', e => { if (!menu?.contains(e.target)) close(); }, options);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); }, {signal:listeners.signal});
  window.addEventListener('blur', close, {signal:listeners.signal});
  window.addEventListener('resize', close, {signal:listeners.signal});
  document.addEventListener('scroll', close, options);
  root.addEventListener('contextmenu', e => {
    const field = e.target.closest('input,textarea');
    // Preserve native menus for controls that do not support text selection.
    if (e.target !== root && (!field || field.selectionStart === null)) return;
    if (!valid()) return;
    e.preventDefault(); close();
    const doc = replayDocument();
    const start = field?.selectionStart, end = field?.selectionEnd;
    const text = field ? (field.type === 'password' ? '' : field.value.slice(start, end)) : replaySelection(doc);
    const current = () => valid() && replayDocument() === doc && (!field || field.isConnected);
    menu = document.createElement('div');
    menu.id = 'clipboard-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Clipboard');
    menu.style.cssText = 'position:fixed;z-index:10000;min-width:150px;padding:4px;background:#fff;color:#111;border:1px solid #bbb;border-radius:6px;box-shadow:0 4px 16px #0003;font:14px system-ui';
    const add = (label, enabled, action) => {
      const button = document.createElement('button');
      button.textContent = label; button.disabled = !enabled;
      button.setAttribute('role', 'menuitem');
      button.style.cssText = 'display:block;width:100%;padding:7px 14px;text-align:left;border:0;border-radius:3px;background:transparent;color:inherit;font:inherit;cursor:pointer';
      if (!enabled) button.style.opacity = '.4';
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', async () => {
        close();
        if (!current()) return;
        try { await action(); } catch { reportError(`Could not ${label.toLowerCase()}. Check Chrome’s clipboard permission or use the keyboard shortcut.`); }
      });
      menu.append(button);
    };
    add('Copy', !!text, () => navigator.clipboard.writeText(text));
    add('Paste', !!field && !field.readOnly && !field.disabled, async () => {
      const value = await navigator.clipboard.readText();
      if (!current() || field.readOnly || field.disabled) return;
      field.focus({preventScroll:true});
      field.setSelectionRange(start, end);
      // Native editing preserves undo and dispatches the input event used by
      // the existing remote fill relay.
      if (!document.execCommand('insertText', false, value)) {
        field.setRangeText(value, start, end, 'end');
        field.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'insertFromPaste',data:value}));
      }
    });
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(e.clientX, innerWidth - rect.width)) + 'px';
    menu.style.top = Math.max(0, Math.min(e.clientY, innerHeight - rect.height)) + 'px';
  });
  return () => { close(); listeners.abort(); };
}
