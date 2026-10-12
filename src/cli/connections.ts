import { Connection, handshake } from '../client/connection.js';
import { CompatibleConnection } from '../client/compat-client.js';
import { ensureDaemon } from '../daemon/launch.js';
import { serveFileRequest } from '../daemon/files.js';
import { defaultStateDir } from '../protocol/paths.js';
import type { RemoteConnection } from '../protocol/types.js';

// Composition belongs here: the client layer does not own daemon startup.
export async function connectLocal(stateDir = defaultStateDir()): Promise<Connection> {
  const socket = await ensureDaemon(stateDir);
  const connection = new Connection(socket, socket, () => socket.destroy());
  try { await handshake(connection); return connection; }
  catch (error) { connection.close(); throw error; }
}

export async function connectCompatibleLocal(stateDir?: string): Promise<RemoteConnection> {
  return new CompatibleConnection(await connectLocal(stateDir), serveFileRequest);
}
