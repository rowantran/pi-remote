import {
  TuiAltScreen, type Terminal, type TuiAltScreenOptions, type TuiStopOptions,
} from '@earendil-works/pi-tui';

/** Monotonic time and cancellable timers; injectable for deterministic tests. */
export interface RenderClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

const systemClock: RenderClock = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export interface ScheduledTuiOptions extends TuiAltScreenOptions {
  /** Minimum interval between normal frame starts, not between frame completions. */
  renderIntervalMs?: number;
}

/**
 * Local scheduling for pi-remote, without changing Pi's renderer or private state.
 * Normal requests never enter TuiBase's fixed 16 ms scheduler. Forced requests
 * retain Pi's public requestRender(true) reset/immediate semantics. Pi also paints
 * focused keyboard input immediately; the protected doRender hook accounts for
 * those frames and cancels any now-redundant local timer.
 */
export class ScheduledTuiAltScreen extends TuiAltScreen {
  private readonly renderIntervalMs: number;
  private running = false;
  private lastFrameStart?: number;
  private queuedFrame?: { cancel: () => void };
  private contentRequested = false;
  private renderingStatusOnly = false;

  /** True only inside a frame requested exclusively by known editor/status animation. */
  get statusOnlyFrame(): boolean { return this.renderingStatusOnly; }

  constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string,
    options: ScheduledTuiOptions = {}, private readonly clock: RenderClock = systemClock) {
    super(terminal, showHardwareCursor, logDirectory, options);
    const interval = options.renderIntervalMs ?? 8;
    if (!Number.isFinite(interval) || interval < 0) throw new RangeError('renderIntervalMs must be finite and non-negative');
    this.renderIntervalMs = interval;
  }

  override start(): void {
    this.cancelQueuedFrame();
    this.lastFrameStart = undefined;
    this.contentRequested = false;
    this.running = true;
    super.start();
  }

  override stop(options?: TuiStopOptions): void {
    this.running = false;
    this.contentRequested = false;
    this.cancelQueuedFrame();
    super.stop(options);
    // Public renderNow clears Pi's queued immediate request. The renderer is
    // stopped, so this cannot write. It also prevents that old nextTick callback
    // from painting after a synchronous stop/start cycle.
    super.renderNow();
  }

  override requestRender(force = false): void { this.queueRender(force, false); }

  /** An ordinary render request in the same batch always overrides this narrower scope. */
  requestStatusRender(force = false): void { this.queueRender(force, true); }

  private queueRender(force: boolean, statusOnly: boolean): void {
    if (!this.running) return;
    if (!statusOnly || force) this.contentRequested = true;
    if (force) {
      this.cancelQueuedFrame();
      super.requestRender(true);
      return;
    }
    if (this.queuedFrame) return;
    const remaining = () => this.lastFrameStart === undefined ? 0
      : Math.max(0, this.renderIntervalMs - (this.clock.now() - this.lastFrameStart));
    const frame = { cancel: () => {} };
    this.queuedFrame = frame;
    const render = () => {
      if (!this.running || this.queuedFrame !== frame) return;
      const delay = remaining();
      if (delay > 0) {
        // Timers can wake early, and Node truncates fractional delays. Do not
        // start a normal frame before the deadline even on those clocks.
        frame.cancel = this.clock.schedule(render, Math.ceil(delay));
        return;
      }
      this.renderFrame(false, !this.contentRequested);
    };
    frame.cancel = this.clock.schedule(render, Math.ceil(remaining()));
  }

  override renderNow(force = false): void { this.renderFrame(force, false); }

  private renderFrame(force: boolean, statusOnly: boolean): void {
    this.cancelQueuedFrame();
    const previous = this.renderingStatusOnly;
    this.renderingStatusOnly = statusOnly && !force && !this.contentRequested;
    try { super.renderNow(force); }
    finally { this.renderingStatusOnly = previous; }
  }

  protected override doRender(): void {
    if (!this.running) return;
    this.cancelQueuedFrame();
    this.contentRequested = false;
    this.lastFrameStart = this.clock.now();
    super.doRender();
  }

  private cancelQueuedFrame(): void {
    const frame = this.queuedFrame;
    this.queuedFrame = undefined;
    frame?.cancel();
  }
}
