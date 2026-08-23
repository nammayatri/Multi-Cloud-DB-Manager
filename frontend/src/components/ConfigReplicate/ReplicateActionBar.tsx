import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Slide,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import { useConfigReplicateStore } from '../../store/configReplicateStore';

interface Props {
  isSecondaryCloud: boolean;
}

const ReplicateActionBar = ({ isSecondaryCloud }: Props) => {
  const selectedCount = useConfigReplicateStore(s => s.selectedDiffs.size);
  const deselectAll = useConfigReplicateStore(s => s.deselectAll);
  const getSelectedTotals = useConfigReplicateStore(s => s.getSelectedTotals);
  const apply = useConfigReplicateStore(s => s.apply);
  const isApplying = useConfigReplicateStore(s => s.isApplying);
  const analysis = useConfigReplicateStore(s => s.analysis);
  const cloud = useConfigReplicateStore(s => s.cloud);
  const database = useConfigReplicateStore(s => s.database);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState('');

  if (selectedCount === 0 || !analysis) return null;

  const totals = getSelectedTotals();
  const newLabel = analysis.newValues.join(' | ');
  const confirmed = typed.trim() === newLabel;

  const handleApply = async () => {
    setConfirmOpen(false);
    setTyped('');
    await apply();
  };

  return (
    <>
      <Slide direction="up" in={selectedCount > 0} mountOnEnter unmountOnExit>
        <Paper
          elevation={8}
          sx={{
            position: 'fixed',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            px: 3,
            py: 1.5,
            borderRadius: 2,
            bgcolor: 'background.paper',
            border: 1,
            borderColor: 'warning.main',
            zIndex: 1200,
          }}
        >
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {selectedCount} {selectedCount === 1 ? 'row' : 'rows'} selected
              {' — '}
              {totals.insert} insert, {totals.update} update, {totals.delete} delete
            </Typography>

            <Button
              size="small"
              variant="contained"
              color="warning"
              startIcon={<PlayArrowIcon />}
              disabled={isApplying}
              onClick={() => setConfirmOpen(true)}
            >
              {isApplying ? 'Applying…' : 'Apply'}
            </Button>

            <Button
              size="small"
              startIcon={<CheckBoxOutlineBlankIcon />}
              onClick={deselectAll}
              disabled={isApplying}
            >
              Clear
            </Button>
          </Stack>
        </Paper>
      </Slide>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Apply configuration replication</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            This runs in a single transaction against <strong>{database}</strong> on{' '}
            <strong>{cloud}</strong>. Any error rolls the whole thing back.
          </Alert>

          {isSecondaryCloud && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {cloud} is not this database&apos;s primary cloud. Writing here is supported, but the
              change will not replicate back to the primary.
            </Alert>
          )}

          {totals.delete > 0 && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {totals.delete} row(s) will be <strong>permanently deleted</strong> from the new
              dimension.
            </Alert>
          )}

          <Typography variant="body2" sx={{ mb: 2 }}>
            {analysis.baseValues.join(' | ')} → {newLabel}: {totals.insert} insert,{' '}
            {totals.update} update, {totals.delete} delete.
          </Typography>

          <TextField
            fullWidth
            size="small"
            label={`Type "${newLabel}" to confirm`}
            value={typed}
            onChange={e => setTyped(e.target.value)}
            autoFocus
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button variant="contained" color="warning" disabled={!confirmed} onClick={handleApply}>
            Apply {selectedCount} {selectedCount === 1 ? 'row' : 'rows'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default ReplicateActionBar;
