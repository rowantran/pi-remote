import type { CompatibleConnection } from '../../src/client/compat-client.js';
import type { Connection } from '../../src/client/connection.js';
import type { ReconnectingConnection } from '../../src/client/reconnect.js';
import type { Attachment, FilesystemMetadata, PathCompletionResult } from '../../src/protocol/files.js';
import type { HelloResult, MethodResult, RestartDaemonResult, SessionInfo } from '../../src/protocol/methods.js';
import type { RemoteConnection, SlotInfo, Snapshot } from '../../src/protocol/types.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

declare const connection: RemoteConnection;
declare const transport: Connection;
declare const compatible: CompatibleConnection;
declare const reconnecting: ReconnectingConnection;

// Methods with no required fields may omit params. Results are inferred, not chosen by callers.
const slots = connection.request('list');
const created = connection.request('create');
const hello = connection.request('hello', { protocol: 1, piVersion: '1.0.4' });
const attached = connection.request('attach', { slotId: 'slot' });
const snapshot = connection.request('snapshot', { slotId: 'slot', historyCursor: { sessionId: 'session', entryId: 'entry' } });
const sessions = connection.request('sessions', { slotId: 'slot', side: true });
const restartedDaemon = connection.request('restart_daemon');
const restarted = connection.request('restart', { slotId: 'slot', force: true });
const rpc = connection.request('rpc', { slotId: 'slot', command: { type: 'arbitrary_pi_command', extra: [1, 2] } });
const answered = connection.request('answer', { slotId: 'slot', response: { id: 'dialog', cancelled: true } });
const killed = connection.request('kill', { slotId: 'slot' });
const paths = connection.request('complete_path', { prefix: '', cwd: '/tmp', directoriesOnly: true });
const attachment = connection.request('read_attachment', { slotId: 'slot', path: 'file.txt' });
const metadata = connection.request('filesystem_metadata');
connection.request('list', {});
connection.request('create', { cwd: '/tmp', args: ['--model', 'model'], parentSlotId: 'parent' });
connection.request('filesystem_metadata', { slotId: 'slot' });

type InferredResults = [
  Assert<Equal<typeof slots, Promise<SlotInfo[]>>>,
  Assert<Equal<typeof created, Promise<SlotInfo>>>,
  Assert<Equal<typeof hello, Promise<HelloResult>>>,
  Assert<Equal<typeof attached, Promise<Snapshot>>>,
  Assert<Equal<typeof snapshot, Promise<Snapshot>>>,
  Assert<Equal<typeof sessions, Promise<SessionInfo[]>>>,
  Assert<Equal<typeof restartedDaemon, Promise<RestartDaemonResult>>>,
  Assert<Equal<typeof restarted, Promise<SlotInfo>>>,
  Assert<Equal<typeof rpc, Promise<unknown>>>,
  Assert<Equal<typeof answered, Promise<MethodResult<'answer'>>>>,
  Assert<Equal<typeof killed, Promise<MethodResult<'kill'>>>>,
  Assert<Equal<typeof paths, Promise<PathCompletionResult>>>,
  Assert<Equal<typeof attachment, Promise<Attachment>>>,
  Assert<Equal<typeof metadata, Promise<FilesystemMetadata>>>,
];

// @ts-expect-error Unknown daemon methods cannot use the public request API.
connection.request('not_a_daemon_method');
declare const arbitraryMethod: string;
// @ts-expect-error No unrestricted string overload is exposed.
connection.request(arbitraryMethod, {});
// @ts-expect-error Callers cannot select an unrelated result type.
connection.request<Snapshot>('list');
// @ts-expect-error hello requires params.
connection.request('hello');
// @ts-expect-error hello requires piVersion.
connection.request('hello', { protocol: 1 });
// @ts-expect-error attach requires params.
connection.request('attach');
// @ts-expect-error attach requires slotId.
connection.request('attach', {});
// @ts-expect-error slotId is a string.
connection.request('attach', { slotId: 1 });
// @ts-expect-error snapshot requires slotId.
connection.request('snapshot', { historyCursor: { sessionId: 'session', entryId: 'entry' } });
// @ts-expect-error historyCursor requires entryId.
connection.request('snapshot', { slotId: 'slot', historyCursor: { sessionId: 'session' } });
// @ts-expect-error sessions requires params.
connection.request('sessions');
// @ts-expect-error side is boolean.
connection.request('sessions', { slotId: 'slot', side: 'yes' });
// @ts-expect-error force is boolean.
connection.request('restart_daemon', { force: 'yes' });
// @ts-expect-error restart requires params.
connection.request('restart');
// @ts-expect-error rpc requires command.
connection.request('rpc', { slotId: 'slot' });
// @ts-expect-error Pi command is an inner record, not a string.
connection.request('rpc', { slotId: 'slot', command: 'prompt' });
// @ts-expect-error answer requires a dialog ID.
connection.request('answer', { slotId: 'slot', response: { value: 'answer' } });
// @ts-expect-error kill requires params.
connection.request('kill');
// @ts-expect-error complete_path requires params.
connection.request('complete_path');
// @ts-expect-error complete_path requires prefix even when a slot is supplied.
connection.request('complete_path', { slotId: 'slot' });
// @ts-expect-error directoriesOnly is boolean.
connection.request('complete_path', { prefix: '', directoriesOnly: 'yes' });
// @ts-expect-error read_attachment requires params.
connection.request('read_attachment');
// @ts-expect-error read_attachment requires path.
connection.request('read_attachment', { cwd: '/tmp' });
// @ts-expect-error cwd is a string.
connection.request('filesystem_metadata', { cwd: false });
// @ts-expect-error list accepts no arbitrary params.
connection.request('list', { slotId: 'slot' });
// @ts-expect-error inferred list results are not snapshots.
const wrongResult: Promise<Snapshot> = connection.request('list');
// @ts-expect-error Dynamic Pi results must be narrowed in the small Pi RPC helper.
rpc.then(result => result.cancelled);

// Concrete transports and wrappers must expose the same restrictions as the interface.
transport.request('list');
compatible.request('complete_path', { prefix: '' });
reconnecting.request('attach', { slotId: 'slot' });
// @ts-expect-error The transport cannot bypass required params.
transport.request('attach');
// @ts-expect-error The compatibility wrapper cannot accept unknown methods.
compatible.request('unknown');
// @ts-expect-error The reconnect wrapper cannot bypass required params.
reconnecting.request('read_attachment');

export type { InferredResults };
