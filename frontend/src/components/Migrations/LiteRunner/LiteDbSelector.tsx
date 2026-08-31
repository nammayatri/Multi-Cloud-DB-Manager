import React, { useEffect, useMemo, useState } from 'react';
import { FormControl, InputLabel, Select, MenuItem, Stack } from '@mui/material';
import { schemaAPI } from '../../../services/api';
import { buildDbMap, buildModesForDb, listAllDatabases } from '../../Selector/databaseTopology';
import type { DatabaseConfiguration } from '../../../types';
import { useLiteRunnerStore } from '../../../store/liteRunnerStore';

/**
 * Target picker for the Lite Runner: database, cloud, schema.
 *
 * Selection is held in liteRunnerStore rather than appStore, so choosing a
 * target here never disturbs the DB Manager tab's own selection.
 */
const LiteDbSelector = ({ disabled }: { disabled?: boolean }) => {
  const database = useLiteRunnerStore((s) => s.database);
  const mode = useLiteRunnerStore((s) => s.mode);
  const pgSchema = useLiteRunnerStore((s) => s.pgSchema);
  const setDatabase = useLiteRunnerStore((s) => s.setDatabase);
  const setMode = useLiteRunnerStore((s) => s.setMode);
  const setPgSchema = useLiteRunnerStore((s) => s.setPgSchema);

  const [config, setConfig] = useState<DatabaseConfiguration | null>(null);

  useEffect(() => {
    schemaAPI.getConfiguration().then(setConfig).catch(() => { /* toasted by the api layer */ });
  }, []);

  const dbMap = useMemo(() => (config ? buildDbMap(config) : {}), [config]);
  const databases = useMemo(() => (config ? listAllDatabases(config) : []), [config]);
  const modes = useMemo(() => buildModesForDb(dbMap[database]), [dbMap, database]);
  const schemas = dbMap[database]?.schemas || [];

  // Default to the first database once config lands.
  useEffect(() => {
    if (!database && databases.length > 0) setDatabase(databases[0].name);
  }, [databases, database, setDatabase]);

  // Keep mode and schema valid for whichever database is selected: the options
  // change per database, so a stale value would submit a cloud or schema this
  // database does not have.
  useEffect(() => {
    if (!database) return;
    if (modes.length > 0 && !modes.some(m => m.value === mode)) {
      setMode(modes[0].value);
    }
  }, [database, modes, mode, setMode]);

  useEffect(() => {
    if (!database) return;
    const meta = dbMap[database];
    if (!meta) return;
    if (!pgSchema || !schemas.includes(pgSchema)) {
      setPgSchema(meta.defaultSchema || schemas[0] || 'public');
    }
  }, [database, dbMap, pgSchema, schemas, setPgSchema]);

  return (
    <Stack direction="row" spacing={1.5} alignItems="center">
      <FormControl size="small" sx={{ flex: 1 }} disabled={disabled}>
        <InputLabel>Database</InputLabel>
        <Select value={database} label="Database" onChange={(e) => setDatabase(e.target.value)}>
          {databases.map((db) => (
            <MenuItem key={db.name} value={db.name}>{db.label}</MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" sx={{ flex: 1 }} disabled={disabled || modes.length === 0}>
        <InputLabel>Execution Mode</InputLabel>
        <Select value={modes.some(m => m.value === mode) ? mode : ''} label="Execution Mode" onChange={(e) => setMode(e.target.value)}>
          {modes.map((m) => (
            <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" sx={{ flex: 1 }} disabled={disabled || schemas.length === 0}>
        <InputLabel>Schema</InputLabel>
        <Select value={schemas.includes(pgSchema) ? pgSchema : ''} label="Schema" onChange={(e) => setPgSchema(e.target.value)}>
          {schemas.map((s) => (
            <MenuItem key={s} value={s}>{s}</MenuItem>
          ))}
        </Select>
      </FormControl>
    </Stack>
  );
};

export default React.memo(LiteDbSelector);
