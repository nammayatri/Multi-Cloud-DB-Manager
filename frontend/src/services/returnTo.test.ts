import { describe, it, expect } from 'vitest';
import { loginPathFor, readReturnTo, safeReturnTo } from './returnTo';

const LINK = '/?request=3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('returnTo', () => {
  it('carries a request link through the login page', () => {
    const loginPath = loginPathFor(LINK);
    expect(readReturnTo(new URL(loginPath, 'http://console.test').search)).toBe(LINK);
  });

  it('sends people to the plain login page when there is nowhere to come back to', () => {
    expect(loginPathFor(null)).toBe('/login');
    expect(loginPathFor('')).toBe('/login');
  });

  // The destination arrives in a URL anyone can craft, so only same-origin
  // paths are accepted. `//host` is protocol-relative — testing for a leading
  // slash alone would be an open redirect.
  it.each([
    ['an absolute URL', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example/steal'],
    ['a scheme-only redirect', 'javascript:alert(1)'],
    ['a bare path', 'somewhere'],
    ['nothing', ''],
  ])('refuses %s', (_case, value) => {
    expect(safeReturnTo(value)).toBeNull();
    expect(loginPathFor(value)).toBe('/login');
    expect(readReturnTo(`?next=${encodeURIComponent(value)}`)).toBeNull();
  });

  it('accepts a same-origin path with its query string', () => {
    expect(safeReturnTo(LINK)).toBe(LINK);
    expect(safeReturnTo('/migrations')).toBe('/migrations');
  });
});
