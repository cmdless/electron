import { ErrorCodes, RequestType0, ResponseError } from 'vscode-jsonrpc';
import type { MessageConnection } from 'vscode-jsonrpc';

// what a protocol says it is: a name, and a version that only goes up when
// a change breaks clients - adding requests, notifications, channels or
// optional fields doesn't need one
export type ProtocolIdentity = { name: string; version: number };

// reserved under $/, like the state channels, so it never collides with a
// protocol's own methods
const versionType = new RequestType0<ProtocolIdentity, unknown>('$/version');

export class ProtocolMismatch extends Error { }

export function serveVersion(connection: MessageConnection, identity: ProtocolIdentity) {
  connection.onRequest(versionType, () => identity);
}

// asks the other side what it speaks, and fails loudly when it isn't this
export async function checkVersion(connection: MessageConnection, identity: ProtocolIdentity) {
  let theirs: ProtocolIdentity;
  try {
    theirs = await connection.sendRequest(versionType);
  } catch (error) {
    if (error instanceof ResponseError && error.code === ErrorCodes.MethodNotFound)
      throw new ProtocolMismatch(`${identity.name} doesn't say which protocol it speaks, so it's older than this client (protocol ${identity.version}) - update it`);
    throw error;
  }
  if (theirs.name !== identity.name)
    throw new ProtocolMismatch(`expected ${identity.name}, but this is ${theirs.name}`);
  if (theirs.version !== identity.version)
    throw new ProtocolMismatch(`${identity.name} speaks protocol ${theirs.version}, but this client speaks ${identity.version} - update whichever is older`);
}
