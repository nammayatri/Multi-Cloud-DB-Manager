import { z } from 'zod';

/**
 * Structural validation for config.json / patches.json content, matching
 * config_transfer.py's own expected shape exactly (derived from the real
 * vendored files, not guessed). This is separate from — and stricter than —
 * the shallow "is it a non-null object" check that existed before: that
 * caught "someone pasted a string," this catches "someone pasted valid JSON
 * with the wrong keys," which otherwise only surfaces as a subprocess
 * failure the next time someone actually runs Export & Patch.
 */

// ── config.json ──
// { "_comment": "...", "_last_reviewed": "...", "<schema>": { "<table>": { "dim": [...] } } }
// Top-level keys are either metadata (string value) or a schema name (object
// of tables) — both share one record type since zod records need one value
// type per key.
const configJsonTableEntry = z.object({
  dim: z.array(z.string()),
});
const configJsonTablesObject = z.record(z.string(), configJsonTableEntry);
export const configJsonSchema = z.record(z.string(), z.union([z.string(), configJsonTablesObject]));

// ── patches.json ──
// Keyed by transfer direction (mirrors configTransfer.service.ts's
// ALLOWED_PATCH_TRANSFERS). Each direction's rules block is optional — a
// direction with nothing to patch can simply be omitted.
const PATCH_DIRECTIONS = [
  'prod_to_local', 'prod_to_master',
  'prod_international_to_local', 'prod_international_to_master',
  'master_to_local', 'env_to_local',
] as const;

// A global_replacements entry is either a real find/replace rule or a
// comment-only entry used purely for readability inside the array.
const globalReplacementEntry = z.union([
  z.object({ find: z.string(), replace: z.string() }),
  z.object({ _comment: z.string() }),
]);

// dimension_overrides: { "<schema>": { "<table>": [ <rule> ] } }
// A rule is always `where` (+ optional `_comment`) plus exactly one of two
// action shapes — `set` (flat column values) or `merge_json` (deep-merge
// into a JSON column, e.g. integrated_bpp_config's per-partner credentials).
// merge_json's inner fields are genuinely free-form per merchant/service
// (accessKey, apiToken, authToken, fcmServiceAccount, ...), so only the
// object-of-objects shape is checked, not the field names.
const dimensionOverrideRule = z.union([
  z.object({
    where: z.record(z.string(), z.any()),
    _comment: z.string().optional(),
    set: z.record(z.string(), z.any()),
  }),
  z.object({
    where: z.record(z.string(), z.any()),
    _comment: z.string().optional(),
    merge_json: z.record(z.string(), z.record(z.string(), z.any())),
  }),
]);
const dimensionOverrides = z.record(z.string(), z.record(z.string(), z.array(dimensionOverrideRule)));

const directionRules = z.object({
  // table_overrides / schema_replacements have no populated example in the
  // real file today — validated as "must be an object," not a fixed shape,
  // so this doesn't reject a legitimate future value we haven't seen yet.
  table_overrides: z.record(z.string(), z.any()),
  dimension_overrides: dimensionOverrides,
  global_replacements: z.array(globalReplacementEntry),
  schema_replacements: z.record(z.string(), z.any()),
});

export const patchesJsonSchema = z
  .object(Object.fromEntries(PATCH_DIRECTIONS.map(d => [d, directionRules.optional()])))
  // Anything else at the top level (e.g. "_comment") must be a plain string —
  // matches the real file's own convention for metadata keys.
  .catchall(z.string());
