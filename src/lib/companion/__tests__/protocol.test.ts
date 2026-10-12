import { describe, expect, it } from 'vitest';
import { createProfileIdentity, hex, pairingProfile, signCommand, type Command } from '../protocol';

const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';

describe('Companion profile protocol', () => {
  it('gives profiles different non-exportable signing keys even with the same extension ID', async () => {
    const first = await createProfileIdentity(origin);
    const second = await createProfileIdentity(origin);
    expect(first.id).not.toBe(second.id);
    expect(first.publicKey).not.toBe(second.publicKey);
    expect(first.privateKey.extractable).toBe(false);
    expect(pairingProfile(first)).toEqual({ id: first.id, origin, public_key: first.publicKey });
    expect(Object.keys(pairingProfile(first))).not.toContain('privateKey');
  });

  it('signs exact UTF-8 payload bytes in the raw P-256 format used by Rust', async () => {
    const identity = await createProfileIdentity(origin);
    const command: Command = {
      version: 1, challenge: 'a'.repeat(64), profile_id: identity.id,
      generation: 'b'.repeat(64), sequence: 1, expected_revision: 0,
      operation: { type: 'invalidate', reason: 'logout' },
    };
    const message = await signCommand(identity, command);
    expect(JSON.parse(message.payload)).toEqual(command);
    expect(message.signature).toHaveLength(128);
    const decode = (value: string) => Uint8Array.from(value.match(/../g)!, (byte) => Number.parseInt(byte, 16));
    const publicKey = await crypto.subtle.importKey('raw', decode(identity.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, decode(message.signature), new TextEncoder().encode(message.payload))).toBe(true);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, decode(message.signature), new TextEncoder().encode(message.payload.replace('logout', 'account_changed')))).toBe(false);
  });

  it('rejects invalid origins and cross-profile commands before signing', async () => {
    await expect(createProfileIdentity('https://localhost/')).rejects.toThrow('origin');
    const identity = await createProfileIdentity(origin);
    await expect(signCommand(identity, {
      version: 1, challenge: 'a'.repeat(64), profile_id: 'other-profile', generation: 'b'.repeat(64),
      sequence: 1, expected_revision: 0, operation: { type: 'snapshot' },
    })).rejects.toThrow('Invalid command');
    expect(hex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });
});
