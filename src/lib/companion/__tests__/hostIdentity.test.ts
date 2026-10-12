import { describe, expect, it } from 'vitest';
import { createProfileIdentity, hex } from '../protocol';
import { hostProofPayload, verifyHostProof } from '../hostIdentity';

const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/';
const profile = 'a'.repeat(64);
const challenge = 'b'.repeat(64);

async function proof(identity: Awaited<ReturnType<typeof createProfileIdentity>>, channelKey = identity.publicKey) {
  const payload = new TextEncoder().encode(hostProofPayload(profile, challenge, channelKey));
  return { channelKey, signature: hex(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, payload))) };
}

describe('Host identity trust boundary', () => {
  it('rejects malformed wire proofs without trusting them or throwing', async () => {
    const genuine = await createProfileIdentity(origin);
    for (const candidate of [null, false, {}, { channelKey: genuine.publicKey, signature: 1 }]) {
      expect(await verifyHostProof(genuine.publicKey, profile, challenge, candidate)).toBe(false);
    }
  });

  it('rejects a self-consistent first-contact proof without an independent trust root', async () => {
    const attacker = await createProfileIdentity(origin);
    const candidate = await proof(attacker);
    // The attack succeeds if the first key is trusted blindly. This positive
    // control proves that valid crypto and the right origin are not identity.
    expect(await verifyHostProof(attacker.publicKey, profile, challenge, candidate)).toBe(true);
    expect(await verifyHostProof(null, profile, challenge, candidate)).toBe(false);
  });

  it('rejects a substitute host with the same extension origin', async () => {
    const genuine = await createProfileIdentity(origin);
    const attacker = await createProfileIdentity(origin);
    expect(await verifyHostProof(genuine.publicKey, profile, challenge, await proof(attacker))).toBe(false);
  });

  it('binds the profile, challenge and encryption channel key', async () => {
    const genuine = await createProfileIdentity(origin);
    const candidate = await proof(genuine);
    expect(await verifyHostProof(genuine.publicKey, profile, challenge, candidate)).toBe(true);
    expect(await verifyHostProof(genuine.publicKey, 'c'.repeat(64), challenge, candidate)).toBe(false);
    expect(await verifyHostProof(genuine.publicKey, profile, 'd'.repeat(64), candidate)).toBe(false);
    const other = await createProfileIdentity(origin);
    expect(await verifyHostProof(genuine.publicKey, profile, challenge, { ...candidate, channelKey: other.publicKey })).toBe(false);
  });
});
