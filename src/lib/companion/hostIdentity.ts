// Transport proofs are meaningful only AFTER a host key has been authenticated
// independently. The proof must bind the encryption channel key, not just a nonce.
export interface HostProof {
  channelKey: string;
  signature: string;
}

const keyPattern = /^04[a-f0-9]{128}$/;
const noncePattern = /^[a-f0-9]{64}$/;
const decode = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (byte) => parseInt(byte, 16));

export function hostProofPayload(profileId: string, challenge: string, channelKey: string) {
  return `windowstash-host-v1\n${profileId}\n${challenge}\n${channelKey}`;
}

export async function verifyHostProof(trustedHostKey: string | null, profileId: string, challenge: string, proof: unknown): Promise<boolean> {
  if (!proof || typeof proof !== 'object') return false;
  const { channelKey, signature } = proof as Partial<HostProof>;
  // Never enroll the first key supplied by a Native Host or writable manifest.
  if (!trustedHostKey || !keyPattern.test(trustedHostKey) || !noncePattern.test(profileId)
    || !noncePattern.test(challenge) || typeof channelKey !== 'string' || !keyPattern.test(channelKey)
    || typeof signature !== 'string' || !/^[a-f0-9]{128}$/.test(signature)) return false;
  try {
    const key = await crypto.subtle.importKey('raw', decode(trustedHostKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decode(signature),
      new TextEncoder().encode(hostProofPayload(profileId, challenge, channelKey)));
  } catch {
    return false;
  }
}
