import crypto from 'crypto';
import logger from '../../utils/logger';

/**
 * Client for the loc auth service (../loc — the gateway all user traffic can
 * flow through). Used when a request arrives with a valid `x-loc-auth` header:
 * loc has already authenticated the user and injected identity headers, and we
 * resolve the user's role to its functionality list via loc's S2S APIs:
 *
 *   GET /get/{service}/roles                          (X-Service-Token auth)
 *   GET /get/{service}/roles/{roleId}/functionality   (X-Service-Token auth)
 *
 * Responses are cached in-memory for ROLE_CACHE_TTL_MS (1 hour).
 *
 * Env:
 *   LOC_BASE_URL      — loc's own API address, e.g. http://loc.tool.svc.domain.com:8000
 *   LOC_SERVICE_NAME  — the name this service was registered under in loc
 *   LOC_SERVICE_TOKEN — service token returned once by POST /register/service
 *   LOC_AUTH_SECRET   — shared secret loc sends us as `x-loc-auth` on proxied
 *                       requests (the locAuthSecret configured at registration)
 */

const ROLE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface LocRole {
  id: number;
  name: string;
  service: string;
  functionalities: string[];
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class LocService {
  private static instance: LocService;

  private readonly baseUrl = (process.env.LOC_BASE_URL || '').replace(/\/+$/, '');
  private readonly serviceName = process.env.LOC_SERVICE_NAME || 'dbmanager';
  private readonly serviceToken = process.env.LOC_SERVICE_TOKEN || '';
  private readonly authSecret = process.env.LOC_AUTH_SECRET || '';

  private rolesCache: CacheEntry<LocRole[]> | null = null;
  private functionalityCache: Map<number, CacheEntry<string[]>> = new Map();

  static getInstance(): LocService {
    if (!LocService.instance) {
      LocService.instance = new LocService();
    }
    return LocService.instance;
  }

  /** loc-header auth is only honored when the shared secret is configured. */
  isConfigured(): boolean {
    return !!this.authSecret;
  }

  canResolveRoles(): boolean {
    return !!(this.baseUrl && this.serviceToken);
  }

  /** Constant-time comparison of the inbound x-loc-auth header. */
  verifyGatewaySecret(presented: string): boolean {
    if (!this.authSecret || !presented) return false;
    const a = crypto.createHash('sha256').update(presented).digest();
    const b = crypto.createHash('sha256').update(this.authSecret).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Functionality list for a role, by role name (loc's gateway injects the
   * role name in X-User-Role). Resolves the name to its id via the cached
   * roles list, then uses /get/{service}/roles/{id}/functionality — both
   * cached in memory for an hour. Returns null if the role is unknown.
   */
  async getFunctionalitiesForRole(roleName: string): Promise<string[] | null> {
    const roles = await this.getRoles();
    const role = roles.find(r => r.name === roleName);
    if (!role) {
      logger.warn('loc role not found for this service', {
        role: roleName,
        service: this.serviceName,
      });
      return null;
    }
    return this.getRoleFunctionalities(role.id);
  }

  /** All roles of this service from GET /get/{service}/roles, cached 1h. */
  private async getRoles(): Promise<LocRole[]> {
    const now = Date.now();
    if (this.rolesCache && this.rolesCache.expiresAt > now) {
      return this.rolesCache.data;
    }
    const roles = await this.fetchJson<LocRole[]>(`/get/${this.serviceName}/roles`);
    this.rolesCache = { data: roles, expiresAt: now + ROLE_CACHE_TTL_MS };
    return roles;
  }

  /** GET /get/{service}/roles/{id}/functionality, cached 1h per role id. */
  private async getRoleFunctionalities(roleId: number): Promise<string[]> {
    const now = Date.now();
    const cached = this.functionalityCache.get(roleId);
    if (cached && cached.expiresAt > now) {
      return cached.data;
    }
    const functionalities = await this.fetchJson<string[]>(
      `/get/${this.serviceName}/roles/${roleId}/functionality`
    );
    this.functionalityCache.set(roleId, {
      data: functionalities,
      expiresAt: now + ROLE_CACHE_TTL_MS,
    });
    return functionalities;
  }

  private async fetchJson<T>(path: string): Promise<T> {
    if (!this.canResolveRoles()) {
      throw new Error(
        'loc role lookup not configured — set LOC_BASE_URL and LOC_SERVICE_TOKEN'
      );
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'X-Service-Token': this.serviceToken },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`loc ${path} responded ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

export default LocService;
