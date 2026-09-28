import { describe, expect, it } from 'vitest';
import { splitSqlStatements, tokenizeSql } from './SqlHighlight';

describe('splitSqlStatements', () => {
  it('splits on top-level semicolons and drops the separators', () => {
    expect(splitSqlStatements("UPDATE a SET x = 1; DELETE FROM b;")).toEqual([
      'UPDATE a SET x = 1',
      'DELETE FROM b',
    ]);
  });

  it('keeps a lone statement, trailing semicolon and all', () => {
    expect(splitSqlStatements('SELECT 1;')).toEqual(['SELECT 1']);
    expect(splitSqlStatements('  SELECT 1  ')).toEqual(['SELECT 1']);
  });

  // The whole reason this doesn't just call String.split(';').
  it('ignores semicolons inside strings, comments and dollar-quoted bodies', () => {
    expect(splitSqlStatements("UPDATE a SET note = 'x;y' WHERE id = 1")).toEqual([
      "UPDATE a SET note = 'x;y' WHERE id = 1",
    ]);
    expect(splitSqlStatements('SELECT 1 -- drop this; and this\n')).toEqual([
      'SELECT 1 -- drop this; and this',
    ]);
    expect(splitSqlStatements('SELECT 1 /* a; b */ FROM t')).toEqual([
      'SELECT 1 /* a; b */ FROM t',
    ]);
    expect(splitSqlStatements("DO $$ BEGIN PERFORM 1; END $$")).toEqual([
      'DO $$ BEGIN PERFORM 1; END $$',
    ]);
  });

  it('drops empty statements', () => {
    expect(splitSqlStatements(';;\n SELECT 1 ;; SELECT 2 ;')).toEqual(['SELECT 1', 'SELECT 2']);
    expect(splitSqlStatements('   ')).toEqual([]);
  });
});

describe('tokenizeSql', () => {
  it('reproduces the input exactly, so nothing is lost when rendering', () => {
    const sql = "UPDATE rides SET status = 'X' -- note\nWHERE n > 12.5 AND \"Col\" IS NULL;";
    expect(tokenizeSql(sql).map((t) => t.text).join('')).toBe(sql);
  });

  it('classifies keywords, strings, numbers and comments', () => {
    const kinds = new Map(tokenizeSql("SELECT 'a' -- c\nFROM t WHERE n = 3").map((t) => [t.text.trim(), t.kind]));
    expect(kinds.get('SELECT')).toBe('keyword');
    expect(kinds.get("'a'")).toBe('string');
    expect(kinds.get('-- c')).toBe('comment');
    expect(kinds.get('3')).toBe('number');
  });
});
