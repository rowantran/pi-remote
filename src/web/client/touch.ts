import type { XtermTerminal } from './terminal.js';

/** Touch scrolling never sends a remote command. Pi's local ScrollView owns the document;
 * xterm's alternate-screen buffer is only the current viewport. */
export function installTouchScroll(element: HTMLElement, terminal: XtermTerminal, scroll: (lines: number) => void): { stop(): void; dispose(): void } {
  element.classList.add('touch-terminal');
  let active: { id: number; x: number; startY: number; y: number; time: number; velocity: number; moved: boolean } | undefined;
  let frame = 0;
  let remainder = 0;
  let lastTouch = 0;
  const screen = () => element.querySelector('.xterm-screen')?.getBoundingClientRect() ?? element.getBoundingClientRect();
  const move = (pixels: number) => {
    remainder += pixels / Math.max(1, screen().height / terminal.rows);
    const lines = Math.trunc(remainder);
    if (lines) { remainder -= lines; scroll(lines); }
  };
  const click = (x: number, y: number) => {
    const rect = screen();
    const col = Math.max(1, Math.min(terminal.columns, Math.floor((x - rect.left) / rect.width * terminal.columns) + 1));
    const row = Math.max(1, Math.min(terminal.rows, Math.floor((y - rect.top) / rect.height * terminal.rows) + 1));
    terminal.sendKey(`\x1b[<0;${col};${row}M`);
    terminal.sendKey(`\x1b[<0;${col};${row}m`);
  };
  const start = (event: TouchEvent) => {
    if (event.touches.length !== 1) { active = undefined; return; }
    event.preventDefault(); event.stopImmediatePropagation(); cancelAnimationFrame(frame); remainder = 0;
    const touch = event.touches[0]!;
    active = { id: touch.identifier, x: touch.clientX, startY: touch.clientY, y: touch.clientY, time: performance.now(), velocity: 0, moved: false };
  };
  const drag = (event: TouchEvent) => {
    if (!active) return;
    const touch = [...event.touches].find(touch => touch.identifier === active!.id);
    if (!touch) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const now = performance.now(), delta = active.y - touch.clientY;
    if (!active.moved && Math.abs(touch.clientY - active.startY) < 5) return;
    active.moved = true;
    const elapsed = Math.max(1, now - active.time);
    active.velocity = Math.max(-2.5, Math.min(2.5, delta / elapsed));
    move(delta); active.y = touch.clientY; active.time = now;
  };
  const end = (event: TouchEvent) => {
    if (!active) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const gesture = active; active = undefined; lastTouch = performance.now();
    if (!gesture.moved) { click(gesture.x, gesture.y); return; }
    let velocity = performance.now() - gesture.time < 100 ? gesture.velocity : 0;
    let previous = performance.now();
    const coast = (now: number) => {
      const elapsed = Math.min(32, Math.max(0, now - previous)); previous = now;
      move(velocity * elapsed); velocity *= Math.exp(-elapsed / 180);
      if (Math.abs(velocity) > 0.04) frame = requestAnimationFrame(coast);
    };
    if (Math.abs(velocity) > 0.04) frame = requestAnimationFrame(coast);
  };
  const cancel = () => { active = undefined; cancelAnimationFrame(frame); };
  const tap = (event: MouseEvent) => {
    if (performance.now() - lastTouch < 500 || event.button !== 0) return;
    event.preventDefault(); event.stopImmediatePropagation(); click(event.clientX, event.clientY);
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault(); event.stopImmediatePropagation(); cancelAnimationFrame(frame);
    move(event.deltaY * (event.deltaMode === 1 ? screen().height / terminal.rows : event.deltaMode === 2 ? screen().height : 1));
  };
  element.addEventListener('touchstart', start, { capture: true, passive: false });
  element.addEventListener('touchmove', drag, { capture: true, passive: false });
  element.addEventListener('touchend', end, { capture: true, passive: false });
  element.addEventListener('touchcancel', cancel, true);
  element.addEventListener('click', tap, true);
  element.addEventListener('wheel', wheel, { capture: true, passive: false });
  return { stop: cancel, dispose() {
    cancel(); element.classList.remove('touch-terminal');
    element.removeEventListener('touchstart', start, true); element.removeEventListener('touchmove', drag, true);
    element.removeEventListener('touchend', end, true); element.removeEventListener('touchcancel', cancel, true);
    element.removeEventListener('click', tap, true); element.removeEventListener('wheel', wheel, true);
  } };
}
