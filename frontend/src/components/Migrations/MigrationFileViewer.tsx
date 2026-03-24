import React, { useMemo, useState } from 'react';
import {
  Box,
  Typography,
  Chip,
  Button,
  Stack,
  Paper,
  Collapse,
  IconButton,
  Checkbox,
  Divider,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import { useMigrationsStore, makeKey } from '../../store/migrationsStore';
import type { MigrationStatement, MigrationFileResult } from '../../types/migrations';
import toast from 'react-hot-toast';

type StatementStatus = MigrationStatement['status'];
type FileStatus = MigrationFileResult['status'];

const statusColor: Record<StatementStatus | FileStatus, 'success' | 'warning' | 'info' | 'error' | 'default'> = {
  applied: 'success',
  pending: 'warning',
  partial: 'warning',
  manual_check: 'info',
  error: 'error',
  skipped: 'default',
};

interface StatementCategory {
  key: string;
  label: string;
  color: 'primary' | 'warning' | 'info' | 'error' | 'success' | 'default';
  icon: string;
  match: (stmt: MigrationStatement) => boolean;
}

const STATEMENT_CATEGORIES: StatementCategory[] = [
  {
    key: 'alter',
    label: 'ALTER — Schema Changes',
    color: 'primary',
    icon: '',
    match: (s) => s.type === 'DDL' && !s.operation.includes('NOT NULL'),
  },
  {
    key: 'alter_not_null',
    label: 'ALTER NOT NULL',
    color: 'info',
    icon: '',
    match: (s) => s.type === 'DDL' && s.operation.includes('NOT NULL'),
  },
  {
    key: 'insert',
    label: 'INSERT',
    color: 'success',
    icon: '',
    match: (s) => s.type === 'DML' && s.operation === 'INSERT',
  },
  {
    key: 'update',
    label: 'UPDATE',
    color: 'warning',
    icon: '',
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

  // Catch uncategorized
  const categorizedIndices = new Set(groups.flatMap(g => g.statements.map(s => s.originalIndex)));
  const uncategorized = statements
    .map((stmt, i) => ({ stmt, originalIndex: i }))
    .filter(({ originalIndex }) => !categorizedIndices.has(originalIndex));
  if (uncategorized.length > 0) {
    groups.push({
      category: { key: 'other', label: 'Other', color: 'default', icon: '', match: () => false },
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
        mb: 1,
        border: 1,
        borderColor: isSelected ? 'warning.main' : 'divider',
        bgcolor: isPending ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.01)',
        opacity: isPending ? 1 : 0.6,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.75 }}>
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
        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.8rem', flex: 1 }} noWrap>
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
        <Box sx={{ px: 1.5, pb: 1 }}>
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
                padding: '8px 12px',
                fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
                fontSize: '0.78rem',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: 200,
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

// --- Category Section ---
const CategorySection = React.memo(({ category, statements, filePath, defaultExpanded }: {
  category: StatementCategory;
  statements: Array<{ stmt: MigrationStatement; originalIndex: number }>;
  filePath: string;
  defaultExpanded: boolean;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const selectAllInCategory = useMigrationsStore((s) => s.selectAllInCategory);

  const pendingStatements = statements.filter(s => s.stmt.status === 'pending');
  const appliedStatements = statements.filter(s => s.stmt.status === 'applied' || s.stmt.status === 'skipped');
  const pendingCount = pendingStatements.length;

  const handleCopyCategory = () => {
    const sql = pendingStatements.map(s => s.stmt.sql).filter(Boolean).join(';\n\n');
    if (sql) {
      navigator.clipboard.writeText(sql);
      toast.success(`Copied ${pendingCount} pending statement(s) from ${category.label}`);
    } else {
      toast('No pending statements to copy');
    }
  };

  const handleSelectAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectAllInCategory(filePath, pendingStatements.map(s => s.originalIndex));
  };

  if (pendingCount === 0 && appliedStatements.length === statements.length) {
    // All applied — show minimal collapsed
    return null; // Will be shown in the "applied" section below
  }

  return (
    <Box sx={{ mb: 1.5 }}>
      <Box
        onClick={() => setExpanded(!expanded)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 0.75,
          cursor: 'pointer',
          bgcolor: 'rgba(255,255,255,0.03)',
          borderRadius: 1,
          '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
        }}
      >
        <IconButton size="small" sx={{ p: 0 }}>
          {expanded ? <KeyboardArrowUpIcon fontSize="small" /> : <KeyboardArrowDownIcon fontSize="small" />}
        </IconButton>
        <Typography variant="body2" sx={{ fontSize: '0.85rem', fontWeight: 600 }}>
          {category.label}
        </Typography>
        {pendingCount > 0 && (
          <Chip label={`${pendingCount} pending`} size="small" color="warning" sx={{ height: 20, fontSize: '0.7rem' }} />
        )}
        {appliedStatements.length > 0 && (
          <Chip label={`${appliedStatements.length} applied`} size="small" color="success" variant="outlined" sx={{ height: 20, fontSize: '0.7rem' }} />
        )}
        <Box sx={{ flex: 1 }} />
        {pendingCount > 0 && (
          <>
            <Button
              size="small"
              startIcon={<CheckBoxIcon sx={{ fontSize: 14 }} />}
              onClick={handleSelectAll}
              sx={{ fontSize: '0.7rem', minWidth: 0, py: 0 }}
            >
              Select
            </Button>
            <Button
              size="small"
              startIcon={<ContentCopyIcon sx={{ fontSize: 14 }} />}
              onClick={(e) => { e.stopPropagation(); handleCopyCategory(); }}
              sx={{ fontSize: '0.7rem', minWidth: 0, py: 0 }}
            >
              Copy
            </Button>
          </>
        )}
      </Box>
      <Collapse in={expanded} timeout="auto" unmountOnExit>
        <Box sx={{ pt: 1, pl: 1 }}>
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

// --- Applied Count ---
const AppliedCount = React.memo(({ count }: { count: number }) => {
  if (count === 0) return null;

  return (
    <Box sx={{ mt: 2 }}>
      <Divider sx={{ mb: 1 }} />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.75 }}>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.85rem' }}>
          {count} statement{count !== 1 ? 's' : ''} already applied
        </Typography>
        <Chip label="applied" size="small" color="success" variant="outlined" sx={{ height: 20, fontSize: '0.65rem' }} />
      </Box>
    </Box>
  );
});

// --- Main Viewer ---
const MigrationFileViewer = () => {
  const selectedFilePath = useMigrationsStore((s) => s.selectedFilePath);
  const analysisResult = useMigrationsStore((s) => s.analysisResult);
  const selectAllInFile = useMigrationsStore((s) => s.selectAllInFile);

  const file = useMemo(() => {
    if (!analysisResult || !selectedFilePath) return null;
    return analysisResult.files.find((f) => f.path === selectedFilePath) || null;
  }, [analysisResult, selectedFilePath]);

  const pendingGroups = useMemo(() => {
    if (!file) return [];

    // All statements in the response are already actionable (applied stripped by backend)
    const allStmts = file.statements.map((stmt, i) => ({ stmt, originalIndex: i }));

    // Categorize them
    const groups = categorizeStatements(allStmts.map(p => p.stmt));
    // Remap originalIndex back
    return groups.map(g => ({
      ...g,
      statements: g.statements.map(s => ({
        stmt: s.stmt,
        originalIndex: allStmts[s.originalIndex].originalIndex,
      })),
    }));
  }, [file]);

  if (!file) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Typography variant="body2" color="text.secondary">
          Select a file from the tree to view its details
        </Typography>
      </Box>
    );
  }

  const pendingCount = file.statements.filter(s => s.status === 'pending').length;

  const handleCopyFilePending = () => {
    const sql = file.statements
      .filter(s => s.status === 'pending')
      .map(s => s.sql)
      .filter(Boolean)
      .join(';\n\n');
    if (sql) {
      navigator.clipboard.writeText(sql);
      toast.success(`Copied ${pendingCount} pending statement(s)`);
    } else {
      toast('No pending statements to copy');
    }
  };

  const handleCopyAllStatements = () => {
    const sql = file.statements.map(s => s.sql).filter(Boolean).join(';\n\n');
    if (sql) {
      navigator.clipboard.writeText(sql);
      toast.success(`Copied all ${file.statements.length} statement(s)`);
    }
  };

  const handleDownloadPending = () => {
    const sql = file.statements
      .filter(s => s.status === 'pending')
      .map(s => s.sql)
      .filter(Boolean)
      .join(';\n\n');
    if (!sql) {
      toast('No pending statements to download');
      return;
    }
    const blob = new Blob([sql], { type: 'text/sql' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pending_${file.filename}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <Box sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="body2" sx={{ fontFamily: 'monospace', flex: 1 }} noWrap>
            {file.path}
          </Typography>
          <Chip
            label={file.status.replace('_', ' ')}
            size="small"
            color={statusColor[file.status]}
            sx={{ textTransform: 'capitalize' }}
          />
          {file.targetDatabase && (
            <Chip label={file.targetDatabase} size="small" variant="outlined" />
          )}
        </Stack>
        <Stack direction="row" spacing={1}>
          {pendingCount > 0 && (
            <>
              <Button
                size="small"
                variant="outlined"
                startIcon={<CheckBoxIcon sx={{ fontSize: 14 }} />}
                onClick={() => selectAllInFile(file.path)}
                sx={{ fontSize: '0.75rem' }}
              >
                Select All Pending ({pendingCount})
              </Button>
              <Button
                size="small"
                variant="contained"
                color="warning"
                startIcon={<ContentCopyIcon sx={{ fontSize: 14 }} />}
                onClick={handleCopyFilePending}
                sx={{ fontSize: '0.75rem' }}
              >
                Copy Pending
              </Button>
              <Button
                size="small"
                startIcon={<DownloadIcon sx={{ fontSize: 14 }} />}
                onClick={handleDownloadPending}
                sx={{ fontSize: '0.75rem' }}
              >
                Download Pending
              </Button>
            </>
          )}
          <Button
            size="small"
            startIcon={<ContentCopyIcon sx={{ fontSize: 14 }} />}
            onClick={handleCopyAllStatements}
            sx={{ fontSize: '0.75rem' }}
          >
            Copy All
          </Button>
        </Stack>
      </Box>

      {/* Main content — scrollable */}
      <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0, p: 1.5 }}>
        {/* Pending statements grouped by category */}
        {pendingGroups.length > 0 ? (
          pendingGroups.map((group) => (
            <CategorySection
              key={group.category.key}
              category={group.category}
              statements={group.statements}
              filePath={file.path}
              defaultExpanded={true}
            />
          ))
        ) : (
          <Box sx={{ py: 2, textAlign: 'center' }}>
            <Typography variant="body2" color="success.main" sx={{ fontWeight: 600 }}>
              All statements in this file are applied
            </Typography>
          </Box>
        )}

        {/* Applied count */}
        <AppliedCount count={file.appliedCount || 0} />
      </Box>
    </Box>
  );
};

export default React.memo(MigrationFileViewer);
