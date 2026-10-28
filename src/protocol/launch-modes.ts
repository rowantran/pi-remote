import { PI_VERSION, PROTOCOL_VERSION, type CreateOptions, type RemoteConnection, type SlotInfo } from './types.js';

/** The daemon accepts `sandboxed` in create and reports it in SlotInfo. */
export const LAUNCH_MODES_CAPABILITY = 'launch_modes';

/** Create a top-level slot in the requested launch mode.
 * Older daemons ignore the `sandboxed` field and always start unsandboxed Pi. A sandboxed
 * request therefore checks the capability first and fails before anything is created. */
export async function createSlot(connection: Pick<RemoteConnection, 'request'>, options: CreateOptions & { sandboxed: boolean }): Promise<SlotInfo> {
  if (options.sandboxed) {
    const hello = await connection.request('hello', { protocol: PROTOCOL_VERSION, piVersion: PI_VERSION });
    if (!hello.capabilities?.includes(LAUNCH_MODES_CAPABILITY)) {
      throw new Error('The remote daemon cannot start sandboxed Pi. Deploy the updated daemon, or start the session unsandboxed. Nothing was started.');
    }
  }
  return connection.request('create', options);
}
