// One queued gesture prevents other participants from splitting down/move/up.
export async function dragMouse(mouse, from, to, {steps = 20} = {}) {
  if (![from, to].every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))
    throw Error('Drag coordinates must be [x, y] with finite numbers');
  if (!Number.isInteger(steps) || steps < 1 || steps > 200)
    throw Error('Drag steps must be an integer from 1 to 200');
  await mouse.move(...from);
  await mouse.down();
  try { await mouse.move(...to, {steps}); }
  finally { await mouse.up(); }
}
