import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VALID_ENVS, ALLOWED_PATCH_TRANSFERS, assertValidEnv, assertSafeIdentifiers, getAllowedEnvs } from './configTransfer.service';

/**
 * Pure validation logic only — no subprocess, no Redis, no filesystem.
 * These are the checks that stand between a bad request and either an
 * argv-injection-shaped value or an opaque "process exited 1" from the
 * python script's own sys.exit(). They mirror config_transfer.py's own
 * VALID_ENVS / ALLOWED_TRANSFERS exactly, so a mismatch here means the two
 * sides have drifted.
 */
describe('assertValidEnv', () => {
  it('accepts every declared VALID_ENVS value', () => {
    for (const env of VALID_ENVS) {
      expect(() => assertValidEnv(env)).not.toThrow();
    }
  });

  it('rejects an unknown environment', () => {
    expect(() => assertValidEnv('staging')).toThrow(/Invalid environment/);
  });

  it('rejects an empty string', () => {
    expect(() => assertValidEnv('')).toThrow(/Invalid environment/);
  });

  it('rejects an attempt to smuggle shell metacharacters as an env name', () => {
    expect(() => assertValidEnv('master; rm -rf /')).toThrow(/Invalid environment/);
  });
});

describe('assertSafeIdentifiers', () => {
  it('accepts undefined (optional field)', () => {
    expect(() => assertSafeIdentifiers(undefined, 'schema')).not.toThrow();
  });

  it('accepts an empty array', () => {
    expect(() => assertSafeIdentifiers([], 'schema')).not.toThrow();
  });

  it('accepts plain alphanumeric/underscore identifiers', () => {
    expect(() => assertSafeIdentifiers(['atlas_app', 'merchant_config', 'table1'], 'schema')).not.toThrow();
  });

  it('rejects an identifier containing shell metacharacters', () => {
    expect(() => assertSafeIdentifiers(['atlas_app; rm -rf /'], 'schema')).toThrow(/Invalid schema/);
  });

  it('rejects an identifier containing a dot (path traversal shape)', () => {
    expect(() => assertSafeIdentifiers(['../../etc/passwd'], 'table')).toThrow(/Invalid table/);
  });

  it('rejects an identifier containing whitespace', () => {
    expect(() => assertSafeIdentifiers(['atlas app'], 'schema')).toThrow(/Invalid schema/);
  });

  it('reports the label passed in for a clearer error message', () => {
    expect(() => assertSafeIdentifiers(['bad;name'], 'table')).toThrow(/Invalid table/);
    expect(() => assertSafeIdentifiers(['bad;name'], 'schema')).toThrow(/Invalid schema/);
  });
});

describe('ALLOWED_PATCH_TRANSFERS', () => {
  const isAllowed = (from: string, to: string) =>
    ALLOWED_PATCH_TRANSFERS.some(([f, t]) => f === from && t === to);

  it('allows every documented transfer direction', () => {
    expect(isAllowed('prod', 'local')).toBe(true);
    expect(isAllowed('prod', 'master')).toBe(true);
    expect(isAllowed('prod_international', 'local')).toBe(true);
    expect(isAllowed('prod_international', 'master')).toBe(true);
    expect(isAllowed('master', 'local')).toBe(true);
    expect(isAllowed('env', 'local')).toBe(true);
  });

  it('never allows importing into prod or prod_international', () => {
    // config_transfer.py hard-blocks this at the python layer too — this
    // list should never contradict that by naming prod/prod_international
    // as a target.
    const targets = ALLOWED_PATCH_TRANSFERS.map(([, to]) => to);
    expect(targets).not.toContain('prod');
    expect(targets).not.toContain('prod_international');
  });

  it('rejects an undocumented pair (e.g. local -> master)', () => {
    expect(isAllowed('local', 'master')).toBe(false);
  });

  it('rejects a same-to-same pair', () => {
    expect(isAllowed('master', 'master')).toBe(false);
  });
});

describe('getAllowedEnvs', () => {
  const ORIGINAL = process.env.CONFIG_SYNC_ALLOWED_ENVS;

  beforeEach(() => {
    delete process.env.CONFIG_SYNC_ALLOWED_ENVS;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CONFIG_SYNC_ALLOWED_ENVS;
    else process.env.CONFIG_SYNC_ALLOWED_ENVS = ORIGINAL;
  });

  it('defaults to every VALID_ENVS value when unset (local dev convenience)', () => {
    expect(getAllowedEnvs()).toEqual([...VALID_ENVS]);
  });

  it('parses a single-env deployment and implicitly allows local alongside it', () => {
    process.env.CONFIG_SYNC_ALLOWED_ENVS = 'master';
    expect(getAllowedEnvs()).toEqual(['master', 'local']);
  });

  it('trims surrounding whitespace', () => {
    process.env.CONFIG_SYNC_ALLOWED_ENVS = ' prod ';
    expect(getAllowedEnvs()).toEqual(['prod', 'local']);
  });

  it('does not double up when the one allowed env is local itself', () => {
    process.env.CONFIG_SYNC_ALLOWED_ENVS = 'local';
    expect(getAllowedEnvs()).toEqual(['local']);
  });

  it('throws on an invalid env name, refusing to silently ignore a misconfigured deployment', () => {
    process.env.CONFIG_SYNC_ALLOWED_ENVS = 'staging';
    expect(() => getAllowedEnvs()).toThrow(/Invalid environment/);
  });

  it('throws on a comma-separated list — arrays are no longer supported', () => {
    process.env.CONFIG_SYNC_ALLOWED_ENVS = 'prod,prod_international';
    expect(() => getAllowedEnvs()).toThrow(/Invalid environment/);
  });
});
