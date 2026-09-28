/**
 * Shareable links to one query request.
 *
 * A request lives at `/?request=<groupId>` rather than at a route of its own:
 * the console is a single page whose active tab is store state, not a path, so
 * a query param is the one piece of URL that can carry an intent into it
 * without teaching every tab to round-trip through the router.
 *
 * The id is the GROUP id, never a query id. A request is always a group — of
 * one query in the common case — and a link should open the whole request, the
 * same way the list renders it.
 */
export const REQUEST_LINK_PARAM = 'request';

/**
 * Whatever the link carries, handed on as-is.
 *
 * Deliberately not validated against a UUID shape. A link mangled in transit —
 * chat clients love to eat trailing characters — is exactly the case worth
 * reporting, and the API's 404 already produces a far better message than
 * silence ("may point at a different environment, or have lost characters on
 * its way here"). Rejecting it here made that failure invisible: nothing
 * opened, and the param wasn't even cleared from the URL.
 */
export const readRequestLink = (search: string): string | null =>
  new URLSearchParams(search).get(REQUEST_LINK_PARAM) || null;

export const requestLinkFor = (groupId: string): string =>
  `${window.location.origin}/?${REQUEST_LINK_PARAM}=${encodeURIComponent(groupId)}`;

/**
 * The same query string with the link taken out of it.
 *
 * A link is an instruction, and it has been carried out the moment the request
 * is on screen — leaving it in the address bar means every later reload drags
 * you back to it, however far you had moved on. Anything else in the query
 * string is none of this function's business and is left alone.
 */
export const searchWithoutRequestLink = (search: string): string => {
  const params = new URLSearchParams(search);
  params.delete(REQUEST_LINK_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
};

/**
 * Copy a request's link to the clipboard.
 *
 * `navigator.clipboard` needs a secure context, which a console served over
 * plain HTTP on an internal host is not — exactly the deployment most likely to
 * be running this. So fall back to the old selection trick rather than have the
 * button quietly do nothing there.
 */
export const copyRequestLink = async (groupId: string): Promise<boolean> => {
  const link = requestLinkFor(groupId);

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link);
      return true;
    }
  } catch {
    // Permission denied or an insecure context — try the fallback below.
  }

  try {
    const field = document.createElement('textarea');
    field.value = link;
    field.setAttribute('readonly', '');
    // Off-screen but still selectable; `display: none` can't be selected, and
    // a fixed position stops the page scrolling as it's focused.
    field.style.position = 'fixed';
    field.style.top = '0';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(field);
    return copied;
  } catch {
    return false;
  }
};
