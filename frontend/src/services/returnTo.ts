/**
 * Where to send someone once they've logged in.
 *
 * The console is a single route whose active page lives in the store rather
 * than the path, so the only thing worth carrying across a login is the URL
 * itself — which is enough, because the part that matters (a `?request=` deep
 * link) rides in its query string.
 *
 * Carried as a query param rather than router state so it survives the two
 * things that drop state: the response interceptor's hard redirect on an
 * expired session, and a reload of the login page itself.
 */
export const RETURN_TO_PARAM = 'next';

/**
 * Only same-origin, path-relative destinations are accepted. `//evil.example`
 * is a protocol-relative URL, so testing for a leading slash alone would hand
 * an attacker an open redirect through a link anyone can craft.
 */
export const safeReturnTo = (value: string | null | undefined): string | null =>
  value && value.startsWith('/') && !value.startsWith('//') ? value : null;

/**
 * The current URL as a return destination, or null when there's nothing worth
 * returning to — the login page itself, or the bare console, which is where an
 * unadorned login lands anyway.
 */
export const currentReturnTo = (): string | null => {
  if (window.location.pathname.startsWith('/login')) return null;
  const here = `${window.location.pathname}${window.location.search}`;
  return here === '/' ? null : safeReturnTo(here);
};

/** The login URL that comes back to `returnTo` afterwards. */
export const loginPathFor = (returnTo: string | null): string => {
  const safe = safeReturnTo(returnTo);
  return safe ? `/login?${RETURN_TO_PARAM}=${encodeURIComponent(safe)}` : '/login';
};

export const readReturnTo = (search: string): string | null =>
  safeReturnTo(new URLSearchParams(search).get(RETURN_TO_PARAM));
