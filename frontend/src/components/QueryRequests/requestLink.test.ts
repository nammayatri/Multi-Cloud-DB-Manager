import { describe, it, expect } from 'vitest';
import { readRequestLink, requestLinkFor } from './requestLink';

const GROUP_ID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('requestLink', () => {
  it('round-trips a group id through a link', () => {
    const link = requestLinkFor(GROUP_ID);
    expect(readRequestLink(new URL(link).search)).toBe(GROUP_ID);
  });

  it('reads the id whatever else is in the query string', () => {
    expect(readRequestLink(`?next=/x&request=${GROUP_ID}&tab=mine`)).toBe(GROUP_ID);
    expect(readRequestLink(`request=${GROUP_ID}`)).toBe(GROUP_ID);
  });

  it.each([
    ['nothing to read', ''],
    ['another param only', '?next=/somewhere'],
    ['an empty value', '?request='],
  ])('reads no link from %s', (_case, search) => {
    expect(readRequestLink(search)).toBeNull();
  });

  /*
   * A mangled id is passed through rather than swallowed: the API answers 404
   * and the panel explains that the link may have lost characters, which is
   * the thing the reader actually needs to know.
   */
  it.each([
    ['a truncated id', GROUP_ID.slice(0, 20)],
    ['an id with something appended', `${GROUP_ID}.`],
  ])('passes %s through for the API to reject', (_case, raw) => {
    expect(readRequestLink(`?request=${raw}`)).toBe(raw);
  });

  it('points at the console, not at a route of its own', () => {
    expect(new URL(requestLinkFor(GROUP_ID)).pathname).toBe('/');
  });
});
