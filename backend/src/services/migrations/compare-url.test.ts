import { describe, it, expect } from 'vitest';
import { parseCompareURL, assertRepoMatchesConfig, parseRepoIdentity } from './compare-url.service';

const NY = 'https://github.com/nammayatri/nammayatri';

describe('parseCompareURL', () => {
  it('parses a three-dot SHA range', () => {
    expect(parseCompareURL(`${NY}/compare/ba9ab77...4165b9a`)).toEqual({
      owner: 'nammayatri',
      repo: 'nammayatri',
      base: 'ba9ab77',
      head: '4165b9a',
    });
  });

  it('parses a two-dot range', () => {
    const r = parseCompareURL(`${NY}/compare/main..feature`);
    expect(r.base).toBe('main');
    expect(r.head).toBe('feature');
  });

  // The regex this replaces matched the base as [^.]+, which truncates any
  // dotted tag — exactly the shape a release range has.
  it('parses dotted version tags on both sides', () => {
    expect(parseCompareURL(`${NY}/compare/v1.2.3...v1.3.0`)).toMatchObject({
      base: 'v1.2.3',
      head: 'v1.3.0',
    });
  });

  it('parses a dotted tag against a slashed branch name', () => {
    expect(parseCompareURL(`${NY}/compare/v1.2.3...feat/lite-runner`)).toMatchObject({
      base: 'v1.2.3',
      head: 'feat/lite-runner',
    });
  });

  it('splits on the last separator so a slashed base survives', () => {
    expect(parseCompareURL(`${NY}/compare/release/v1...release/v2`)).toMatchObject({
      base: 'release/v1',
      head: 'release/v2',
    });
  });

  it('ignores a trailing slash, query string and fragment', () => {
    expect(parseCompareURL(`${NY}/compare/a1b2c3...d4e5f6/`)).toMatchObject({ head: 'd4e5f6' });
    expect(parseCompareURL(`${NY}/compare/a1b2c3...d4e5f6?expand=1`)).toMatchObject({ head: 'd4e5f6' });
    expect(parseCompareURL(`${NY}/compare/a1b2c3...d4e5f6#files`)).toMatchObject({ head: 'd4e5f6' });
  });

  it('accepts surrounding whitespace from a paste', () => {
    expect(parseCompareURL(`  ${NY}/compare/a...b  `)).toMatchObject({ base: 'a', head: 'b' });
  });

  it.each([
    ['not a url', 'hello world'],
    ['a non-compare github url', `${NY}/pull/123`],
    ['a non-github host', 'https://gitlab.com/o/r/compare/a...b'],
    ['a missing head ref', `${NY}/compare/main...`],
    ['a missing base ref', `${NY}/compare/...main`],
    ['no range separator', `${NY}/compare/main`],
  ])('rejects %s', (_label, url) => {
    expect(() => parseCompareURL(url)).toThrow();
  });

  it('rejects refs containing shell metacharacters', () => {
    expect(() => parseCompareURL(`${NY}/compare/main...a;rm -rf x`)).toThrow();
    expect(() => parseCompareURL(`${NY}/compare/main...$(whoami)`)).toThrow();
  });
});

describe('parseRepoIdentity', () => {
  it('reads the https clone form', () => {
    expect(parseRepoIdentity('https://github.com/nammayatri/nammayatri.git'))
      .toEqual({ owner: 'nammayatri', repo: 'nammayatri' });
  });

  it('reads the token-credential form used in deployments', () => {
    expect(parseRepoIdentity('https://x-access-token:ghp_secret@github.com/nammayatri/nammayatri.git'))
      .toEqual({ owner: 'nammayatri', repo: 'nammayatri' });
  });

  it('reads the scp-style ssh form', () => {
    expect(parseRepoIdentity('git@github.com:nammayatri/nammayatri.git'))
      .toEqual({ owner: 'nammayatri', repo: 'nammayatri' });
  });
});

describe('assertRepoMatchesConfig', () => {
  const parsed = { owner: 'nammayatri', repo: 'nammayatri', base: 'a', head: 'b' };

  it('accepts a URL for the configured repo', () => {
    expect(() => assertRepoMatchesConfig(parsed, `${NY}.git`)).not.toThrow();
  });

  it('is case-insensitive', () => {
    expect(() => assertRepoMatchesConfig(parsed, 'https://github.com/NammaYatri/NammaYatri.git')).not.toThrow();
  });

  it('rejects a URL for a different repo', () => {
    expect(() => assertRepoMatchesConfig(parsed, 'https://github.com/someone/other.git'))
      .toThrow(/configured for someone\/other/);
  });

  it('is a no-op when no repo URL is configured', () => {
    expect(() => assertRepoMatchesConfig(parsed, undefined)).not.toThrow();
  });
});
