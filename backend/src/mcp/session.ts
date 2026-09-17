import crypto from 'crypto';
import { Credentials } from './auth';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Session cookies cached for the process lifetime, keyed by hash(username, password). */
const cookieCache = new Map<string, string>();
const pendingLogins = new Map<string, Promise<string>>();

/**
 * Calls this backend's own REST API over loopback as the MCP caller. Logging in
 * through /api/auth/login (instead of querying services directly) means every
 * MCP call goes through the exact same role checks, blocked-command lists and
 * Redis write-history audit as the UI.
 */
export class DbManagerSession {
  constructor(private baseUrl: string, private creds: Credentials) {}

  private get cacheKey(): string {
    return crypto
      .createHash('sha256')
      .update(`${this.creds.username}\0${this.creds.password}`)
      .digest('hex');
  }

  private async login(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      // trust proxy is on; this lets express-session issue its `secure` cookie
      // in production even though the loopback hop is plain HTTP.
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ username: this.creds.username, password: this.creds.password }),
    });
    if (!res.ok) {
      throw new ApiError(res.status, `DB Manager login failed: HTTP ${res.status} — ${await res.text()}`);
    }
    // Headers.getSetCookie() only exists on Node >= 19.7; the Docker image runs Node 18,
    // where multiple Set-Cookie values come back comma-joined from get('set-cookie').
    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;=\s]+=)/);
    const sid = setCookies
      .map((c) => c.trim().split(';')[0])
      .find((c) => c.startsWith('connect.sid='));
    if (!sid) {
      throw new ApiError(500, 'DB Manager login succeeded but returned no session cookie');
    }
    return sid;
  }

  private async getCookie(forceRefresh = false): Promise<string> {
    const key = this.cacheKey;
    if (forceRefresh) cookieCache.delete(key);
    const cached = cookieCache.get(key);
    if (cached) return cached;

    let pending = pendingLogins.get(key);
    if (!pending) {
      pending = this.login().finally(() => pendingLogins.delete(key));
      pendingLogins.set(key, pending);
    }
    const cookie = await pending;
    cookieCache.set(key, cookie);
    return cookie;
  }

  /** Verifies the credentials up front so a bad password fails the MCP request with a 401. */
  async ensureLoggedIn(): Promise<void> {
    await this.getCookie();
  }

  async request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res = await this.send(method, path, body, await this.getCookie());
    if (res.status === 401) {
      // Session expired (SESSION_TTL_SECONDS) — re-login once and retry.
      res = await this.send(method, path, body, await this.getCookie(true));
    }
    const text = await res.text();
    if (!res.ok) {
      throw new ApiError(res.status, `HTTP ${res.status} ${method} ${path} — ${text}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  private send(method: string, path: string, body: unknown, cookie: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}
