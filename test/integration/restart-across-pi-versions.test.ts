/**
 * restart-daemon from a client that is built for another Pi version than the daemon, with
 * real daemon processes and the real local connection. A Pi upgrade depends on this: the
 * checkout for the new Pi deploys its release, then restarts the daemon of the old release.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { connectLocal } from '../../src/cli/connections.js';
import { restartDaemon } from '../../src/client/restart-daemon.js';
import { PI_VERSION, PROTOCOL_VERSION, type SlotInfo } from '../../src/protocol/types.js';

const fixturePi = fileURLToPath(new URL('../fixtures/fixture-pi.mjs', import.meta.url));
const OTHER_PI = '9.9.9';

test('restart-daemon restarts a daemon built for another Pi version and reopens its slots', { timeout: 60_000 }, async t => {
  const root = await realpath(await mkdtemp('/tmp/pi-restart-'));
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { mode: 0o700 });
  const pi = join(root, 'pi');
  await writeFile(pi, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePi)} "$@"\n`, { mode: 0o700 });
  // The daemon is a detached process that inherits this environment. Each test file has its own process.
  Object.assign(process.env, { PI_REMOTE_PI_BIN: pi, PI_CODING_AGENT_DIR: join(root, 'agent') });
  t.after(async () => {
    try {
      const pid = Number(await readFile(join(stateDir, 'daemon.lock/pid'), 'utf8'));
      try { process.kill(pid, 'SIGTERM'); }
      catch (error: any) { if (error.code !== 'ESRCH') throw error; }
      for (let i = 0; i < 100 && existsSync(join(stateDir, 'daemon.lock')); i++) await delay(50);
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const running = async (id: string) => {
    const connection = await connectLocal(stateDir);
    try {
      for (let n = 0; n < 200; n++) {
        const found = (await connection.request('list')).find(slot => slot.id === id);
        if (found?.status === 'running') return found;
        await delay(50);
      }
      throw new Error('The slot did not start');
    } finally { connection.close(); }
  };

  const first = await connectLocal(stateDir);
  const created: SlotInfo = await first.request('create', { cwd: root });
  first.close();
  const slot = await running(created.id);

  // The text that restart-daemon reads the daemon's Pi version from. Released daemons send it.
  await assert.rejects(connectLocal(stateDir, OTHER_PI), { message: `Version mismatch: daemon protocol ${PROTOCOL_VERSION}, Pi ${PI_VERSION}` });

  const lines: string[] = [];
  const result = await restartDaemon(piVersion => connectLocal(stateDir, piVersion), { piVersion: OTHER_PI, pollMs: 50, log: line => lines.push(line) });
  assert.notEqual(result.after.pid, result.before.pid);
  assert.equal(result.after.piVersion, PI_VERSION);
  assert.equal(lines[0], `Daemon ${result.before.pid} is built for Pi ${PI_VERSION}, and this client for Pi ${OTHER_PI}.`);
  assert.deepEqual(result.reopened.map(reopened => reopened.id), [created.id]);
  const reopened = await running(created.id);
  assert.equal(reopened.number, slot.number);
  assert.notEqual(reopened.pid, slot.pid, 'the new daemon started a new Pi process for the slot');
});
