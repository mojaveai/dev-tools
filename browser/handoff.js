import UI from './app/ui.js';

const bar = document.createElement('div');
bar.id = 'devtools-handoff';
bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:10000;display:flex;align-items:center;gap:14px;max-width:80vw;padding:12px 18px;border-radius:10px;background:#172033;color:white;font:15px system-ui;box-shadow:0 3px 18px #0006;';
bar.setAttribute('role', 'status');
const label = document.createElement('span');
const done = document.createElement('button');
done.textContent = 'Done';
done.style.cssText = 'padding:8px 16px;border:0;border-radius:6px;background:#75e0b0;color:#10251d;font:600 15px system-ui;cursor:pointer;';
bar.append(label, done);
document.body.append(bar);
let current, lastKey, lastRfb, completing = false;
function input(enabled) {
    if (UI.rfb) UI.rfb.viewOnly = !enabled;
    const checkbox = document.getElementById('noVNC_setting_view_only');
    if (checkbox) checkbox.checked = !enabled;
}
async function poll() {
    try {
        const response = await fetch('./handoff-state', {cache:'no-store', signal:AbortSignal.timeout(4000)});
        if (!response.ok) throw new Error('status unavailable');
        current = await response.json();
        const pending = current.status === 'pending';
        const key = `${current.id}:${current.status}`;
        if (key !== lastKey || UI.rfb !== lastRfb) {
            input(pending && !completing);
            lastKey = key; lastRfb = UI.rfb;
        }
        label.textContent = pending ? `Your turn: ${current.message}` : 'Watching · Agent control';
        done.hidden = !pending;
        done.disabled = completing;
    } catch {
        input(false); lastKey = null;
        label.textContent = 'Handoff unavailable · View only'; done.hidden = true;
    }
}
done.onclick = async () => {
    if (!current || completing) return;
    completing = true; done.disabled = true; input(false);
    try {
        const response = await fetch('./handoff-done', {method:'POST',
            headers:{'Content-Type':'application/json','X-DevTools-Handoff':'1'},
            body:JSON.stringify({id:current.id}), signal:AbortSignal.timeout(4000)});
        if (!response.ok) throw new Error('completion failed');
    } catch {
        label.textContent = 'Could not confirm completion. Please try Done again.';
    } finally {
        completing = false; lastKey = null; await poll();
    }
};
await poll();
setInterval(poll, 1000);
