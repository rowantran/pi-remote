interface PushStatus { publicKey: string; subscribed: boolean; monitor: string; warning?: string }
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const binary = atob(key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '='));
  return Uint8Array.from(binary, value => value.charCodeAt(0));
}

/** Subscription setup is a user gesture, never an attempt to keep iOS awake. Apple's
 * push service wakes the service worker even when this page and Tailscale are suspended. */
export class Notifications {
  private registration?: ServiceWorkerRegistration;
  private workerReady = false;
  private state?: PushStatus;
  private pending = false;
  private message = document.getElementById('notification-status')!;
  private enable = document.getElementById('enable-notifications') as HTMLButtonElement;
  private disable = document.getElementById('disable-notifications') as HTMLButtonElement;
  private test = document.getElementById('test-notification') as HTMLButtonElement;
  constructor(private api: <T>(path: string, body?: unknown) => Promise<T>, private currentSlot: () => string | undefined, private report: (error: unknown) => void) {
    this.enable.addEventListener('click', () => { void this.subscribe().catch(this.report); });
    this.disable.addEventListener('click', () => { void this.unsubscribe().catch(this.report); });
    this.test.addEventListener('click', () => {
      const slotId = this.currentSlot(); if (!slotId) return;
      this.pending = true; this.update();
      void this.api('/api/push/test', { slotId }).then(() => { this.message.textContent = 'Test push accepted. Check your notification settings if it does not appear.'; })
        .catch(this.report).finally(() => { this.pending = false; this.update(false); });
    });
    this.update();
  }
  async initialize(): Promise<void> {
    if (!('serviceWorker' in navigator)) { this.message.textContent = 'This browser does not support Home Screen apps.'; return; }
    this.registration ??= await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready; this.workerReady = true;
    await this.refresh();
  }
  async refresh(): Promise<void> { this.state = await this.api<PushStatus>('/api/push'); this.update(); }
  private supported(): boolean {
    const appleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const installed = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    return (!appleMobile || installed) && 'PushManager' in window && 'Notification' in window;
  }
  private update(text = true): void {
    this.enable.disabled = this.pending || !this.workerReady || !this.registration || !this.state || !this.supported();
    this.disable.disabled = this.pending || !this.state?.subscribed;
    this.test.disabled = this.pending || !this.state?.subscribed || !this.currentSlot();
    if (!text) return;
    this.message.textContent = !this.supported() ? 'On iPhone, add this app to the Home Screen and open it there to enable notifications.'
      : !this.state ? 'Loading notification settings…'
      : !this.state.subscribed ? 'Notifications are off. No Apple Developer account is needed.'
      : this.state.monitor === 'unsupported' ? 'Notifications are registered. Update/restart the devbox daemon to enable session bells.'
      : this.state.monitor !== 'active' ? 'Notifications are registered. The devbox activity monitor is reconnecting.'
      : this.state.warning ?? 'Notifications are on for completions and new questions in your open tabs, including when this app is closed.';
  }
  private async subscribe(): Promise<void> {
    if (!this.registration || !this.state || this.pending || !this.supported()) return;
    this.pending = true; this.update(false);
    try {
      // This call must directly follow the user's tap; do not fetch keys/worker code first.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notifications were not enabled. You can change permission in iOS notification settings.');
      const applicationServerKey = keyBytes(this.state.publicKey);
      let subscription = await this.registration.pushManager.getSubscription();
      if (subscription && !this.state.subscribed) { await subscription.unsubscribe(); subscription = null; }
      if (subscription?.options.applicationServerKey) {
        const previous = new Uint8Array(subscription.options.applicationServerKey);
        if (previous.length !== applicationServerKey.length || previous.some((byte, index) => byte !== applicationServerKey[index])) {
          await subscription.unsubscribe(); subscription = null;
        }
      }
      subscription ??= await this.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      await this.api('/api/push/subscribe', { subscription: subscription.toJSON() });
      await this.refresh();
    } finally { this.pending = false; this.update(); }
  }
  private async unsubscribe(): Promise<void> {
    if (this.pending) return;
    this.pending = true; this.update(false);
    try {
      const subscription = await this.registration?.pushManager.getSubscription();
      await subscription?.unsubscribe();
      await this.api('/api/push/unsubscribe', {}); await this.refresh();
    } finally { this.pending = false; this.update(); }
  }
}
