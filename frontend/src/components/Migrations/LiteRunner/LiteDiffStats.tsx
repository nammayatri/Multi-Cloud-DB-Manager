import React from 'react';
import { Paper, Stack, Typography, Box } from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import { useLiteRunnerStore, stmtKey, matchesSchema } from '../../../store/liteRunnerStore';

const Stat = ({ value, label, color }: { value: number | string; label: string; color?: string }) => (
  <Stack direction="row" spacing={0.75} alignItems="baseline">
    <Typography variant="body2" sx={{ fontWeight: 700, color }}>{value}</Typography>
    <Typography variant="body2" color="text.secondary">{label}</Typography>
  </Stack>
);

const LiteDiffStats = () => {
  const diff = useLiteRunnerStore((s) => s.diff);
  const selectedStatements = useLiteRunnerStore((s) => s.selectedStatements);
  const getVisibleFiles = useLiteRunnerStore((s) => s.getVisibleFiles);
  const directoryFilter = useLiteRunnerStore((s) => s.directoryFilter);
  const search = useLiteRunnerStore((s) => s.search);
  const pgSchema = useLiteRunnerStore((s) => s.pgSchema);

  if (!diff || diff.totalFiles === 0) return null;

  const files = getVisibleFiles();
  const statements = files.reduce((sum, f) => sum + f.statementCount, 0);
  const ddl = files.reduce((sum, f) => sum + f.ddlCount, 0);
  // DDL that can actually run against the selected target — the rest names
  // another schema, so the gap between the two counts is worth showing.
  const ddlHere = pgSchema
    ? files.reduce(
        (sum, f) => sum + f.statements.filter(st => st.type === 'DDL' && matchesSchema(st, pgSchema)).length,
        0
      )
    : ddl;
  const selected = files.reduce(
    (sum, f) => sum + f.statements.filter((_s, i) => selectedStatements.has(stmtKey(f.path, i))).length,
    0
  );

  const filtered = directoryFilter !== 'all' || search.trim().length > 0;

  return (
    <Paper elevation={1} sx={{ px: 2, py: 1.25 }}>
      <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" useFlexGap>
        <Stack direction="row" spacing={1} alignItems="center">
          <DescriptionIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
          <Stat value={files.length} label={files.length === 1 ? 'file' : 'files'} />
        </Stack>
        <Stat value={statements} label="statements" />
        <Stat value={ddl} label="DDL" color="#58a6ff" />
        {pgSchema && ddlHere !== ddl && (
          <Stat value={ddlHere} label={`in ${pgSchema}`} color="#58a6ff" />
        )}
        <Stat value={statements - ddl} label="non-DDL" color="#d29922" />
        <Box sx={{ flex: 1 }} />
        <Stat value={selected} label="selected" color="#3fb950" />
        {filtered && (
          <Typography variant="caption" color="text.secondary">
            (filtered view)
          </Typography>
        )}
        <Typography variant="caption" color="text.disabled" sx={{ whiteSpace: 'nowrap' }}>
          ⌘/Shift-click a file to select a range
        </Typography>
      </Stack>
    </Paper>
  );
};

export default React.memo(LiteDiffStats);
