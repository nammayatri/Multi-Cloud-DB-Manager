import React from 'react';
import { Paper, Stack, TextField, Button, Box, InputAdornment, Chip, Tooltip } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import FolderIcon from '@mui/icons-material/Folder';
import { useLiteRunnerStore, ALL_FILES } from '../../../store/liteRunnerStore';

/**
 * Search + expand/collapse + selection actions, then the directory pills.
 *
 * The pills FILTER the file list; they do not select. Selection is only ever
 * done with checkboxes, so there is one obvious way to choose what runs.
 */
const LiteDiffControls = () => {
  const diff = useLiteRunnerStore((s) => s.diff);
  const search = useLiteRunnerStore((s) => s.search);
  const setSearch = useLiteRunnerStore((s) => s.setSearch);
  const directoryFilter = useLiteRunnerStore((s) => s.directoryFilter);
  const setDirectoryFilter = useLiteRunnerStore((s) => s.setDirectoryFilter);
  const expandAll = useLiteRunnerStore((s) => s.expandAll);
  const collapseAll = useLiteRunnerStore((s) => s.collapseAll);
  const selectAllDdl = useLiteRunnerStore((s) => s.selectAllDdl);
  const deselectAll = useLiteRunnerStore((s) => s.deselectAll);
  const isRunning = useLiteRunnerStore((s) => s.isRunning);

  if (!diff || diff.totalFiles === 0) return null;

  return (
    <Paper elevation={1} sx={{ p: 1.5 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <TextField
            size="small"
            placeholder="Search files..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            sx={{ flex: 1, minWidth: 240 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
          <Button size="small" startIcon={<UnfoldMoreIcon />} onClick={expandAll} sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
            Expand All
          </Button>
          <Button size="small" startIcon={<UnfoldLessIcon />} onClick={collapseAll} sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
            Collapse All
          </Button>
          <Tooltip title="Selects every DDL statement in view — including the DDL inside a mixed file. Data changes stay unselected.">
            <span>
              <Button size="small" variant="outlined" onClick={selectAllDdl} disabled={isRunning} sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                Select All DDL
              </Button>
            </span>
          </Tooltip>
          <Button size="small" onClick={deselectAll} disabled={isRunning} sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
            Deselect All
          </Button>
        </Stack>

        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Chip
            icon={<FolderIcon sx={{ fontSize: 16 }} />}
            label={`All Files (${diff.totalFiles})`}
            onClick={() => setDirectoryFilter(ALL_FILES)}
            color={directoryFilter === ALL_FILES ? 'primary' : 'default'}
            variant={directoryFilter === ALL_FILES ? 'filled' : 'outlined'}
          />
          {diff.directories.map((dir) => (
            <Chip
              key={dir.directory}
              icon={<FolderIcon sx={{ fontSize: 16 }} />}
              label={`${dir.directory} (${dir.files.length})`}
              onClick={() => setDirectoryFilter(dir.directory)}
              color={directoryFilter === dir.directory ? 'primary' : 'default'}
              variant={directoryFilter === dir.directory ? 'filled' : 'outlined'}
              sx={{ maxWidth: '100%' }}
            />
          ))}
        </Stack>
      </Stack>
    </Paper>
  );
};

export default React.memo(LiteDiffControls);
