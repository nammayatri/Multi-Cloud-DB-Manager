import React, { useMemo, useState } from 'react';
import {
  Box,
  Typography,
  Chip,
  Button,
  Paper,
  Collapse,
  IconButton,
  Checkbox,
  Divider,
  Switch,
  FormControlLabel,
  CircularProgress,
  LinearProgress,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import StorageIcon from '@mui/icons-material/Storage';
import { useMigrationsStore, makeKey } from '../../store/migrationsStore';
import type { MigrationStatement, MigrationFileResult } from '../../types/migrations';
import toast from 'react-hot-toast';

type StatementStatus = MigrationStatement['status'];

const statusColor: Record<StatementStatus | MigrationFileResult['status'], 'success' | 'warning' | 'info' | 'error' | 'default'> = {
  applied: 'success',
  pending: 'warning',
  partial: 'warning',
  manual_check: 'info',
  error: 'error',
  skipped: 'default',
};

const DB_COLORS: Record<string, string> = {
  BPP: '#1976d2',
  BAP: '#7b1fa2',
  'Provider Dashboard': '#2e7d32',
  'Rider Dashboard': '#e65100',
  'Safety Dashboard': '#c62828',
};

function getDbColor(db: string): string {
  return DB_COLORS[db] || '#546e7a';
}

interface StatementCategory {
  key: string;
  label: string;
  color: 'primary' | 'warning' | 'info' | 'error' | 'success' | 'default';
  match: (stmt: MigrationStatement) => boolean;
}

const STATEMENT_CATEGORIES: StatementCategory[] = [
  {
    key: 'alter',
    label: 'ALTER -- Schema Changes',
    color: 'primary',
    match: (s) => s.type === 'DDL' && !(s.operation.includes('NOT NULL') || s.sql.toUpperCase().includes('NOT NULL')),
  },
  {
    key: 'alter_not_null',
    label: 'ALTER NOT NULL',
    color: 'info',
    match: (s) => s.type === 'DDL' && (s.operation.includes('NOT NULL') || s.sql.toUpperCase().includes('NOT NULL')),
  },
  {
    key: 'insert',
    label: 'INSERT',
    color: 'success',
    match: (s) => s.type === 'DML' && s.operation === 'INSERT',
  },
  {
    key: 'update',
    label: 'UPDATE',
    color: 'warning',
    match: (s) => s.type === 'DML' && s.operation === 'UPDATE',
  },
];

function categorizeStatements(statements: MigrationStatement[]) {
  const groups: Array<{ category: StatementCategory; statements: Array<{ stmt: MigrationStatement; originalIndex: number }> }> = [];

  for (const cat of STATEMENT_CATEGORIES) {
    const matched = statements
      .map((stmt, i) => ({ stmt, originalIndex: i }))
      .filter(({ stmt }) => cat.match(stmt));
    if (matched.length > 0) {
      groups.push({ category: cat, statements: matched });
    }
  }

  const categorizedIndices = new Set(groups.flatMap(g => g.statements.map(s => s.originalIndex)));
  const uncategorized = statements
    .map((stmt, i) => ({ stmt, originalIndex: i }))
    .filter(({ originalIndex }) => !categorizedIndices.has(originalIndex));
  if (uncategorized.length > 0) {
    groups.push({
      category: { key: 'other', label: 'Other', color: 'default', match: () => false },
      statements: uncategorized,
    });
  }

  return groups;
}

// --- Statement Card ---
const StatementCard = React.memo(({ stmt, originalIndex, filePath, isPending }: {
  stmt: MigrationStatement;
  originalIndex: number;
  filePath: string;
  isPending: boolean;
}) => {
  const selectedStatements = useMigrationsStore((s) => s.selectedStatements);
  const toggleStatement = useMigrationsStore((s) => s.toggleStatement);
  const key = makeKey(filePath, originalIndex);
  const isSelected = selectedStatements.has(key);

  const handleCopy = () => {
    if (stmt.sql) {
      navigator.clipboard.writeText(stmt.sql);
      toast.success('SQL copied');
    }
  };

  return (
    <Paper
      elevation={0}
      sx={{
        mb: 0.75,
        border: 1,
        borderColor: isSelected ? 'warning.main' : 'divider',
        bgcolor: isPending ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.01)',
        opacity: isPending ? 1 : 0.6,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.5 }}>
        {isPending && (
          <Checkbox
            size="small"
            checked={isSelected}
            onChange={() => toggleStatement(key)}
            sx={{ p: 0.25 }}
          />
        )}
        <Chip
          label={stmt.operation}
          size="small"
          color={statusColor[stmt.status] as any}
          sx={{ height: 22, fontSize: '0.7rem', fontWeight: 600 }}
        />
        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.78rem', flex: 1 }} noWrap>
          {stmt.objectName}
        </Typography>
        <Chip
          label={stmt.status.replace('_', ' ')}
          size="small"
          variant="outlined"
          color={statusColor[stmt.status] as any}
          sx={{ height: 20, fontSize: '0.65rem', textTransform: 'capitalize' }}
        />
      </Box>

      {stmt.sql && (
        <Box sx={{ px: 1.5, pb: 0.75 }}>
          <Box
            sx={{
              position: 'relative',
              bgcolor: 'rgba(0,0,0,0.3)',
              borderRadius: 1,
              '&:hover .copy-btn': { opacity: 1 },
            }}
          >
            <pre
              style={{
                margin: 0,
                padding: '6px 10px',
                fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
                fontSize: '0.76rem',
                lineHeight: 1.4,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: 180,
                overflow: 'auto',
                color: '#e0e0e0',
              }}
            >
              {stmt.sql}
            </pre>
            <IconButton
              className="copy-btn"
              size="small"
              onClick={handleCopy}
              sx={{
                position: 'absolute',
                top: 4,
                right: 4,
                opacity: 0,
                transition: 'opacity 0.2s',
                bgcolor: 'rgba(255,255,255,0.1)',
                '&:hover': { bgcolor: 'rgba(255,255,255,0.2)' },
              }}
            >
              <ContentCopyIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Box>

          {stmt.details && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              {stmt.details}
            </Typography>
          )}
        </Box>
      )}
    </Paper>
  );
});

// --- Category Group ---
const CategoryGroup = React.memo(({ category, statements, filePath }: {
  category: StatementCategory;
  statements: Array<{ stmt: MigrationStatement; originalIndex: number }>;
  filePath: string;
}) => {
  const [expanded, setExpanded] = useState(true);
  const selectAllInCategory = useMigrationsStore((s) => s.selectAllInCategory);

  const pendingStatements = statements.filter(s => s.stmt.status === 'pending');
  const appliedStatements = statements.filter(s => s.stmt.status === 'applied' || s.stmt.status === 'skipped');
  const pendingCount = pendingStatements.length;

  if (pendingCount === 0 && appliedStatements.length === statements.length) {
    return null;
  }

  const handleCopyCategory = (e: React.MouseEvent) => {
    e.stopPropagation();
    const sql = pendingStatements.map(s => s.stmt.sql).filter(Boolean).join(';\n\n');
    if (sql) {
      navigator.clipboard.writeText(sql);
      toast.success(`Copied ${pendingCount} pending from ${category.label}`);
    } else {
      toast('No pending statements to copy');
    }
  };

  const handleSelectAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectAllInCategory(filePath, pendingStatements.map(s => s.originalIndex));
  };

  return (
    <Box sx={{ mb: 1 }}>
      <Box
        onClick={() => setExpanded(!expanded)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1,
          py: 0.5,
          cursor: 'pointer',
          bgcolor: 'rgba(255,255,255,0.03)',
          borderRadius: 1,
          '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
        }}
      >
        <IconButton size="small" sx={{ p: 0 }}>
          {expanded ? <KeyboardArrowUpIcon sx={{ fontSize: 16 }} /> : <KeyboardArrowDownIcon sx={{ fontSize: 16 }} />}
        </IconButton>
        <Typography variant="body2" sx={{ fontSize: '0.82rem', fontWeight: 600 }}>
          {category.label}
        </Typography>
        {pendingCount > 0 && (
          <Chip label={`${pendingCount} pending`} size="small" color="warning" sx={{ height: 18, fontSize: '0.65rem' }} />
        )}
        {appliedStatements.length > 0 && (
          <Chip label={`${appliedStatements.length} applied`} size="small" color="success" variant="outlined" sx={{ height: 18, fontSize: '0.65rem' }} />
        )}
        <Box sx={{ flex: 1 }} />
        {pendingCount > 0 && (
          <>
            <Button
              size="small"
              startIcon={<CheckBoxIcon sx={{ fontSize: 12 }} />}
              onClick={handleSelectAll}
              sx={{ fontSize: '0.68rem', minWidth: 0, py: 0, textTransform: 'none' }}
            >
              Select
            </Button>
            <Button
              size="small"
              startIcon={<ContentCopyIcon sx={{ fontSize: 12 }} />}
              onClick={handleCopyCategory}
              sx={{ fontSize: '0.68rem', minWidth: 0, py: 0, textTransform: 'none' }}
            >
              Copy
            </Button>
          </>
        )}
      </Box>
      <Collapse in={expanded} timeout="auto" unmountOnExit>
        <Box sx={{ pt: 0.5, pl: 1 }}>
          {statements.map(({ stmt, originalIndex }) => (
            <StatementCard
              key={originalIndex}
              stmt={stmt}
              originalIndex={originalIndex}
              filePath={filePath}
              isPending={stmt.status === 'pending' || stmt.status === 'manual_check' || stmt.status === 'error'}
            />
          ))}
        </Box>
      </Collapse>
    </Box>
  );
});

// --- File Section ---
const FileSection = React.memo(({ file }: { file: MigrationFileResult }) => {
  const [expanded, setExpanded] = useState(true);
  const selectAllInFile = useMigrationsStore((s) => s.selectAllInFile);

  const pendingCount = file.statements.filter(s => s.status === 'pending').length;

  const groups = useMemo(() => {
    return categorizeStatements(file.statements);
  }, [file.statements]);

  const handleCopyFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    const sql = file.statements
      .filter(s => s.status === 'pending')
      .map(s => s.sql)
      .filter(Boolean)
      .join(';\n\n');
    if (sql) {
      navigator.clipboard.writeText(sql);
      toast.success(`Copied ${pendingCount} pending from ${file.filename}`);
    } else {
      toast('No pending statements to copy');
    }
  };

  const handleSelectAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectAllInFile(file.path);
  };

  return (
    <Paper
      elevation={0}
      sx={{
        mb: 1.5,
        border: 1,
        borderColor: 'divider',
        overflow: 'hidden',
      }}
    >
      {/* File header */}
      <Box
        onClick={() => setExpanded(!expanded)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 0.75,
          cursor: 'pointer',
          bgcolor: 'rgba(255,255,255,0.04)',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.07)' },
        }}
      >
        <InsertDriveFileIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.82rem', fontWeight: 600 }}>
          {file.filename}
        </Typography>
        <Chip
          label={file.status.replace('_', ' ')}
          size="small"
          color={statusColor[file.status]}
          sx={{ height: 20, fontSize: '0.65rem', textTransform: 'capitalize' }}
        />
        {pendingCount > 0 && (
          <Chip label={`${pendingCount} pending`} size="small" color="warning" sx={{ height: 20, fontSize: '0.65rem' }} />
        )}
        <Box sx={{ flex: 1 }} />
        {pendingCount > 0 && (
          <>
            <Button
              size="small"
              startIcon={<CheckBoxIcon sx={{ fontSize: 12 }} />}
              onClick={handleSelectAll}
              sx={{ fontSize: '0.68rem', minWidth: 0, py: 0, textTransform: 'none' }}
            >
              Select All
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<ContentCopyIcon sx={{ fontSize: 12 }} />}
              onClick={handleCopyFile}
              sx={{ fontSize: '0.68rem', minWidth: 0, py: 0, textTransform: 'none' }}
            >
              Copy File
            </Button>
          </>
        )}
        <IconButton size="small" sx={{ p: 0 }}>
          {expanded ? <KeyboardArrowUpIcon sx={{ fontSize: 16 }} /> : <KeyboardArrowDownIcon sx={{ fontSize: 16 }} />}
        </IconButton>
      </Box>

      <Collapse in={expanded} timeout="auto" unmountOnExit>
        <Box sx={{ px: 1.5, py: 1 }}>
          {groups.length > 0 ? (
            groups.map((group) => (
              <CategoryGroup
                key={group.category.key}
                category={group.category}
                statements={group.statements}
                filePath={file.path}
              />
            ))
          ) : (
            <Typography variant="body2" color="success.main" sx={{ fontSize: '0.82rem', fontWeight: 600, py: 1, textAlign: 'center' }}>
              All statements applied
            </Typography>
          )}

          {(file.appliedCount || 0) > 0 && (
            <>
              <Divider sx={{ my: 0.75 }} />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {file.appliedCount} already applied
                </Typography>
                <Chip label="applied" size="small" color="success" variant="outlined" sx={{ height: 18, fontSize: '0.6rem' }} />
              </Box>
            </>
          )}
        </Box>
      </Collapse>
    </Paper>
  );
});

// --- Folder Section ---
const FolderSection = React.memo(({ label, files }: {
  label: string;
  files: MigrationFileResult[];
}) => {
  const [expanded, setExpanded] = useState(true);

  const pendingCount = files.reduce(
    (sum, f) => sum + f.statements.filter(s => s.status === 'pending').length,
    0
  );

  const handleCopyFolder = (e: React.MouseEvent) => {
    e.stopPropagation();
    const sql = files
      .flatMap(f => f.statements)
      .filter(s => s.status === 'pending')
      .map(s => s.sql)
      .filter(Boolean)
      .join(';\n\n');
    if (sql) {
      navigator.clipboard.writeText(sql);
      toast.success(`Copied ${pendingCount} pending from ${label}`);
    } else {
      toast('No pending statements to copy');
    }
  };

  return (
    <Box sx={{ mb: 1.5, ml: 1.5 }}>
      <Box
        onClick={() => setExpanded(!expanded)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.5,
          cursor: 'pointer',
          bgcolor: 'rgba(255,255,255,0.02)',
          borderRadius: 1,
          '&:hover': { bgcolor: 'rgba(255,255,255,0.05)' },
        }}
      >
        <FolderOpenIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
        <Typography variant="body2" sx={{ fontSize: '0.85rem', fontWeight: 600 }}>
          {label}
        </Typography>
        <Chip label={`${files.length} files`} size="small" sx={{ height: 18, fontSize: '0.65rem' }} />
        {pendingCount > 0 && (
          <Chip label={`${pendingCount} pending`} size="small" color="warning" sx={{ height: 18, fontSize: '0.65rem' }} />
        )}
        <Box sx={{ flex: 1 }} />
        {pendingCount > 0 && (
          <Button
            size="small"
            variant="outlined"
            startIcon={<ContentCopyIcon sx={{ fontSize: 12 }} />}
            onClick={handleCopyFolder}
            sx={{ fontSize: '0.68rem', minWidth: 0, py: 0, textTransform: 'none' }}
          >
            Copy Folder
          </Button>
        )}
        <IconButton size="small" sx={{ p: 0 }}>
          {expanded ? <KeyboardArrowUpIcon sx={{ fontSize: 16 }} /> : <KeyboardArrowDownIcon sx={{ fontSize: 16 }} />}
        </IconButton>
      </Box>

      <Collapse in={expanded} timeout="auto" unmountOnExit>
        <Box sx={{ pl: 1.5, pt: 1 }}>
          {files.map((file) => (
            <FileSection key={file.path} file={file} />
          ))}
        </Box>
      </Collapse>
    </Box>
  );
});

// --- Database Section ---
const DatabaseSection = React.memo(({ database, files }: {
  database: string;
  files: MigrationFileResult[];
}) => {
  const [expanded, setExpanded] = useState(true);
  const color = getDbColor(database);

  const pendingCount = files.reduce(
    (sum, f) => sum + f.statements.filter(s => s.status === 'pending').length,
    0
  );

  // Group files by migrationGroup
  const folderGroups = useMemo(() => {
    const groupMap: Record<string, MigrationFileResult[]> = {};
    for (const file of files) {
      const group = file.migrationGroup || file.folder || 'Other';
      if (!groupMap[group]) groupMap[group] = [];
      groupMap[group].push(file);
    }
    return Object.entries(groupMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, groupFiles]) => ({ label, files: groupFiles }));
  }, [files]);

  const handleCopyDb = (e: React.MouseEvent) => {
    e.stopPropagation();
    const sql = files
      .flatMap(f => f.statements)
      .filter(s => s.status === 'pending')
      .map(s => s.sql)
      .filter(Boolean)
      .join(';\n\n');
    if (sql) {
      navigator.clipboard.writeText(sql);
      toast.success(`Copied ${pendingCount} pending from ${database}`);
    } else {
      toast('No pending statements to copy');
    }
  };

  return (
    <Paper
      elevation={2}
      sx={{
        mb: 2,
        borderLeft: 4,
        borderLeftColor: color,
        overflow: 'hidden',
      }}
    >
      <Box
        onClick={() => setExpanded(!expanded)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 2,
          py: 1,
          cursor: 'pointer',
          bgcolor: 'rgba(255,255,255,0.03)',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
        }}
      >
        <StorageIcon sx={{ fontSize: 20, color }} />
        <Typography variant="subtitle1" sx={{ fontWeight: 700, color }}>
          {database}
        </Typography>
        <Chip label={`${files.length} files`} size="small" sx={{ height: 20, fontSize: '0.7rem' }} />
        {pendingCount > 0 && (
          <Chip label={`${pendingCount} pending`} size="small" color="warning" sx={{ height: 20, fontSize: '0.7rem' }} />
        )}
        <Box sx={{ flex: 1 }} />
        {pendingCount > 0 && (
          <Button
            size="small"
            variant="outlined"
            startIcon={<ContentCopyIcon sx={{ fontSize: 14 }} />}
            onClick={handleCopyDb}
            sx={{ fontSize: '0.72rem', textTransform: 'none', borderColor: color, color }}
          >
            Copy All {database}
          </Button>
        )}
        <IconButton size="small" sx={{ p: 0 }}>
          {expanded ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
        </IconButton>
      </Box>

      <Collapse in={expanded} timeout="auto" unmountOnExit>
        <Box sx={{ px: 1, py: 1 }}>
          {folderGroups.map((group) => (
            <FolderSection key={group.label} label={group.label} files={group.files} />
          ))}
        </Box>
      </Collapse>
    </Paper>
  );
});

// --- Main Results View ---
const MigrationResultsView = () => {
  const analysisResult = useMigrationsStore((s) => s.analysisResult);
  const isAnalyzing = useMigrationsStore((s) => s.isAnalyzing);
  const statusFilter = useMigrationsStore((s) => s.statusFilter);
  const databaseFilter = useMigrationsStore((s) => s.databaseFilter);
  const viewMode = useMigrationsStore((s) => s.viewMode);
  const setViewMode = useMigrationsStore((s) => s.setViewMode);
  const [showApplied, setShowApplied] = useState(false);

  const { databases, hiddenAppliedCount } = useMemo(() => {
    if (!analysisResult) return { databases: [] as Array<{ database: string; files: MigrationFileResult[] }>, hiddenAppliedCount: 0 };

    let files = analysisResult.files;

    // Filter by database
    if (databaseFilter) {
      files = files.filter((f) => f.targetDatabase === databaseFilter);
    }

    // Apply status filter
    if (statusFilter !== 'all') {
      if (statusFilter === 'pending') {
        // "Pending" filter means show all actionable files (pending, partial, manual_check, error)
        files = files.filter((f) => f.status !== 'applied');
      } else {
        files = files.filter((f) => f.status === statusFilter);
      }
    }

    // Count applied files that would be hidden
    const appliedFiles = files.filter(f => f.status === 'applied');
    const hiddenCount = !showApplied && viewMode === 'pending' ? appliedFiles.length : 0;

    // Filter out fully applied files if in pending mode
    if (viewMode === 'pending' && !showApplied) {
      files = files.filter((f) => f.status !== 'applied');
    }

    // Group by database
    const dbMap: Record<string, MigrationFileResult[]> = {};
    for (const file of files) {
      const db = file.targetDatabase || 'Unknown';
      if (!dbMap[db]) dbMap[db] = [];
      dbMap[db].push(file);
    }

    const result = Object.entries(dbMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([database, dbFiles]) => ({ database, files: dbFiles }));

    return { databases: result, hiddenAppliedCount: hiddenCount };
  }, [analysisResult, statusFilter, databaseFilter, viewMode, showApplied]);

  if (isAnalyzing) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 8, gap: 2 }}>
        <CircularProgress size={36} />
        <Typography variant="body1" color="text.secondary">
          Analyzing migration files against database...
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Fetching git diff, parsing SQL statements, verifying against schema
        </Typography>
        <LinearProgress sx={{ width: 300 }} />
      </Box>
    );
  }

  if (!analysisResult) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', py: 8 }}>
        <Typography variant="body1" color="text.secondary">
          Run an analysis to see migration results
        </Typography>
      </Box>
    );
  }

  if (databases.length === 0) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', py: 8 }}>
        <Typography variant="body1" color="text.secondary">
          No files match the current filter
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
      {/* Show Applied toggle */}
      <Box sx={{ px: 1, pb: 1, display: 'flex', alignItems: 'center' }}>
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

      {/* Database sections */}
      <Box sx={{ px: 1, pb: 8 }}>
        {databases.map(({ database, files }) => (
          <DatabaseSection key={database} database={database} files={files} />
        ))}
      </Box>
    </Box>
  );
};

export default React.memo(MigrationResultsView);
