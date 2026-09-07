import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { configJsonSchema, patchesJsonSchema } from './configSyncAssets.schema';

/**
 * Structural validation for config.json/patches.json — the gap this closes:
 * before this schema existed, saving either file only checked "is this a
 * non-null object," so valid-JSON-wrong-shape content saved successfully
 * and only broke the next time someone actually ran Export & Patch.
 */

// Seed content only (see configSyncAssets.service.ts's SEED_DIR) —
// patches.json has no equivalent committed file (can carry real secrets, so
// it's gitignored and starts as an empty object instead; covered by the
// "accepts an empty object" test below, not a real-file read).
const SEED_DIR = path.join(__dirname, '../../../config-sync/seed');

describe('configJsonSchema', () => {
  it('accepts the real vendored config.json as-is', () => {
    const content = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'config.json'), 'utf8'));
    expect(configJsonSchema.safeParse(content).success).toBe(true);
  });

  it('accepts metadata keys alongside schema entries', () => {
    const result = configJsonSchema.safeParse({
      _comment: 'registry',
      _last_reviewed: '2026-01-01',
      atlas_app: { merchant: { dim: [] } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a table entry missing "dim"', () => {
    const result = configJsonSchema.safeParse({ atlas_app: { merchant: {} } });
    expect(result.success).toBe(false);
  });

  it('rejects "dim" that is not an array', () => {
    const result = configJsonSchema.safeParse({ atlas_app: { merchant: { dim: 'not-an-array' } } });
    expect(result.success).toBe(false);
  });

  it('rejects a schema entry that is neither a string nor a tables object', () => {
    const result = configJsonSchema.safeParse({ atlas_app: 123 });
    expect(result.success).toBe(false);
  });
});

describe('patchesJsonSchema', () => {
  it('accepts an empty object (no directions patched yet — patches.json has no seed file and starts this way)', () => {
    expect(patchesJsonSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a "set"-shaped dimension_overrides rule', () => {
    const result = patchesJsonSchema.safeParse({
      master_to_local: {
        table_overrides: {},
        dimension_overrides: { atlas_app: { merchant: [{ where: {}, set: { key: 'value' } }] } },
        global_replacements: [],
        schema_replacements: {},
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a "merge_json"-shaped dimension_overrides rule (integrated_bpp_config style)', () => {
    const result = patchesJsonSchema.safeParse({
      prod_to_local: {
        table_overrides: {},
        dimension_overrides: {
          atlas_app: {
            integrated_bpp_config: [{
              where: { 'config_json.tag': 'CMRL' },
              _comment: 'CMRL creds',
              merge_json: { config_json: { contents: { password: 'ENCRYPT:S"mock"' } } },
            }],
          },
        },
        global_replacements: [],
        schema_replacements: {},
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a dimension_overrides rule with neither "set" nor "merge_json"', () => {
    const result = patchesJsonSchema.safeParse({
      master_to_local: {
        table_overrides: {},
        dimension_overrides: { atlas_app: { merchant: [{ where: {} }] } },
        global_replacements: [],
        schema_replacements: {},
      },
    });
    expect(result.success).toBe(false);
  });

  it('accepts comment-only entries inside global_replacements', () => {
    const result = patchesJsonSchema.safeParse({
      master_to_local: {
        table_overrides: {},
        dimension_overrides: {},
        global_replacements: [{ _comment: 'section header' }, { find: 'a', replace: 'b' }],
        schema_replacements: {},
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a global_replacements entry with only "find" and no "replace"', () => {
    const result = patchesJsonSchema.safeParse({
      master_to_local: {
        table_overrides: {},
        dimension_overrides: {},
        global_replacements: [{ find: 'a' }],
        schema_replacements: {},
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key with a non-string value (not a valid direction, not valid metadata)', () => {
    const result = patchesJsonSchema.safeParse({ not_a_real_direction: { foo: 'bar' } });
    expect(result.success).toBe(false);
  });
});
