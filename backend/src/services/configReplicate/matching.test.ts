import { describe, it, expect } from 'vitest';
import { MAX_PAIRWISE, pairByKey, pairByMutualBestMatch } from './matching';

const udt = { key: 'text', name: 'text', value: 'text', extra: 'text' };

describe('pairByKey', () => {
  it('pairs rows sharing the key and leaves the rest unpaired', () => {
    const base = [{ key: 'a', value: '1' }, { key: 'b', value: '2' }];
    const target = [{ key: 'a', value: '9' }, { key: 'c', value: '3' }];

    const result = pairByKey(base, target, ['key'], udt);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].base.key).toBe('a');
    expect(result.unpairedBase.map(r => r.key)).toEqual(['b']);
    expect(result.unpairedTarget.map(r => r.key)).toEqual(['c']);
  });

  it('matches on a composite key', () => {
    const base = [{ key: 'a', name: 'x', value: '1' }];
    const target = [{ key: 'a', name: 'y', value: '2' }, { key: 'a', name: 'x', value: '3' }];

    const result = pairByKey(base, target, ['key', 'name'], udt);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].target.value).toBe('3');
  });

  it('treats a duplicated key in the target slice as ambiguous rather than mispairing', () => {
    const base = [{ key: 'a', value: '1' }];
    const target = [{ key: 'a', value: '2' }, { key: 'a', value: '3' }];

    const result = pairByKey(base, target, ['key'], udt);

    expect(result.pairs).toHaveLength(0);
    expect(result.unpairedBase).toHaveLength(1);
    expect(result.ambiguousBase.has(base[0])).toBe(true);
    expect(result.unpairedTarget).toHaveLength(2);
    expect(result.ambiguousTarget.size).toBe(2);
  });

  it('pairs on a NULL key value', () => {
    const base = [{ key: null, value: '1' }];
    const target = [{ key: null, value: '2' }];

    const result = pairByKey(base, target, ['key'], udt);

    expect(result.pairs).toHaveLength(1);
  });
});

describe('pairByMutualBestMatch', () => {
  const columns = ['name', 'value', 'extra'];

  it('pairs a clear mutual best match', () => {
    const base = [{ name: 'a', value: '1', extra: 'z' }];
    const target = [
      { name: 'a', value: '1', extra: 'different' },
      { name: 'unrelated', value: 'unrelated', extra: 'unrelated' },
    ];

    const result = pairByMutualBestMatch(base, target, columns, udt);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].target.name).toBe('a');
    expect(result.unpairedTarget).toHaveLength(1);
  });

  it('refuses to pair when two candidates tie', () => {
    const base = [{ name: 'a', value: '1', extra: 'z' }];
    const target = [
      { name: 'a', value: 'x', extra: 'x' },
      { name: 'a', value: 'y', extra: 'y' },
    ];

    const result = pairByMutualBestMatch(base, target, columns, udt);

    expect(result.pairs).toHaveLength(0);
    expect(result.ambiguousBase.has(base[0])).toBe(true);
    expect(result.unpairedBase).toHaveLength(1);
    expect(result.unpairedTarget).toHaveLength(2);
  });

  it('refuses to pair when the best match is not reciprocal', () => {
    const base = [
      { name: 'a', value: '1', extra: 'q' },
      { name: 'a', value: '1', extra: 'r' },
    ];
    const target = [{ name: 'a', value: '1', extra: 'r' }];

    const result = pairByMutualBestMatch(base, target, columns, udt);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].base.extra).toBe('r');
    expect(result.unpairedBase).toHaveLength(1);
    expect(result.ambiguousBase.has(base[0])).toBe(true);
  });

  it('never pairs rows with nothing in common', () => {
    const base = [{ name: 'a', value: '1', extra: 'q' }];
    const target = [{ name: 'b', value: '2', extra: 'r' }];

    const result = pairByMutualBestMatch(base, target, columns, udt);

    expect(result.pairs).toHaveLength(0);
    expect(result.ambiguousBase.size).toBe(0);
    expect(result.unpairedBase).toHaveLength(1);
    expect(result.unpairedTarget).toHaveLength(1);
  });

  it('handles an empty side without pairing anything', () => {
    const result = pairByMutualBestMatch([{ name: 'a', value: '1', extra: 'q' }], [], columns, udt);
    expect(result.pairs).toHaveLength(0);
    expect(result.unpairedBase).toHaveLength(1);
  });

  it('refuses a comparison set above the pairwise cap', () => {
    const size = Math.ceil(Math.sqrt(MAX_PAIRWISE)) + 1;
    const rows = Array.from({ length: size }, (_, i) => ({ name: `n${i}`, value: '1', extra: 'q' }));

    expect(() => pairByMutualBestMatch(rows, rows, columns, udt)).toThrow(/Similarity matching/);
  });
});

describe('pairByKey with an empty match key', () => {
  // A table whose primary key is the dimension column alone holds exactly one
  // row per dimension value, so the two rows pair without comparing anything.
  it('pairs the single row on each side', () => {
    const base = [{ city_id: 1, a: 'x' }];
    const target = [{ city_id: 2, a: 'totally different' }];

    const result = pairByKey(base, target, [], { city_id: 'int4', a: 'text' });

    expect(result.pairs).toHaveLength(1);
    expect(result.unpairedBase).toHaveLength(0);
    expect(result.unpairedTarget).toHaveLength(0);
  });

  it('reports nothing to pair when the new dimension has no row yet', () => {
    const result = pairByKey([{ city_id: 1 }], [], [], { city_id: 'int4' });
    expect(result.pairs).toHaveLength(0);
    expect(result.unpairedBase).toHaveLength(1);
  });

  it('flags ambiguity if the target somehow holds more than one row', () => {
    const result = pairByKey(
      [{ city_id: 1 }],
      [{ city_id: 2, a: 1 }, { city_id: 2, a: 2 }],
      [],
      { city_id: 'int4', a: 'int4' }
    );
    expect(result.pairs).toHaveLength(0);
    expect(result.ambiguousTarget.size).toBe(2);
  });
});
