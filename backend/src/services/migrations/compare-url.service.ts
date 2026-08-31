export interface ParsedCompareURL {
  owner: string;
  repo: string;
  base: string;
  head: string;
}

const REF_REGEX = /^[a-zA-Z0-9._\-/]+$/;

/**
 * Parse a GitHub compare URL into its owner/repo and the two refs being
 * compared.
 *
 *   https://github.com/nammayatri/nammayatri/compare/v1.2.3...my-branch
 *
 * The range separator is located by scanning from the RIGHT for `...` (or `..`)
 * rather than by a character class over the base ref. A regex like
 * `([^.]+)\.{2,3}(...)` — the shape used elsewhere for this — cannot express a
 * base ref that itself contains a dot, so it silently mis-parses dotted tags
 * such as `v1.2.3...v1.3.0`, which are exactly what release ranges look like.
 */
export function parseCompareURL(url: string): ParsedCompareURL {
  const match = url
    .trim()
    .match(/github\.com\/([^/\s]+)\/([^/\s]+)\/compare\/(\S+?)\/?$/i);

  if (!match) {
    throw new Error('Invalid GitHub compare URL. Expected https://github.com/<owner>/<repo>/compare/<base>...<head>');
  }

  const [, owner, repo, rawRange] = match;

  // Drop any query string / fragment (e.g. "?expand=1", "#diff-...").
  const range = rawRange.split(/[?#]/)[0];

  // Three-dot first: "a...b" must not be read as base "a" / head ".b".
  let sepIndex = range.lastIndexOf('...');
  let sepLength = 3;
  if (sepIndex === -1) {
    sepIndex = range.lastIndexOf('..');
    sepLength = 2;
  }
  if (sepIndex <= 0) {
    throw new Error('Invalid GitHub compare URL: expected a "<base>...<head>" range.');
  }

  const base = range.slice(0, sepIndex);
  const head = range.slice(sepIndex + sepLength);

  if (!base || !head) {
    throw new Error('Invalid GitHub compare URL: both a base and a head ref are required.');
  }

  // The refs reach `git` as arguments. git.service validates again at the call
  // site, but rejecting here gives the user a message about their URL rather
  // than an opaque git error.
  if (!REF_REGEX.test(base) || !REF_REGEX.test(head)) {
    throw new Error('Invalid GitHub compare URL: refs may contain only letters, digits, and . _ - /');
  }

  return { owner, repo: repo.replace(/\.git$/i, ''), base, head };
}

/**
 * The backend serves exactly one cloned repo. A compare URL for any other repo
 * would be silently resolved against that clone — reporting diffs from the
 * wrong project, or failing confusingly — so reject it up front.
 */
export function assertRepoMatchesConfig(
  parsed: ParsedCompareURL,
  configuredRepoUrl: string | undefined
): void {
  if (!configuredRepoUrl) return;

  const configured = parseRepoIdentity(configuredRepoUrl);
  if (!configured) return;

  const sameOwner = configured.owner.toLowerCase() === parsed.owner.toLowerCase();
  const sameRepo = configured.repo.toLowerCase() === parsed.repo.toLowerCase();

  if (!sameOwner || !sameRepo) {
    throw new Error(
      `This compare URL points at ${parsed.owner}/${parsed.repo}, but this server is configured for ${configured.owner}/${configured.repo}.`
    );
  }
}

/**
 * Extract owner/repo from a clone URL. Handles the https form (including the
 * `https://x-access-token:<PAT>@github.com/...` credential form used in
 * deployments) and the scp-style `git@github.com:owner/repo.git` form.
 */
export function parseRepoIdentity(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}
