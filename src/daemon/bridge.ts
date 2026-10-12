import { defaultStateDir } from '../protocol/paths.js';
import { ensureDaemon } from './launch.js';

export async function bridge(stateDir = defaultStateDir()): Promise<void> {
  const socket = await ensureDaemon(stateDir);
  const socketError = (error: Error) => { console.error(error.message); process.exitCode = 1; socket.destroy(); };
  const stdinEnd = () => socket.end();
  const stdioError = () => socket.destroy();
  socket.on('error', socketError);
  process.stdin.once('end', stdinEnd);
  process.stdin.on('error', stdioError);
  process.stdout.on('error', stdioError);
  try {
    // Backpressure applies only to this client's bridge, never Pi stdout.
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    await new Promise<void>(resolve => socket.once('close', resolve));
  } finally {
    process.stdin.unpipe(socket);
    socket.unpipe(process.stdout);
    process.stdin.pause();
    process.stdin.off('end', stdinEnd);
    process.stdin.off('error', stdioError);
    process.stdout.off('error', stdioError);
    socket.off('error', socketError);
    socket.destroy();
  }
}
