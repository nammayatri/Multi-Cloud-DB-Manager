import path from 'path';
import logger from '../../utils/logger';
import { LiteDiffDirectory, LiteDiffFile, LiteDiffResult, LiteFileKind, LiteStatement } from '../../types/migrations';
import { getConfig } from './migrations.service';
import { getChangedFiles, getFileContent, getFileContentOrEmpty, getMergeBase, fetchRefs, pullLatest } from './git.service';
import { splitStatements, addedStatements, classifyStatement } from './sql-parser.service';
import { parseCompareURL, assertRepoMatchesConfig } from './compare-url.service';
import QueryValidator from '../query/QueryValidator';

const MAX_MIGRATION_FILES = 5000;
const SQL_EXTENSION = '.sql';

/**
 * Collapse the parser's three-way classification into the binary the runner
 * cares about. Only DDL is schema change; DML and everything else (procedural
 * blocks, GRANTs, unrecognized statements) is grouped as NON_DDL so that
 * "run only the DDL" cannot silently include a data-touching statement.
 */
function toLiteStatement(sql: string, defaultSchema: string): LiteStatement {
  const parsed = classifyStatement(sql, defaultSchema);
  return {
    sql: parsed.sql.replace(/;+\s*$/, ''),
    type: parsed.type === 'DDL' || isUnclassifiedDdl(parsed) ? 'DDL' : 'NON_DDL',
    operation: parsed.operation,
    objectName: parsed.objectName,
    // Same rule the execute endpoint enforces, so the UI cannot drift from it.
    dangerous: QueryValidator.requiresPasswordVerification(parsed.sql) !== null,
  };
}

/**
 * The shared classifier recognizes specific DDL shapes and files anything else
 * under OTHER — so genuine schema changes it has no branch for (ALTER TABLE ...
 * RENAME COLUMN, CREATE FUNCTION, DROP TABLE) arrive as OTHER/UNKNOWN and would
 * be mislabelled as data changes.
 *
 * Recover those structurally, by the leading schema verb. `DO $$` blocks are
 * deliberately excluded: their body is opaque and may perform DML, so they stay
 * NON_DDL rather than being swept into a "DDL only" run.
 */
function isUnclassifiedDdl(parsed: { type: string; sql: string }): boolean {
  if (parsed.type !== 'OTHER') return false;

  const clean = parsed.sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();

  if (/^\s*DO\s+\$/i.test(clean)) return false;

  return /^\s*(ALTER|CREATE|DROP)\s+/i.test(clean);
}

function fileKind(ddlCount: number, nonDdlCount: number): LiteFileKind {
  if (nonDdlCount === 0) return 'DDL';
  if (ddlCount === 0) return 'NON_DDL';
  return 'MIXED';
}

/**
 * Resolve a GitHub compare URL into the SQL statements it introduces, grouped
 * by directory and ready to run.
 *
 * Unlike `analyze()`, this does no database work at all: no replica pools, no
 * applied/pending verification. It is purely "what SQL does this range add".
 * The target database is chosen by the user in the UI, so `pathMapping` is
 * deliberately not consulted for routing here.
 */
export async function getLiteDiff(compareUrl: string): Promise<LiteDiffResult> {
  const config = getConfig();

  const parsed = parseCompareURL(compareUrl);
  assertRepoMatchesConfig(parsed, config.repoUrl);

  const { base, head } = parsed;

  // A compare URL may name commits this clone has never seen.
  pullLatest(config.repoPath);
  fetchRefs(config.repoPath, [base, head]);

  // Three-dot semantics: everything `head` added since it diverged from `base`.
  // The per-file baseline must use the SAME merge-base as the changed-file
  // list, or a file could report statements the range did not introduce.
  const baseRef = getMergeBase(config.repoPath, base, head);

  const changedFiles = getChangedFiles(config.repoPath, undefined, base, head)
    .filter(filePath => filePath.toLowerCase().endsWith(SQL_EXTENSION));

  if (changedFiles.length > MAX_MIGRATION_FILES) {
    throw new Error(
      `Too many SQL files (${changedFiles.length}). Maximum is ${MAX_MIGRATION_FILES}. Use a narrower commit range.`
    );
  }

  logger.info('Lite migration diff started', {
    owner: parsed.owner,
    repo: parsed.repo,
    base,
    head,
    sqlFiles: changedFiles.length,
  });

  const byDirectory = new Map<string, LiteDiffFile[]>();
  let totalStatements = 0;

  for (const filePath of changedFiles) {
    const content = getFileContent(config.repoPath, head, filePath);
    const baseContent = getFileContentOrEmpty(config.repoPath, baseRef, filePath);
    const statements = addedStatements(splitStatements(content), baseContent);

    // A file can appear in the diff with no NEW statements — reformatting, or
    // changes that canonicalize to something already present. Nothing to run.
    if (statements.length === 0) continue;

    const directory = path.dirname(filePath);

    // The runner picks its own target database, so there is no pathMapping
    // schema to use here. Statement classification only needs a default schema
    // to qualify bare object names, which does not affect the DDL/non-DDL call.
    const classified = statements.map(s => toLiteStatement(s, 'public'));
    const ddlCount = classified.filter(s => s.type === 'DDL').length;
    const nonDdlCount = classified.length - ddlCount;
    const dangerousCount = classified.filter(s => s.dangerous).length;

    const file: LiteDiffFile = {
      path: filePath,
      directory,
      filename: path.basename(filePath),
      statementCount: classified.length,
      ddlCount,
      nonDdlCount,
      dangerousCount,
      kind: fileKind(ddlCount, nonDdlCount),
      statements: classified,
      sql: classified.map(s => s.sql).join(';\n\n') + ';',
    };

    totalStatements += classified.length;

    const bucket = byDirectory.get(directory);
    if (bucket) {
      bucket.push(file);
    } else {
      byDirectory.set(directory, [file]);
    }
  }

  // Deterministic order: git's output order is not stable enough to run
  // migrations by, and users select from this list.
  const directories: LiteDiffDirectory[] = [...byDirectory.entries()]
    .map(([directory, files]) => ({
      directory,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      statementCount: files.reduce((sum, f) => sum + f.statementCount, 0),
      ddlCount: files.reduce((sum, f) => sum + f.ddlCount, 0),
    }))
    .sort((a, b) => a.directory.localeCompare(b.directory));

  const totalFiles = directories.reduce((sum, d) => sum + d.files.length, 0);
  const totalDdlStatements = directories.reduce((sum, d) => sum + d.ddlCount, 0);
  const totalDangerousStatements = directories.reduce(
    (sum, d) => sum + d.files.reduce((n, f) => n + f.dangerousCount, 0), 0
  );

  logger.info('Lite migration diff complete', { totalFiles, totalStatements, totalDdlStatements });

  return {
    success: true,
    owner: parsed.owner,
    repo: parsed.repo,
    base,
    head,
    totalFiles,
    totalStatements,
    totalDdlStatements,
    totalDangerousStatements,
    directories,
  };
}
