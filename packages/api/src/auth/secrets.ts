import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for `provider_credentials`.
 *
 * AES-256-GCM, with the IV and the auth tag stored in their own columns exactly as
 * the schema declares them. GCM rather than CBC because the tag makes tampering a
 * decryption failure instead of a plausible-looking secret, and a webhook verified
 * against a silently-corrupted secret rejects every callback with a 401 that looks
 * like an attack.
 *
 * The IV is random per encryption and never reused. Reusing a nonce under the same
 * key in GCM is not a degradation, it is a break: two ciphertexts under one nonce
 * leak their XOR and hand over the authentication key.
 */

export type SealedSecret = {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
};

const IV_BYTES = 12; // The size GCM is specified for; other lengths are slower and weaker.

export function sealSecret(plaintext: string, key: Buffer): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

/**
 * Returns `undefined` rather than throwing when the tag does not verify.
 *
 * The caller is the webhook endpoint, which iterates every active credential for a
 * provider and tries each one. A throw on the second of five credentials would
 * abandon the loop and reject a payload that the fourth credential would have
 * accepted — which is invariant I11 failing in a new and more confusing way.
 */
export function openSecret(sealed: SealedSecret, key: Buffer): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
