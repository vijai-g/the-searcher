/**
 * Jira Data Center connector. Issues carry the *origin* story that Confluence
 * pages usually summarise after the fact: who asked, when, and what shipped.
 */
export function createJiraConnector({ baseUrl, pat, max }) {
  const available = Boolean(baseUrl && pat);

  return {
    system: 'jira',
    available,
    reason: available ? null : 'JIRA_PAT not set — issues recorded as links only',

    async fetch(link) {
      if (!available || !link.issueKey) return null;
      const fields = [
        'summary', 'status', 'issuetype', 'created', 'updated', 'resolutiondate',
        'reporter', 'assignee', 'priority', 'fixVersions', 'labels', 'components', 'description',
      ].join(',');

      const url = `${baseUrl}/rest/api/2/issue/${encodeURIComponent(link.issueKey)}?fields=${fields}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${pat}`, Accept: 'application/json' },
      });
      if (!res.ok) {
        const err = new Error(`Jira ${res.status} for ${link.issueKey}`);
        err.status = res.status;
        throw err;
      }
      const issue = await res.json();
      const f = issue.fields || {};

      return {
        kind: 'jira-issue',
        key: issue.key,
        title: f.summary || issue.key,
        status: f.status?.name || null,
        type: f.issuetype?.name || null,
        priority: f.priority?.name || null,
        created: f.created || null,
        updated: f.updated || null,
        resolved: f.resolutiondate || null,
        reporter: f.reporter?.displayName || null,
        assignee: f.assignee?.displayName || null,
        fixVersions: (f.fixVersions || []).map((v) => v.name),
        components: (f.components || []).map((c) => c.name),
        labels: f.labels || [],
        text: truncate(stripJiraMarkup(f.description || ''), 4000),
      };
    },

    max,
  };
}

function stripJiraMarkup(text) {
  return String(text)
    .replace(/\{code(:[^}]*)?\}/g, '\n```\n')
    .replace(/\{noformat\}/g, '\n```\n')
    .replace(/\{color[^}]*\}|\{color\}/g, '')
    .replace(/\[([^|\]]+)\|([^\]]+)\]/g, '[$1]($2)')
    .replace(/\r\n/g, '\n')
    .trim();
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
