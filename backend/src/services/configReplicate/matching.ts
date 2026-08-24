import { canonical } from './values';

export const MAX_PAIRWISE = 2_000_000;

export type Row = Record<string, unknown>;

export interface PairingResult {
  pairs: Array<{ base: Row; target: Row }>;
  unpairedBase: Row[];
  unpairedTarget: Row[];
  ambiguousBase: Set<Row>;
  ambiguousTarget: Set<Row>;
  ambiguityReasons: Map<Row, string>;
}

const emptyResult = (): PairingResult => ({
  pairs: [],
  unpairedBase: [],
  unpairedTarget: [],
  ambiguousBase: new Set(),
  ambiguousTarget: new Set(),
  ambiguityReasons: new Map(),
});

const keyOf = (row: Row, keyColumns: string[], udtMap: Record<string, string>): string =>
  JSON.stringify(keyColumns.map(c => canonical(row[c], udtMap[c])));

export const pairByKey = (
  baseRows: Row[],
  targetRows: Row[],
  keyColumns: string[],
  udtMap: Record<string, string>
): PairingResult => {
  const result = emptyResult();

  const index = new Map<string, Row[]>();
  for (const row of targetRows) {
    const k = keyOf(row, keyColumns, udtMap);
    const bucket = index.get(k);
    if (bucket) bucket.push(row);
    else index.set(k, [row]);
  }

  const consumed = new Set<Row>();

  for (const baseRow of baseRows) {
    const bucket = index.get(keyOf(baseRow, keyColumns, udtMap));

    if (!bucket || bucket.length === 0) {
      result.unpairedBase.push(baseRow);
      continue;
    }

    if (bucket.length > 1) {
      result.unpairedBase.push(baseRow);
      result.ambiguousBase.add(baseRow);
      result.ambiguityReasons.set(
        baseRow,
        `${bucket.length} rows under the new dimension share this key -- the key is not unique within the slice`
      );
      for (const row of bucket) {
        result.ambiguousTarget.add(row);
        result.ambiguityReasons.set(row, 'Shares its key with another row under the new dimension');
      }
      continue;
    }

    result.pairs.push({ base: baseRow, target: bucket[0] });
    consumed.add(bucket[0]);
  }

  result.unpairedTarget = targetRows.filter(r => !consumed.has(r));

  return result;
};

interface BestMatch {
  index: number;
  score: number;
}

const strictBest = (scores: number[]): BestMatch | null => {
  let bestIndex = -1;
  let bestScore = 0;
  let tied = false;

  for (let i = 0; i < scores.length; i++) {
    const score = scores[i];
    if (score <= 0) continue;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }

  if (bestIndex === -1 || tied) return null;
  return { index: bestIndex, score: bestScore };
};

interface RunningBest {
  index: number;
  score: number;
  tied: boolean;
}

const commit = (best: RunningBest | null): BestMatch | null =>
  best && !best.tied ? { index: best.index, score: best.score } : null;

const consider = (best: RunningBest | null, index: number, score: number): RunningBest => {
  if (!best || score > best.score) return { index, score, tied: false };
  if (score === best.score) return { ...best, tied: true };
  return best;
};

export const pairByMutualBestMatch = (
  baseRows: Row[],
  targetRows: Row[],
  compareColumns: string[],
  udtMap: Record<string, string>
): PairingResult => {
  const result = emptyResult();

  if (baseRows.length === 0 || targetRows.length === 0) {
    result.unpairedBase = [...baseRows];
    result.unpairedTarget = [...targetRows];
    return result;
  }

  if (baseRows.length * targetRows.length > MAX_PAIRWISE) {
    throw new Error(
      `Similarity matching would need ${baseRows.length * targetRows.length} comparisons ` +
        `(limit ${MAX_PAIRWISE}). Define a unique key for this table or split the group.`
    );
  }

  // Canonicalise once per row rather than once per comparison. Scoring pair
  // (i, j) directly would re-canonicalise row i's every column for all M targets,
  // making it O(N*M*C) string builds; this is O((N+M)*C), and the inner loop
  // becomes a string compare.
  const encode = (rows: Row[]): string[][] =>
    rows.map(row => compareColumns.map(column => canonical(row[column], udtMap[column])));

  const baseKeys = encode(baseRows);
  const targetKeys = encode(targetRows);

  // Running bests rather than a materialised base x target score matrix, so
  // memory is O(N+M) instead of O(N*M).
  const bestForBase: Array<BestMatch | null> = new Array(baseRows.length).fill(null);
  const baseHadOverlap: boolean[] = new Array(baseRows.length).fill(false);
  const targetRunning: Array<RunningBest | null> = new Array(targetRows.length).fill(null);
  const targetHadOverlap: boolean[] = new Array(targetRows.length).fill(false);

  for (let i = 0; i < baseRows.length; i++) {
    const baseRow = baseKeys[i];
    let rowBest: RunningBest | null = null;

    for (let j = 0; j < targetRows.length; j++) {
      const targetRow = targetKeys[j];

      let score = 0;
      for (let c = 0; c < compareColumns.length; c++) {
        if (baseRow[c] === targetRow[c]) score++;
      }
      if (score <= 0) continue;

      baseHadOverlap[i] = true;
      targetHadOverlap[j] = true;
      rowBest = consider(rowBest, j, score);
      targetRunning[j] = consider(targetRunning[j], i, score);
    }

    bestForBase[i] = commit(rowBest);
  }

  const bestForTarget = targetRunning.map(commit);
  const pairedTarget = new Set<number>();

  for (let i = 0; i < baseRows.length; i++) {
    const baseRow = baseRows[i];
    const best = bestForBase[i];

    if (!best) {
      result.unpairedBase.push(baseRow);
      if (baseHadOverlap[i]) {
        result.ambiguousBase.add(baseRow);
        result.ambiguityReasons.set(
          baseRow,
          'Several rows under the new dimension match this one equally well'
        );
      }
      continue;
    }

    const reciprocal = bestForTarget[best.index];
    if (reciprocal && reciprocal.index === i) {
      result.pairs.push({ base: baseRow, target: targetRows[best.index] });
      pairedTarget.add(best.index);
    } else {
      result.unpairedBase.push(baseRow);
      result.ambiguousBase.add(baseRow);
      result.ambiguityReasons.set(
        baseRow,
        'Its closest row under the new dimension is a closer match for a different row'
      );
    }
  }

  for (let j = 0; j < targetRows.length; j++) {
    if (pairedTarget.has(j)) continue;
    const targetRow = targetRows[j];
    result.unpairedTarget.push(targetRow);
    if (targetHadOverlap[j]) {
      result.ambiguousTarget.add(targetRow);
      result.ambiguityReasons.set(
        targetRow,
        'Partially matches a row under the base dimension but was not a mutual best match'
      );
    }
  }

  return result;
};
