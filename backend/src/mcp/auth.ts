import { Request } from 'express';

export interface Credentials {
  username: string;
  password: string;
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Pull DB Manager username + password from request headers. Accepted styles:
 *   • X-Username / X-Password headers (preferred — same shape as control-center's X-Email/X-Password)
 *   • Authorization: Basic base64(username:password)
 */
export function extractCredentials(req: Request): Credentials {
  const username = req.header('x-username');
  const password = req.header('x-password');
  if (username && password) {
    return { username: username.trim(), password };
  }

  const auth = req.header('authorization');
  const match = auth ? /^Basic\s+(.+)$/i.exec(auth) : null;
  if (match) {
    const decoded = Buffer.from(match[1].trim(), 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx > 0) {
      return { username: decoded.slice(0, idx).trim(), password: decoded.slice(idx + 1) };
    }
  }

  throw new AuthError(
    401,
    'Missing credentials. Supply X-Username + X-Password headers or Authorization: Basic <base64(username:password)>.'
  );
}
