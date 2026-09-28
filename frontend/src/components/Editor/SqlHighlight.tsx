import { Fragment, memo, useMemo } from 'react';
import { Box } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';

/*
 * Read-only SQL, coloured the way the main editor colours it.
 *
 * Monaco is what the console writes SQL in, so the palette below is its
 * vs-dark one — a query should look the same whether you're typing it in the
 * editor or reading it in someone's approval request. Monaco itself isn't used
 * here: a request list can hold dozens of queries, and each Monaco instance is
 * a web worker and a DOM tree of its own. This is a tokenizer and a few spans.
 */

const KEYWORDS = new Set([
  'ADD', 'ALL', 'ALTER', 'AND', 'ANY', 'AS', 'ASC', 'BEGIN', 'BETWEEN', 'BY', 'CASCADE', 'CASE',
  'CAST', 'CHECK', 'COLUMN', 'COMMIT', 'CONFLICT', 'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT',
  'DATABASE', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DO', 'DROP', 'ELSE', 'END', 'EXCEPT',
  'EXISTS', 'EXPLAIN', 'FALSE', 'FETCH', 'FILTER', 'FOR', 'FOREIGN', 'FROM', 'FULL', 'GRANT',
  'GROUP', 'HAVING', 'IF', 'ILIKE', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS',
  'JOIN', 'KEY', 'LATERAL', 'LEFT', 'LIKE', 'LIMIT', 'MATERIALIZED', 'NOT', 'NOTHING', 'NULL',
  'NULLS', 'OFFSET', 'ON', 'ONLY', 'OR', 'ORDER', 'OUTER', 'OVER', 'PARTITION', 'PRIMARY',
  'REFERENCES', 'REFRESH', 'RENAME', 'REPLACE', 'RESTRICT', 'RETURNING', 'REVOKE', 'RIGHT',
  'ROLLBACK', 'ROW', 'ROWS', 'SCHEMA', 'SELECT', 'SET', 'TABLE', 'TEMP', 'TEMPORARY', 'THEN',
  'TO', 'TRANSACTION', 'TRIGGER', 'TRUE', 'TRUNCATE', 'UNION', 'UNIQUE', 'UNLOGGED', 'UPDATE',
  'USING', 'VACUUM', 'VALUES', 'VIEW', 'WHEN', 'WHERE', 'WINDOW', 'WITH', 'WITHIN',
]);

const TYPES = new Set([
  'BIGINT', 'BOOL', 'BOOLEAN', 'BYTEA', 'CHAR', 'DATE', 'DECIMAL', 'DOUBLE', 'FLOAT', 'INT',
  'INT2', 'INT4', 'INT8', 'INTEGER', 'INTERVAL', 'JSON', 'JSONB', 'NUMERIC', 'REAL', 'SERIAL',
  'SMALLINT', 'TEXT', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'UUID', 'VARCHAR',
]);

const FUNCTIONS = new Set([
  'ABS', 'ARRAY_AGG', 'AVG', 'CEIL', 'COALESCE', 'CONCAT', 'COUNT', 'DATE_TRUNC', 'EXTRACT',
  'FLOOR', 'GEN_RANDOM_UUID', 'GREATEST', 'JSONB_BUILD_OBJECT', 'LEAST', 'LENGTH', 'LOWER',
  'MAX', 'MIN', 'NOW', 'NULLIF', 'ROUND', 'ROW_NUMBER', 'SUM', 'TO_CHAR', 'TO_TIMESTAMP',
  'TRIM', 'UPPER',
]);

/** Monaco vs-dark. */
const COLORS = {
  keyword: '#569CD6',
  type: '#4EC9B0',
  function: '#DCDCAA',
  string: '#CE9178',
  number: '#B5CEA8',
  comment: '#6A9955',
  identifier: '#9CDCFE',
  plain: '#D4D4D4',
} as const;

type TokenKind = keyof typeof COLORS;

interface Token {
  text: string;
  kind: TokenKind;
}

/*
 * Order matters: comments and strings swallow whatever is inside them, so they
 * come first and a stray keyword in a comment stays a comment.
 */
const TOKEN_RE = new RegExp(
  [
    '(--[^\\n]*|/\\*[\\s\\S]*?\\*/)',            // 1 comment
    "('(?:''|\\\\.|[^'])*'|\\$\\$[\\s\\S]*?\\$\\$)", // 2 string / dollar-quoted body
    '("(?:""|[^"])*")',                          // 3 quoted identifier
    '(\\b\\d+(?:\\.\\d+)?\\b)',                  // 4 number
    '([A-Za-z_][A-Za-z_0-9$]*)',                 // 5 word
  ].join('|'),
  'g'
);

/** Beyond this a request is a data dump, not something anyone reads coloured. */
const MAX_HIGHLIGHT_CHARS = 40000;

export const tokenizeSql = (sql: string): Token[] => {
  if (sql.length > MAX_HIGHLIGHT_CHARS) return [{ text: sql, kind: 'plain' }];

  const tokens: Token[] = [];
  let lastIndex = 0;

  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN_RE.exec(sql)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: sql.slice(lastIndex, match.index), kind: 'plain' });
    }

    const [text, comment, string, quoted, number, word] = match;

    if (comment) tokens.push({ text, kind: 'comment' });
    else if (string) tokens.push({ text, kind: 'string' });
    else if (quoted) tokens.push({ text, kind: 'identifier' });
    else if (number) tokens.push({ text, kind: 'number' });
    else if (word) {
      const upper = word.toUpperCase();
      tokens.push({
        text,
        kind: KEYWORDS.has(upper)
          ? 'keyword'
          : TYPES.has(upper)
            ? 'type'
            : FUNCTIONS.has(upper)
              ? 'function'
              : 'plain',
      });
    }

    lastIndex = match.index + text.length;
  }

  if (lastIndex < sql.length) tokens.push({ text: sql.slice(lastIndex), kind: 'plain' });

  return tokens;
};

/**
 * Split SQL into its statements, on top-level semicolons only.
 *
 * Shares the lexer above, so a semicolon inside a string literal, a comment or
 * a $$ … $$ body doesn't end a statement — which is exactly what a plain
 * `sql.split(';')` gets wrong, and it gets it wrong on the kind of query
 * people ask approval for ('…;…' in a WHERE, a commented-out clause).
 *
 * Separators are dropped and each statement is trimmed; empty ones (a trailing
 * `;`, a stray `;;`) fall out.
 */
export const splitSqlStatements = (sql: string): string[] => {
  const statements: string[] = [];
  let current = '';

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = '';
  };

  for (const token of tokenizeSql(sql)) {
    // Only unquoted, uncommented text can hold a separator.
    if (token.kind !== 'plain' || !token.text.includes(';')) {
      current += token.text;
      continue;
    }

    const pieces = token.text.split(';');
    pieces.forEach((piece, index) => {
      current += piece;
      if (index < pieces.length - 1) flush();
    });
  }

  flush();
  return statements;
};

/** Coloured spans and nothing else — the caller owns the layout. */
export const SqlText = memo(({ sql }: { sql: string }) => {
  const tokens = useMemo(() => tokenizeSql(sql), [sql]);

  return (
    <>
      {tokens.map((token, index) => (
        <Fragment key={index}>
          {token.kind === 'plain' ? (
            token.text
          ) : (
            <Box component="span" sx={{ color: COLORS[token.kind] }}>
              {token.text}
            </Box>
          )}
        </Fragment>
      ))}
    </>
  );
});

interface SqlBlockProps {
  sql: string;
  /** Scrolls past this, like the editor does. */
  maxHeight?: number | string;
  sx?: SxProps<Theme>;
}

/**
 * A query as a block: monospaced, coloured, on the editor's darker surface.
 *
 * Shows the SQL exactly as stored — no re-formatting. What an approver reads
 * has to be the bytes that run, since the hash pin is checked against them.
 */
export const SqlBlock = ({ sql, maxHeight = 320, sx }: SqlBlockProps) => (
  <Box
    sx={{
      maxHeight,
      overflow: 'auto',
      bgcolor: 'rgba(255,255,255,0.04)',
      border: '1px solid',
      borderColor: 'divider',
      borderRadius: 1,
      p: 2,
      ...sx,
    }}
  >
    <Box
      component="pre"
      sx={{
        m: 0,
        fontFamily: 'monospace',
        // The query is the thing being judged in a request, so it's set near
        // the main editor's own size (Monaco runs at 14px) rather than at the
        // footnote size a code sample gets. Not above it: the fallback
        // monospace face renders soft at 16px.
        fontSize: '0.9rem',
        lineHeight: 1.55,
        color: COLORS.plain,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      <SqlText sql={sql} />
    </Box>
  </Box>
);

