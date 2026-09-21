/**
 * GitLab connector (EPAM runs self-hosted instances at git.epam.com and
 * eu.git.epam.com).
 *
 * Two things differ from GitHub and both matter here: projects live under
 * arbitrarily nested groups, so a project is addressed by its full path, and a
 * personal access token is instance-specific — a git.epam.com token is not valid
 * for eu.git.epam.com. Links on an instance we hold no token for are still
 * recorded and grouped, just not opened.
 */
export function createGitlabConnector({ baseUrl, token, tokensByHost = {}, hosts, max }) {
  // host -> token. The primary instance plus any GITLAB_TOKEN_<HOST> entries.
  const tokens = { ...tokensByHost };
  const primaryHost = hostOf(baseUrl);
  if (primaryHost && token) tokens[primaryHost] = token;
  const instanceHosts = Object.keys(tokens);
  const available = instanceHosts.length > 0;

  async function api(host, path, { raw = false } = {}) {
    const res = await fetch(`https://${host}/api/v4${path}`, {
      headers: { 'PRIVATE-TOKEN': tokens[host], Accept: raw ? 'text/plain' : 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const err = new Error(`GitLab ${res.status} for ${host}${path}`);
      err.status = res.status;
      throw err;
    }
    return raw ? res.text() : res.json();
  }

  return {
    system: 'gitlab',
    available,
    reason: available
      ? `tokens for ${instanceHosts.join(', ')}`
      : 'GITLAB_TOKEN not set — projects recorded as links only',
    max,
    hosts,
    instanceHosts,

    async fetch(link) {
      if (!available) return null;

      const path = link.projectPath || (link.owner && link.repo ? `${link.owner}/${link.repo}` : null);
      if (!path) return null;

      // A token is only valid on the instance that issued it.
      const host = hostOf(link.url);
      if (!host || !tokens[host]) {
        const err = new Error(
          `no token for ${host} (have: ${instanceHosts.join(', ')}; set GITLAB_TOKEN_${String(host).toUpperCase().replace(/\./g, '_')})`
        );
        err.code = 'WRONG_INSTANCE';
        throw err;
      }

      const id = encodeURIComponent(path);

      if (link.pullRequest) {
        const mr = await api(host, `/projects/${id}/merge_requests/${link.pullRequest}`);
        return {
          kind: 'gitlab-mr',
          title: `${path}!${mr.iid}: ${mr.title}`,
          url: mr.web_url,
          state: mr.state,
          created: mr.created_at,
          merged: mr.merged_at,
          author: mr.author?.name || null,
          text: truncate(mr.description || '', 3000),
        };
      }

      const project = await api(host, `/projects/${id}`);

      let readme = '';
      const readmeFile = fileNameFromReadmeUrl(project.readme_url);
      if (readmeFile) {
        const ref = project.default_branch || 'main';
        try {
          readme = await api(
            host,
            `/projects/${id}/repository/files/${encodeURIComponent(readmeFile)}/raw?ref=${encodeURIComponent(ref)}`,
            { raw: true }
          );
        } catch { /* README unreadable with this token */ }
      }

      return {
        kind: 'gitlab-project',
        title: project.path_with_namespace || path,
        url: project.web_url || link.url,
        description: project.description || null,
        created: project.created_at || null,
        updated: project.last_activity_at || null,
        defaultBranch: project.default_branch || null,
        archived: Boolean(project.archived),
        topics: project.topics || project.tag_list || [],
        text: truncate(readme, 6000),
      };
    },
  };
}

function fileNameFromReadmeUrl(readmeUrl) {
  if (!readmeUrl) return 'README.md';
  const match = String(readmeUrl).match(/\/([^/]+)$/);
  return match ? match[1] : 'README.md';
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
