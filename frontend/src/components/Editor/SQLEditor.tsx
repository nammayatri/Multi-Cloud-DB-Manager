import { Editor } from '@monaco-editor/react';
import { Box, Paper, Button, Stack, Typography, IconButton, Tooltip } from '@mui/material';
import FormatAlignLeftIcon from '@mui/icons-material/FormatAlignLeft';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useAppStore } from '../../store/appStore';
import type { editor } from 'monaco-editor';
import { KeyMod, KeyCode } from 'monaco-editor';
import { format } from 'sql-formatter';
import toast from 'react-hot-toast';
import { useAutoSave } from '../../hooks/useAutoSave';
import { formatDistanceToNow } from 'date-fns';

const SQLEditor = () => {
  const { currentQuery, setCurrentQuery, setEditorInstance, executeQuery } = useAppStore();
  const { lastSaved, isSaving, clearDraft } = useAutoSave();

  const handleEditorDidMount = (editor: editor.IStandaloneCodeEditor) => {
    setEditorInstance(editor);

    // Add Cmd+Enter / Ctrl+Enter keyboard shortcut to execute query
    editor.addCommand(
      KeyMod.CtrlCmd | KeyCode.Enter,
      () => {
        // The appStore's getQueryToExecute() will automatically handle
        // selected text vs full query, so we just call executeQuery()
        if (executeQuery) {
          executeQuery();
        }
      }
    );
  };

  const handleFormatSQL = () => {
    try {
      if (!currentQuery.trim()) {
        toast.error('No query to format');
        return;
      }

      const formatted = format(currentQuery, {
        language: 'postgresql',
        tabWidth: 2,
        keywordCase: 'upper',
        linesBetweenQueries: 2,
      });

      setCurrentQuery(formatted);
      toast.success('SQL formatted successfully');
    } catch (error) {
      toast.error('Failed to format SQL. Check for syntax errors.');
    }
  };

  const getDraftStatus = () => {
    if (isSaving) {
      return 'Saving...';
    }
    if (lastSaved) {
      return `Draft saved ${formatDistanceToNow(lastSaved, { addSuffix: true })}`;
    }
    return null;
  };

  return (
    <Paper elevation={2} sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 1, borderBottom: 1, borderColor: 'divider' }}>
        <Button
          variant="outlined"
          size="small"
          startIcon={<FormatAlignLeftIcon />}
          onClick={handleFormatSQL}
        >
          Format SQL
        </Button>

        <Box sx={{ flexGrow: 1 }} />

        {/* Draft status indicator */}
        {getDraftStatus() && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.75rem' }}>
              {getDraftStatus()}
            </Typography>
            {lastSaved && (
              <Tooltip title="Clear draft">
                <IconButton size="small" onClick={clearDraft} sx={{ p: 0.5 }}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Stack>
        )}
      </Stack>
      <Box sx={{ flexGrow: 1, p: 0, minHeight: 0 }}>
        <Editor
          height="100%"
          defaultLanguage="sql"
          value={currentQuery}
          onChange={(value) => setCurrentQuery(value || '')}
          onMount={handleEditorDidMount}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'on',
            formatOnPaste: true,
            formatOnType: true,
            suggest: {
              showKeywords: true,
              showSnippets: true,
            },
            scrollbar: {
              vertical: 'auto',
              horizontal: 'auto',
              handleMouseWheel: true,
              alwaysConsumeMouseWheel: false,
            },
          }}
        />
      </Box>
    </Paper>
  );
};

export default SQLEditor;
