import { installFrameSnapshots } from "./frame-snapshots.js";
installFrameSnapshots();
import { record } from "@rrweb/record";
// Each document gets a distinct generation; stale viewer input is never replayed.
const generation = crypto.randomUUID();
window.__sharedRecorderToken = generation;
window.__sharedGeneration = generation;
window.__sharedMirror = record.mirror;
function start() {
  if (window.__sharedRecorderToken !== generation || window.__sharedStop) return;
  window.__sharedStop = record({
    emit(event) {
      window.__sharedEmit({ generation, event }).catch(() => {});
    },
    inlineStylesheet: true,
    inlineImages: true,
    collectFonts: true,
    recordCanvas: false,
    recordCrossOriginIframes: true,
    maskInputOptions: { password: true },
    sampling: { mousemove: 50, scroll: 100 },
  });
  window.__sharedSnapshot = () => record.takeFullSnapshot();
}
if (document.readyState === "loading")
  addEventListener("DOMContentLoaded", start, { once: true });
else start();
