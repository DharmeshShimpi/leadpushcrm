import crypto from 'node:crypto';

export function getAppSecret(): string | undefined {
  return process.env.APP_SECRET_PATH;
}

export function validateSecret(secretParam: string): boolean {
  const configuredSecret = getAppSecret();
  if (!configuredSecret || !secretParam) {
    return false;
  }
  // Timing-safe comparison — prevents brute-force timing oracle attacks
  // If lengths differ we still compare equal-length padded buffers so timing is constant
  const a = Buffer.from(secretParam.padEnd(128, '\0'));
  const b = Buffer.from(configuredSecret.padEnd(128, '\0'));
  return crypto.timingSafeEqual(a, b) && secretParam.length === configuredSecret.length;
}
