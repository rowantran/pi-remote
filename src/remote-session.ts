/**
 * Environment contract that tells Pi code it runs inside a pi-remote session.
 *
 * The daemon sets these variables on each remote Pi RPC process, so remote extensions can
 * detect pi-remote. The local client sets the same variables in its own process before it
 * loads presentation extensions, so a local footer can show the remote host.
 *
 * - PI_REMOTE_SESSION=1: the code runs in a pi-remote session.
 * - PI_REMOTE_SESSION_HOST: display name of the remote host. The remote Pi process gets the
 *   remote hostname; the local client uses the SSH host that it connected to.
 * - PI_REMOTE_SESSION_SLOT: slot UUID. PI_REMOTE_SESSION_SLOT_NUMBER: stable slot number, when known.
 *
 * PI_REMOTE_HOST is a different variable: it selects the default SSH host for the CLI.
 */
export const REMOTE_SESSION_ENV = 'PI_REMOTE_SESSION';
export const REMOTE_SESSION_HOST_ENV = 'PI_REMOTE_SESSION_HOST';
export const REMOTE_SESSION_SLOT_ENV = 'PI_REMOTE_SESSION_SLOT';
export const REMOTE_SESSION_SLOT_NUMBER_ENV = 'PI_REMOTE_SESSION_SLOT_NUMBER';
/** Nerd Fonts nf-cod-remote, the VS Code remote indicator glyph. */
export const REMOTE_ICON = '\uEB3A';

export interface RemoteSessionInfo { host: string; slotId: string; slotNumber?: number }

export function remoteSessionEnv(info: RemoteSessionInfo): Record<string, string> {
  return {
    [REMOTE_SESSION_ENV]: '1',
    [REMOTE_SESSION_HOST_ENV]: info.host,
    [REMOTE_SESSION_SLOT_ENV]: info.slotId,
    [REMOTE_SESSION_SLOT_NUMBER_ENV]: info.slotNumber === undefined ? '' : String(info.slotNumber),
  };
}

/** Text for the user after the local UI closes. Remote work keeps running. */
export function detachMessage(slotId: string, slotNumber?: number): string {
  return `Detached from slot ${slotNumber === undefined ? slotId : `${slotNumber} / ${slotId}`}`;
}
