import logger from '../../utils/logger';
import { AppError } from '../../middleware/error.middleware';
import { SystemConfigTargetJson, SystemConfigTargetKey } from '../../types';

const LOGIN_TIMEOUT_MS = 10000;

interface DashboardLoginResponse {
  authToken?: string;
  is2faMandatory?: boolean;
  is2faEnabled?: boolean;
  message?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Per-target token manager for the Namma Yatri dashboard.
 *
 * The dashboard rate-limits login per email (sliding window), so tokens are
 * cached per target and concurrent refreshes share a single in-flight login
 * promise. On a 401 the caller invalidates the token and re-logs-in once.
 *
 * The token, service-account password, and any credentials must NEVER appear
 * in logs, error messages, or HTTP responses.
 */
class DashboardAuthService {
  private tokens: Map<SystemConfigTargetKey, string> = new Map();
  private inflightLogins: Map<SystemConfigTargetKey, Promise<string>> = new Map();

  public async getToken(targetKey: SystemConfigTargetKey, target: SystemConfigTargetJson): Promise<string> {
    const cached = this.tokens.get(targetKey);
    if (cached) return cached;

    // Single-flight: concurrent callers share one login attempt
    let inflight = this.inflightLogins.get(targetKey);
    if (!inflight) {
      inflight = this.login(targetKey, target).finally(() => this.inflightLogins.delete(targetKey));
      this.inflightLogins.set(targetKey, inflight);
    }
    return inflight;
  }

  /**
   * Drop the cached token (call on 401 from the dashboard before retrying)
   */
  public invalidateToken(targetKey: SystemConfigTargetKey): void {
    this.tokens.delete(targetKey);
  }

  private async login(targetKey: SystemConfigTargetKey, target: SystemConfigTargetJson): Promise<string> {
    const url = `${target.dashboardBaseUrl.replace(/\/+$/, '')}/user/login`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: target.email, password: target.password, otp: null }),
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        logger.warn('Dashboard login timed out', { target: targetKey });
        throw new AppError('Dashboard login timed out', 502);
      }
      logger.warn('Dashboard login network error', { target: targetKey, error: error?.message });
      throw new AppError(`Dashboard login failed: ${error?.message || 'network error'}`, 502);
    } finally {
      clearTimeout(timeout);
    }

    let body: DashboardLoginResponse | null = null;
    try {
      body = (await res.json()) as DashboardLoginResponse;
    } catch {
      // Non-JSON body — handled below via status check
    }

    if (!res.ok) {
      const detail =
        (typeof body?.errorMessage === 'string' && body.errorMessage) ||
        (typeof body?.errorCode === 'string' && body.errorCode) ||
        `HTTP ${res.status}`;
      logger.warn('Dashboard login failed', { target: targetKey, status: res.status, detail });
      throw new AppError(`Dashboard login failed: ${detail}`, 502);
    }

    // A 200 with an empty authToken is a FAILURE (2FA required / OTP mismatch)
    const authToken = body?.authToken;
    if (typeof authToken !== 'string' || authToken === '') {
      const detail =
        (typeof body?.message === 'string' && body.message) || '2FA/OTP required or credentials rejected';
      logger.warn('Dashboard login returned no token', { target: targetKey, detail });
      throw new AppError(`Dashboard login rejected: ${detail}`, 502);
    }

    this.tokens.set(targetKey, authToken);
    logger.info('Dashboard login successful', { target: targetKey });
    return authToken;
  }
}

export default new DashboardAuthService();
