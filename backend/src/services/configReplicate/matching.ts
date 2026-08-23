import { canonical, valuesEqual } from './values';

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

  const scores: number[][] = baseRows.map(baseRow =>
    targetRows.map(targetRow => {
      let score = 0;
      for (const column of compareColumns) {
        if (valuesEqual(baseRow[column], targetRow[column], udtMap[column])) score++;
      }
      return score;
    })
  );

  const bestForBase = scores.map(strictBest);
  const bestForTarget = targetRows.map((_, j) => strictBest(scores.map(row => row[j])));

  const pairedTarget = new Set<number>();

  for (let i = 0; i < baseRows.length; i++) {
    const baseRow = baseRows[i];
    const best = bestForBase[i];

    if (!best) {
      result.unpairedBase.push(baseRow);
      const hadAnyOverlap = scores[i].some(s => s > 0);
      if (hadAnyOverlap) {
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
    if (scores.some(row => row[j] > 0)) {
      result.ambiguousTarget.add(targetRow);
      result.ambiguityReasons.set(
        targetRow,
        'Partially matches a row under the base dimension but was not a mutual best match'
      );
    }
  }

  return result;
};
