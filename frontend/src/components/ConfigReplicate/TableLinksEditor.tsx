import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  OutlinedInput,
  Paper,
  Select,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LinkIcon from '@mui/icons-material/Link';
import {
  FkLink,
  ForeignKeyInfo,
  GroupTableConfig,
  TableMeta,
  tableKeyOf,
} from '../../types/configReplicate';
import { parentKeyOf } from './ordering';

interface Props {
  table: GroupTableConfig;
  tables: GroupTableConfig[];
  meta: TableMeta;
  metaByTable: Record<string, TableMeta>;
  detected: ForeignKeyInfo[];
  onChange: (links: FkLink[]) => void;
}

const mono = { fontFamily: 'monospace', fontSize: '0.72rem' } as const;

export const describeLink = (link: FkLink): string =>
  `${link.columns.join(', ')} → ${parentKeyOf(link)}` +
  (link.parentColumns.length > 0 ? ` (${link.parentColumns.join(', ')})` : ' (primary key)');

const sameLink = (a: FkLink, b: FkLink): boolean =>
  parentKeyOf(a) === parentKeyOf(b) && a.columns.join() === b.columns.join();

const linkFromForeignKey = (fk: ForeignKeyInfo): FkLink => ({
  columns: fk.childColumns,
  parentSchema: fk.parentSchema,
  parentTable: fk.parentTable,
  parentColumns: fk.parentColumns,
  source: 'DB_FK',
});

const TableLinksEditor = ({ table, tables, meta, metaByTable, detected, onChange }: Props) => {
  const [drafting, setDrafting] = useState(false);
  const [draftColumns, setDraftColumns] = useState<string[]>([]);
  const [draftParent, setDraftParent] = useState('');
  const [draftParentColumns, setDraftParentColumns] = useState<string[]>([]);

  const links = table.fkLinks || [];
  const selfKey = tableKeyOf(table);
  const parents = tables.filter(t => tableKeyOf(t) !== selfKey);

  const suggestions = useMemo(
    () =>
      detected
        .map(linkFromForeignKey)
        .filter(candidate => !links.some(link => sameLink(link, candidate))),
    [detected, links]
  );

  const parentMeta = draftParent ? metaByTable[draftParent] : undefined;

  const resetDraft = () => {
    setDrafting(false);
    setDraftColumns([]);
    setDraftParent('');
    setDraftParentColumns([]);
  };

  const addLink = (link: FkLink) => {
    const withoutOverlap = links.filter(
      existing => !existing.columns.some(column => link.columns.includes(column))
    );
    onChange([...withoutOverlap, link]);
  };

  const commitDraft = () => {
    addLink({
      columns: draftColumns,
      parentSchema: draftParent.slice(0, draftParent.indexOf('.')),
      parentTable: draftParent.slice(draftParent.indexOf('.') + 1),
      parentColumns: draftParentColumns,
      source: 'MANUAL',
    });
    resetDraft();
  };

  const draftValid =
    draftColumns.length > 0 &&
    draftParent !== '' &&
    (draftParentColumns.length === 0 || draftParentColumns.length === draftColumns.length);

  return (
    <Paper variant="outlined" sx={{ p: 1.25 }}>
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 0.5 }}>
        <LinkIcon sx={{ fontSize: 16 }} />
        <Typography variant="subtitle2">Links to other tables in this group</Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        A linked column is rewritten to the parent&apos;s new row — reusing the id this run
        generates for it. Linked tables are applied parents first.
      </Typography>

      {links.length === 0 && !drafting && (
        <Typography variant="caption" color="text.secondary">
          No links configured.
        </Typography>
      )}

      <Stack spacing={0.5}>
        {links.map((link, index) => (
          <Stack
            key={`${link.columns.join()}-${parentKeyOf(link)}`}
            direction="row"
            alignItems="center"
            spacing={1}
          >
            <Typography variant="body2" sx={{ ...mono, flex: 1 }} noWrap>
              {describeLink(link)}
            </Typography>
            <Chip
              label={link.source === 'DB_FK' ? 'db fk' : 'manual'}
              size="small"
              variant="outlined"
              color={link.source === 'DB_FK' ? 'success' : 'default'}
              sx={{ height: 18, fontSize: '0.6rem' }}
            />
            <IconButton
              size="small"
              onClick={() => onChange(links.filter((_, i) => i !== index))}
            >
              <DeleteOutlineIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Stack>
        ))}
      </Stack>

      {drafting && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
          <FormControl size="small" sx={{ minWidth: 190 }}>
            <InputLabel>Columns on this table</InputLabel>
            <Select
              multiple
              value={draftColumns}
              input={<OutlinedInput label="Columns on this table" />}
              renderValue={selected => selected.join(', ')}
              onChange={e => setDraftColumns(e.target.value as string[])}
              sx={{ fontSize: '0.72rem' }}
            >
              {meta.columns.map(column => (
                <MenuItem key={column.columnName} value={column.columnName} sx={{ fontSize: '0.72rem' }}>
                  {column.columnName}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 190 }}>
            <InputLabel>References</InputLabel>
            <Select
              label="References"
              value={draftParent}
              onChange={e => {
                setDraftParent(e.target.value as string);
                setDraftParentColumns([]);
              }}
              sx={{ fontSize: '0.72rem' }}
            >
              {parents.map(parent => (
                <MenuItem key={tableKeyOf(parent)} value={tableKeyOf(parent)} sx={{ fontSize: '0.72rem' }}>
                  {tableKeyOf(parent)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 190 }} disabled={!parentMeta}>
            <InputLabel>On parent columns</InputLabel>
            <Select
              multiple
              value={draftParentColumns}
              input={<OutlinedInput label="On parent columns" />}
              renderValue={selected =>
                selected.length === 0 ? 'primary key' : (selected as string[]).join(', ')
              }
              onChange={e => setDraftParentColumns(e.target.value as string[])}
              sx={{ fontSize: '0.72rem' }}
            >
              {(parentMeta?.columns || []).map(column => (
                <MenuItem key={column.columnName} value={column.columnName} sx={{ fontSize: '0.72rem' }}>
                  {column.columnName}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Button size="small" variant="contained" disabled={!draftValid} onClick={commitDraft}>
            Add
          </Button>
          <Button size="small" onClick={resetDraft}>
            Cancel
          </Button>

          {parentMeta && (
            <Typography variant="caption" color="text.secondary" sx={{ width: '100%' }}>
              Leave the parent columns empty for its primary key. Unique keys on{' '}
              {draftParent}:{' '}
              {parentMeta.uniqueKeys.length > 0
                ? parentMeta.uniqueKeys.map(k => `(${k.columns.join(', ')})`).join(' ')
                : 'none — a link needs one'}
            </Typography>
          )}

          {draftColumns.length > 0 &&
            draftParentColumns.length > 0 &&
            draftParentColumns.length !== draftColumns.length && (
              <Alert severity="warning" sx={{ width: '100%', py: 0, fontSize: '0.72rem' }}>
                Both sides must name the same number of columns.
              </Alert>
            )}
        </Stack>
      )}

      {!drafting && (
        <Button size="small" startIcon={<AddIcon />} sx={{ mt: 0.5 }} onClick={() => setDrafting(true)}>
          Add link
        </Button>
      )}

      {suggestions.length > 0 && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary">
            Foreign keys found in the database, not yet linked
          </Typography>
          <Stack spacing={0.25} sx={{ mt: 0.25 }}>
            {suggestions.map(suggestion => (
              <Stack
                key={`${suggestion.columns.join()}-${parentKeyOf(suggestion)}`}
                direction="row"
                alignItems="center"
                spacing={1}
              >
                <Tooltip title="Rewrite these columns to the parent's new row">
                  <Typography variant="body2" sx={{ ...mono, flex: 1 }} noWrap>
                    {describeLink(suggestion)}
                  </Typography>
                </Tooltip>
                <Button size="small" onClick={() => addLink(suggestion)}>
                  Link
                </Button>
              </Stack>
            ))}
          </Stack>
        </Box>
      )}
    </Paper>
  );
};

export default TableLinksEditor;
