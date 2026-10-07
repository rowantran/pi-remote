import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readJsonl, writeJsonl } from './jsonl.js';
import { errorText, type RecordValue } from './protocol.js';

interface Pending { resolve: (response: RecordValue) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }
export interface PiLaunch { executable: string; prefixArgs?: string[]; cwd: string; args: string[]; env?: NodeJS.ProcessEnv }

/** Owns ONLY the public stdio RPC interface. No AgentSession, extensions, or harness internals. */
export class PiProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private stderrTail = '';
  private failure?: Error;
  private closing = false;
  private exited: Promise<void>;
  private resolveExit!: () => void;

  constructor(launch: PiLaunch, onEvent: (event: RecordValue) => void, onExit: (error: Error) => void) {
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    this.child = spawn(launch.executable, [...(launch.prefixArgs ?? []), '--mode', 'rpc', ...launch.args], {
      cwd: launch.cwd, env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const fail = (error: Error) => {
      if (this.failure) return;
      this.failure = error;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      onExit(error);
    };
    this.child.stderr.on('data', chunk => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-16_384);
      process.stderr.write(`[pi ${this.child.pid ?? 'starting'}] ${chunk}`);
    });
    this.child.once('error', error => { fail(error); this.resolveExit(); });
    this.child.once('close', (code, signal) => {
      // After an explicit stop, startup warnings in stderr are noise, not a cause.
      fail(new Error(this.closing ? `Stopped by request (code=${code}, signal=${signal}).` : `Pi exited (code=${code}, signal=${signal}). ${this.stderrTail}`));
      this.resolveExit();
    });
    this.child.stdin.on('error', fail);
    const displayWarning = (error: Error) => {
      console.error(`Pi ${this.child.pid} RPC display error (agent left running): ${error.message}`);
      try { onEvent({ type: 'remote_warning', error: error.message }); }
      catch (listenerError) { console.error('Display warning handler failed:', listenerError); }
    };
    readJsonl(this.child.stdout, record => {
      if (record.type === 'response' && typeof record.id === 'string') {
        const pending = this.pending.get(record.id);
        if (!pending) return;
        this.pending.delete(record.id);
        clearTimeout(pending.timer);
        pending.resolve(record);
      } else onEvent(record);
    }, error => {
      // We cannot identify the dropped record's request safely. Fail local waiters with an
      // uncertain-outcome error, keep draining, and never stop or retry remote work.
      const warning = new Error(`Pi RPC output could not be displayed: ${error.message}. Remote work was not cancelled; command outcomes may be unknown.`);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(warning); }
      this.pending.clear();
      displayWarning(warning);
    }, { recover: true, onHandlerError: displayWarning });
  }

  /** A deadline rejects only the local query, never kills Pi or cancels accepted work. */
  command<T = RecordValue>(command: RecordValue, timeoutMs?: number, atResponse?: (data: any) => T): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing) return Promise.reject(new Error('Pi is shutting down'));
    if (this.pending.size >= 256) return Promise.reject(new Error('Too many pending Pi commands'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Pi ${command.type}; remote work was not cancelled`));
      }, timeoutMs) : undefined;
      this.pending.set(id, {
        timer, reject,
        resolve: response => {
          if (!response.success) reject(new Error(response.error ?? 'Pi RPC command failed'));
          else {
            try { resolve(atResponse ? atResponse(response.data) : response.data); }
            catch (error) { reject(new Error(errorText(error))); }
          }
        },
      });
      try { writeJsonl(this.child.stdin, { ...command, id }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  answer(response: RecordValue): void {
    if (this.failure || this.closing) throw this.failure ?? new Error('Pi is shutting down');
    writeJsonl(this.child.stdin, { ...response, type: 'extension_ui_response' });
  }

  async stop(): Promise<void> {
    if (this.closing) return this.exited;
    this.closing = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    // End-of-input is Pi's documented orderly shutdown. Explicit kill is the only place we do this.
    this.child.stdin.end();
    const term = setTimeout(() => this.child.kill('SIGTERM'), 3000);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 8000);
    try { await this.exited; }
    finally { clearTimeout(term); clearTimeout(kill); }
  }
}
