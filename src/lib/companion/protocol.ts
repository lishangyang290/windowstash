// Credential protocol remains experimental. Product status transport lives in connection.ts.
export const NATIVE_HOST = 'app.windowstash.companion';
export const PROTOCOL_VERSION = 1;

export interface ProfileIdentity {
  id: string;
  origin: string;
  publicKey: string;
  privateKey: CryptoKey;
}

export type Operation =
  | { type: 'snapshot' }
  | { type: 'invalidate'; reason: 'logout' | 'account_changed' | 'project_changed' }
  | { type: 'unpair' };

export interface Command {
  version: 1;
  challenge: string;
  profile_id: string;
  generation: string;
  sequence: number;
  expected_revision: number;
  operation: Operation;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createProfileIdentity(origin: string): Promise<ProfileIdentity> {
  if (!/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)) throw new Error('Invalid extension origin');
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  return {
    id: hex(crypto.getRandomValues(new Uint8Array(32))),
    origin,
    publicKey: hex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))),
    privateKey: keys.privateKey,
  };
}

export async function signCommand(identity: ProfileIdentity, command: Command) {
  if (command.profile_id !== identity.id || command.version !== PROTOCOL_VERSION
    || !/^[a-f0-9]{64}$/.test(command.challenge) || !/^[a-f0-9]{64}$/.test(command.generation)
    || !Number.isSafeInteger(command.sequence) || command.sequence < 1
    || !Number.isSafeInteger(command.expected_revision) || command.expected_revision < 0) {
    throw new Error('Invalid command');
  }
  const payload = JSON.stringify(command);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, new TextEncoder().encode(payload));
  return { payload, signature: hex(new Uint8Array(signature)) };
}

export function pairingProfile(identity: ProfileIdentity) {
  return { id: identity.id, origin: identity.origin, public_key: identity.publicKey };
}
