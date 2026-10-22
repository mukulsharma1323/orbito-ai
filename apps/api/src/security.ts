import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

export function sessionSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  return secret;
}
export function signSession(userId: string) {
  return jwt.sign({ sub: userId }, sessionSecret(), { expiresIn: '7d' });
}
export function verifySession(token: string): string {
  const payload = jwt.verify(token, sessionSecret());
  if (typeof payload === 'string' || !payload.sub) throw new Error('Invalid session');
  return payload.sub;
}
function encryptionKey() {
  const raw = process.env.ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error('ENCRYPTION_KEY must be 64 hex characters');
  return Buffer.from(raw, 'hex');
}
export function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(v => v.toString('base64url')).join('.');
}

export function decryptSecret(value: string) {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted credential');
  const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
