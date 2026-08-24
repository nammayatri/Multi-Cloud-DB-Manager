import {
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useConfigReplicateStore } from '../../store/configReplicateStore';

const ReplicateSummaryBar = () => {
  const analysis = useConfigReplicateStore(s => s.analysis);
  const opFilter = useConfigReplicateStore(s => s.opFilter);
  const setOpFilter = useConfigReplicateStore(s => s.setOpFilter);
  const selectAllDefaults = useConfigReplicateStore(s => s.selectAllDefaults);
  const deselectAll = useConfigReplicateStore(s => s.deselectAll);
  const selectedCount = useConfigReplicateStore(s => s.selectedDiffs.size);

  if (!analysis) return null;

  const ambiguousCount = analysis.tables
    .flatMap(t => t.diffs)
    .filter(d => d.ambiguous).length;

  return (
    <Paper elevation={0} sx={{ p: 1.5, mb: 1.5, border: 1, borderColor: 'divider' }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {analysis.baseValues.join(' | ')} → {analysis.newValues.join(' | ')}
        </Typography>

        <Stack direction="row" spacing={0.75}>
          <Chip label={`${analysis.totals.insert} to insert`} size="small" color="success" />
          <Chip label={`${analysis.totals.update} to update`} size="small" color="warning" />
          <Chip label={`${analysis.totals.delete} orphaned`} size="small" color="error" />
          <Chip label={`${analysis.totals.noChange} unchanged`} size="small" variant="outlined" />
          {ambiguousCount > 0 && (
            <Chip label={`${ambiguousCount} unmatched`} size="small" color="warning" variant="outlined" />
          )}
        </Stack>

        <Box sx={{ flexGrow: 1 }} />

        <ToggleButtonGroup
          size="small"
          exclusive
          value={opFilter}
          onChange={(_, value) => value && setOpFilter(value)}
        >
          <ToggleButton value="all" sx={{ fontSize: '0.7rem', py: 0.25 }}>All</ToggleButton>
          <ToggleButton value="INSERT" sx={{ fontSize: '0.7rem', py: 0.25 }}>Insert</ToggleButton>
          <ToggleButton value="UPDATE" sx={{ fontSize: '0.7rem', py: 0.25 }}>Update</ToggleButton>
          <ToggleButton value="DELETE" sx={{ fontSize: '0.7rem', py: 0.25 }}>Delete</ToggleButton>
          <ToggleButton value="AMBIGUOUS" sx={{ fontSize: '0.7rem', py: 0.25 }}>Unmatched</ToggleButton>
        </ToggleButtonGroup>

        <Button size="small" onClick={selectAllDefaults}>Reset to defaults</Button>
        <Button size="small" onClick={deselectAll} disabled={selectedCount === 0}>
          Clear
        </Button>
      </Stack>
    </Paper>
  );
};

export default ReplicateSummaryBar;
