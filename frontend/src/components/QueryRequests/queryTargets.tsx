import { useEffect, useMemo, useState } from 'react';
import { FormControl, InputLabel, MenuItem, Select, Stack } from '@mui/material';
import { schemaAPI, toastNonApiError } from '../../services/api';
import { buildDbMap, buildModesForDb } from '../Selector/databaseTopology';
import type { DbMap } from '../Selector/databaseTopology';

/**
 * Target selection for query requests that don't inherit a target from a
 * console execution — the "New request" flow and each row of a group.
 *
 * Shared so the two dialogs can't drift on what counts as a valid
 * database/cloud/schema combination.
 */

export interface QueryTarget {
  database: string;
  mode: string;
  pgSchema: string;
}

/**
 * Load the database topology once. schemaAPI caches and de-duplicates
 * concurrent calls, so mounting several of these is cheap.
 */
export const useDatabaseTopology = (enabled: boolean) => {
  const [dbMap, setDbMap] = useState<DbMap>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    setLoading(true);

    schemaAPI
      .getConfiguration()
      .then((config) => {
        if (!cancelled) setDbMap(buildDbMap(config));
      })
      .catch((error) => toastNonApiError(error, 'Failed to load database configuration'))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { dbMap, loading };
};

/**
 * A valid target for `database`. Modes and schemas are per-database — a
 * single-cloud database has no 'both' option — so switching database has to
 * re-derive both rather than carry the old values over.
 */
export const defaultTargetFor = (dbMap: DbMap, database: string): QueryTarget => {
  const meta = dbMap[database];
  const modes = buildModesForDb(meta);

  return {
    database,
    mode: modes[0]?.value || '',
    pgSchema: meta?.defaultSchema || 'public',
  };
};

/** The first database in the topology, for initialising a fresh form. */
export const firstDatabase = (dbMap: DbMap): string => Object.keys(dbMap)[0] || '';

interface QueryTargetSelectsProps {
  dbMap: DbMap;
  loading?: boolean;
  value: QueryTarget;
  onChange: (next: QueryTarget) => void;
  size?: 'small' | 'medium';
}

export const QueryTargetSelects = ({
  dbMap,
  loading = false,
  value,
  onChange,
  size = 'small',
}: QueryTargetSelectsProps) => {
  const modes = useMemo(() => buildModesForDb(dbMap[value.database]), [dbMap, value.database]);
  const schemas = dbMap[value.database]?.schemas || [];

  return (
    <Stack direction="row" spacing={1.5}>
      <FormControl sx={{ flex: 1 }} size={size} disabled={loading}>
        <InputLabel>Database</InputLabel>
        <Select
          value={value.database}
          label="Database"
          // Re-derive mode and schema: the previous ones may not exist on the
          // newly selected database.
          onChange={(e) => onChange(defaultTargetFor(dbMap, e.target.value))}
        >
          {Object.entries(dbMap).map(([name, meta]) => (
            <MenuItem key={name} value={name}>
              {meta.label || name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl sx={{ flex: 1 }} size={size} disabled={loading}>
        <InputLabel>Execution mode</InputLabel>
        <Select
          value={value.mode}
          label="Execution mode"
          onChange={(e) => onChange({ ...value, mode: e.target.value })}
        >
          {modes.map((m) => (
            <MenuItem key={m.value} value={m.value}>
              {m.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl sx={{ flex: 1 }} size={size} disabled={loading}>
        <InputLabel>Schema</InputLabel>
        <Select
          value={value.pgSchema}
          label="Schema"
          onChange={(e) => onChange({ ...value, pgSchema: e.target.value })}
        >
          {schemas.map((s) => (
            <MenuItem key={s} value={s}>
              {s}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </Stack>
  );
};
