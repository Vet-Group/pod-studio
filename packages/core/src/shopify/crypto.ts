import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptionKeys {
  readonly activeVersion: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}
const configurationError = () => new Error('Shopify encryption keys are not configured correctly.');
const decryptionError = () => new Error('Unable to decrypt Shopify credential.');

/** Strict, versioned AES-256 keys. No error includes key material or caller input. */
export function parseEncryptionKeys(value = process.env.SHOPIFY_ENCRYPTION_KEYS ?? '', activeVersion = process.env.SHOPIFY_ENCRYPTION_ACTIVE_VERSION ?? 'v1'): EncryptionKeys {
  const keys = new Map<string, Buffer>();
  for (const entry of value.split(',')) {
    const match = /^(v[1-9]\d*):([A-Za-z0-9+/]{43}=)$/.exec(entry.trim());
    if (!match || keys.has(match[1]!)) throw configurationError();
    const key = Buffer.from(match[2]!, 'base64');
    if (key.length !== 32 || key.toString('base64') !== match[2]) throw configurationError();
    keys.set(match[1]!, key);
  }
  if (!keys.has(activeVersion)) throw configurationError();
  return { activeVersion, keys };
}

/** Envelope: version.nonce.ciphertext.tag. AAD binds both version and store/field identity. */
export function encryptSecret(plaintext: string, context: string, keyring: EncryptionKeys = parseEncryptionKeys()): string {
  try {
    const version = keyring.activeVersion;
    const key = keyring.keys.get(version);
    if (!key || key.length !== 32 || !/^v[1-9]\d*$/.test(version)) throw configurationError();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`${version}:${context}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [version, nonce.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  } catch {
    throw new Error('Unable to encrypt Shopify credential.');
  }
}

export function decryptSecret(envelope: string, context: string, keyring: EncryptionKeys = parseEncryptionKeys()): string {
  try {
    if (typeof envelope !== 'string' || envelope.length > 32768) throw decryptionError();
    const parts = envelope.split('.');
    if (parts.length !== 4) throw decryptionError();
    const [version, nonceValue, ciphertextValue, tagValue] = parts as [string, string, string, string];
    const decode = (value: string) => {
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.toString('base64url') !== value) throw decryptionError();
      return bytes;
    };
    const key = keyring.keys.get(version);
    const nonce = decode(nonceValue);
    const tag = decode(tagValue);
    if (!key || nonce.length !== 12 || tag.length !== 16) throw decryptionError();
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(`${version}:${context}`));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(decode(ciphertextValue)), decipher.final()]).toString('utf8');
  } catch {
    throw decryptionError();
  }
}
