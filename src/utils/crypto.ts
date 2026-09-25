import crypto from 'node:crypto';

// Use DATA_ENCRYPTION_KEY from environment, or fallback to a deterministic key in non-production/test environments if needed
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard 12 bytes for AES-GCM

function getEncryptionKey(): Buffer {
  const secretKey = process.env.DATA_ENCRYPTION_KEY;
  if (!secretKey) {
    throw new Error(
      '[FATAL] DATA_ENCRYPTION_KEY environment variable is not set. ' +
      'The server cannot encrypt or decrypt credentials safely. Set this variable before starting.'
    );
  }
  // Hash to 32 bytes (256 bits) to guarantee correct key length for AES-256
  return crypto.createHash('sha256').update(secretKey).digest();
}

/**
 * Encrypts a string (e.g. Google OAuth refresh token) using AES-256-GCM
 * Returns string format: iv_hex:auth_tag_hex:encrypted_hex
 */
export function encryptSecret(text: string): string {
  if (!text) return '';
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts a previously encrypted secret
 */
export function decryptSecret(cipherText: string): string {
  if (!cipherText) return '';
  try {
    const parts = cipherText.split(':');
    if (parts.length !== 3) return '';

    const [ivHex, authTagHex, encryptedHex] = parts;
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption failed:', err instanceof Error ? err.message : err);
    return '';
  }
}
