/**
 * GitHub connector. Reads repository metadata, the README (the closest thing to
 * a deployment/MLOps answer in most repos) and referenced pull requests.
 */
export function createGithubConnector({ api, token, max }) {
  // A wrong token is worse than none: GitHub then 401s even on public repos.
  // GitHub tokens are recognisable (ghp_, github_pat_, gho_, ghs_); anything else
  // in the slot is almost certainly another system's token pasted by mistake.
  const looksLikeGithub = !token || /^(ghp_|github_pat_|gho_|ghs_|ghu_)/.test(token);
  const tokenWarning = token && !looksLikeGithub
    ? 'GITHUB_TOKEN does not look like a GitHub token (expected ghp_/github_pat_ prefix) - ignored, using unauthenticated access'
    : null;
  if (!looksLikeGithub) token = null;

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'the-searcher',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  async function get(path, { raw = false } = {}) {
    const res = await fetch(`${api}${path}`, {
      headers: raw ? { ...headers, Accept: 'application/vnd.github.raw' } : headers,
    });
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status} for ${path}`);
      err.status = res.status;
      throw err;
    }
    return raw ? res.text() : res.json();
  }

  return {
    system: 'github',
    // Unauthenticated access still works for public repos, just rate-limited.
    available: true,
    reason: tokenWarning || (token ? null : 'GITHUB_TOKEN not set — public repositories only, rate limited'),
    max,

    async fetch(link) {
      if (!link.owner || !link.repo) return null;
      const slug = `${link.owner}/${link.repo}`;

      if (link.pullRequest) {
        const pr = await get(`/repos/${slug}/pulls/${link.pullRequest}`);
        return {
          kind: 'github-pr',
          title: `${slug}#${pr.number}: ${pr.title}`,
          state: pr.merged_at ? 'merged' : pr.state,
          created: pr.created_at,
          merged: pr.merged_at,
          author: pr.user?.login || null,
          text: truncate(pr.body || '', 3000),
        };
      }

      const repo = await get(`/repos/${slug}`);
      let readme = '';
      try {
        readme = await get(`/repos/${slug}/readme`, { raw: true });
      } catch { /* no README, or private without a token */ }

      return {
        kind: 'github-repo',
        title: repo.full_name,
        description: repo.description || null,
        language: repo.language || null,
        created: repo.created_at,
        updated: repo.pushed_at,
        topics: repo.topics || [],
        defaultBranch: repo.default_branch,
        archived: repo.archived,
        text: truncate(readme, 6000),
      };
    },
  };
}

function truncate(text, max) {
  return String(text).length > max ? `${String(text).slice(0, max)}...` : String(text);
}
