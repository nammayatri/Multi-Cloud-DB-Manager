import React, { useMemo, useState } from 'react';
import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Collapse,
  Chip,
  Typography,
  Checkbox,
  Button,
  Stack,
  Switch,
  FormControlLabel,
} from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import ExpandMore from '@mui/icons-material/ExpandMore';
import ChevronRight from '@mui/icons-material/ChevronRight';
import { useMigrationsStore } from '../../store/migrationsStore';
import type { MigrationFileResult } from '../../types/migrations';

type FileStatus = MigrationFileResult['status'];

const statusColor: Record<FileStatus, 'success' | 'warning' | 'info' | 'error'> = {
  applied: 'success',
  pending: 'warning',
  partial: 'warning',
  manual_check: 'info',
  error: 'error',
};

const statusLabel: Record<FileStatus, string> = {
  applied: 'Applied',
  pending: 'Pending',
  partial: 'Partial',
  manual_check: 'Check',
  error: 'Error',
};

function worstStatus(statuses: FileStatus[]): FileStatus {
  const priority: FileStatus[] = ['error', 'pending', 'partial', 'manual_check', 'applied'];
  for (const s of priority) {
    if (statuses.includes(s)) return s;
  }
  return 'applied';
}

const FileItem = React.memo(({ file, depth }: { file: MigrationFileResult; depth: number }) => {
  const selectedFilePath = useMigrationsStore((s) => s.selectedFilePath);
  const setSelectedFilePath = useMigrationsStore((s) => s.setSelectedFilePath);
  const selectAllInFile = useMigrationsStore((s) => s.selectAllInFile);
  const selectedStatements = useMigrationsStore((s) => s.selectedStatements);

  const pendingCount = file.statements.filter(s => s.status === 'pending').length;

  // Check if any statements in this file are selected
  const hasSelected = file.statements.some((_, i) => selectedStatements.has(`${file.path}:${i}`));

  const handleClick = () => {
    setSelectedFilePath(file.path);
  };

  const handleCheckbox = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasSelected) {
      // Deselect all in file
      const store = useMigrationsStore.getState();
      const next = new Set(store.selectedStatements);
      file.statements.forEach((_, i) => {
        next.delete(`${file.path}:${i}`);
      });
      useMigrationsStore.setState({ selectedStatements: next });
    } else {
      selectAllInFile(file.path);
    }
  };

  return (
    <ListItemButton
      selected={selectedFilePath === file.path}
      onClick={handleClick}
      sx={{ pl: 1 + depth * 2 }}
      dense
    >
      <Checkbox
        size="small"
        checked={hasSelected}
        onClick={handleCheckbox}
        sx={{ p: 0.25, mr: 0.5 }}
      />
      <ListItemIcon sx={{ minWidth: 24 }}>
        <InsertDriveFileIcon fontSize="small" sx={{ fontSize: 16 }} />
      </ListItemIcon>
      <ListItemText
        primary={file.filename}
        primaryTypographyProps={{ variant: 'body2', noWrap: true, fontSize: '0.8rem' }}
      />
      {pendingCount > 0 && (
        <Chip
          label={`${pendingCount}`}
          size="small"
          color="warning"
          sx={{ ml: 0.5, height: 18, fontSize: '0.65rem', minWidth: 24 }}
        />
      )}
      <Chip
        label={statusLabel[file.status]}
        size="small"
        color={statusColor[file.status]}
        sx={{ ml: 0.5, height: 18, fontSize: '0.65rem' }}
      />
    </ListItemButton>
  );
});

const GroupItem = React.memo(({ label, files, depth }: {
  label: string;
  files: MigrationFileResult[];
  depth: number;
}) => {
  const expandedFolders = useMigrationsStore((s) => s.expandedFolders);
  const toggleFolder = useMigrationsStore((s) => s.toggleFolder);
  const isExpanded = expandedFolders.has(label);
  const groupStatus = worstStatus(files.map((f) => f.status));
  const pendingCount = files.reduce(
    (sum, f) => sum + f.statements.filter(s => s.status === 'pending').length,
    0
  );

  return (
    <>
      <ListItemButton onClick={() => toggleFolder(label)} dense sx={{ pl: 1 + depth * 2 }}>
        <ListItemIcon sx={{ minWidth: 28 }}>
          {isExpanded
            ? <FolderOpenIcon fontSize="small" sx={{ fontSize: 16 }} />
            : <FolderIcon fontSize="small" sx={{ fontSize: 16 }} />
          }
        </ListItemIcon>
        <ListItemText
          primary={label}
          primaryTypographyProps={{ variant: 'body2', fontWeight: 600, fontSize: '0.85rem' }}
        />
        <Chip
          label={files.length.toString()}
          size="small"
          color={statusColor[groupStatus]}
          sx={{ mr: 0.5, height: 18, fontSize: '0.65rem' }}
        />
        {pendingCount > 0 && (
          <Chip
            label={`${pendingCount} pending`}
            size="small"
            color="warning"
            sx={{ mr: 0.5, height: 18, fontSize: '0.65rem' }}
          />
        )}
        {isExpanded ? <ExpandMore fontSize="small" /> : <ChevronRight fontSize="small" />}
      </ListItemButton>
      <Collapse in={isExpanded} timeout="auto" unmountOnExit>
        <List component="div" disablePadding>
          {files.map((file) => (
            <FileItem key={file.path} file={file} depth={depth + 1} />
          ))}
        </List>
      </Collapse>
    </>
  );
});

const MigrationFileTree = () => {
  const analysisResult = useMigrationsStore((s) => s.analysisResult);
  const statusFilter = useMigrationsStore((s) => s.statusFilter);
  const databaseFilter = useMigrationsStore((s) => s.databaseFilter);
  const viewMode = useMigrationsStore((s) => s.viewMode);
  const setViewMode = useMigrationsStore((s) => s.setViewMode);
  const selectAllPending = useMigrationsStore((s) => s.selectAllPending);
  const deselectAll = useMigrationsStore((s) => s.deselectAll);
  const [showApplied, setShowApplied] = useState(false);

  const { folderGroups, hiddenAppliedCount } = useMemo(() => {
    if (!analysisResult) return { folderGroups: [] as Array<{ label: string; files: MigrationFileResult[] }>, hiddenAppliedCount: 0 };

    let files = analysisResult.files;

    // Filter by selected database (already selected in toolbar dropdown)
    if (databaseFilter) {
      files = files.filter((f) => f.targetDatabase === databaseFilter);
    }

    // Apply status filter
    if (statusFilter !== 'all') {
      files = files.filter((f) => f.status === statusFilter);
    }

    // Count applied files that would be hidden
    const appliedFiles = files.filter(f => f.status === 'applied');
    const hiddenCount = !showApplied && viewMode === 'pending' ? appliedFiles.length : 0;

    // Filter out fully applied files if in pending mode and not showing applied
    if (viewMode === 'pending' && !showApplied) {
      files = files.filter((f) => f.status !== 'applied');
    }

    // Group by migrationGroup label (e.g., "Migrations", "Schema (Read-Only)", "After-Release")
    const groupMap: Record<string, MigrationFileResult[]> = {};
    for (const file of files) {
      const group = file.migrationGroup || file.folder || 'Other';
      if (!groupMap[group]) groupMap[group] = [];
      groupMap[group].push(file);
    }

    const result = Object.entries(groupMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, groupFiles]) => ({ label, files: groupFiles }));

    return { folderGroups: result, hiddenAppliedCount: hiddenCount };
  }, [analysisResult, statusFilter, databaseFilter, viewMode, showApplied]);

  if (!analysisResult) {
    return (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          Run an analysis to see migration files
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Controls */}
      <Box sx={{ p: 1, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={0.5} sx={{ mb: 0.5 }}>
          <Button size="small" variant="outlined" onClick={selectAllPending} sx={{ fontSize: '0.7rem', py: 0.25 }}>
            Select All
          </Button>
          <Button size="small" variant="outlined" onClick={deselectAll} sx={{ fontSize: '0.7rem', py: 0.25 }}>
            Deselect All
          </Button>
        </Stack>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={showApplied || viewMode === 'all'}
              onChange={(e) => {
                if (viewMode === 'pending') {
                  setShowApplied(e.target.checked);
                } else {
                  setViewMode(e.target.checked ? 'all' : 'pending');
                }
              }}
            />
          }
          label={
            <Typography variant="caption" color="text.secondary">
              Show applied files {hiddenAppliedCount > 0 && `(${hiddenAppliedCount} hidden)`}
            </Typography>
          }
          sx={{ ml: 0 }}
        />
      </Box>

      {/* File tree — flat folder groups > files */}
      <Box sx={{ flex: 1, overflow: 'auto' }}>
        {folderGroups.length === 0 ? (
          <Box sx={{ p: 2, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              No files match the current filter
            </Typography>
          </Box>
        ) : (
          <List dense sx={{ py: 0 }}>
            {folderGroups.map((group) => (
              <GroupItem
                key={group.label}
                label={group.label}
                files={group.files}
                depth={0}
              />
            ))}
          </List>
        )}
      </Box>
    </Box>
  );
};

export default React.memo(MigrationFileTree);
