/**
 * Deterministic classification of an out-link into the system it belongs to.
 * The LLM handles *semantic* grouping later; this layer is pure pattern matching
 * so the link inventory in the dossier is reproducible and never hallucinated.
 */

const RULES = [
  { system: 'jira', label: 'Jira / Work Tracking', test: (u) => /jira/i.test(u.hostname) || /\/browse\/[A-Z][A-Z0-9_]+-\d+/.test(u.pathname) },
  { system: 'confluence', label: 'Confluence', test: (u) => /confluence|^kb\./i.test(u.hostname) || /\/(display|spaces)\//.test(u.pathname) || /pageId=\d+/.test(u.search) },
  { system: 'github', label: 'Source Code', test: (u) => /github/i.test(u.hostname) },
  { system: 'gitlab', label: 'Source Code', test: (u) => !/^(docs|help|about|learn)\./i.test(u.hostname) && (/gitlab/i.test(u.hostname) || /(^|\.)git(bud)?\./i.test(u.hostname)) },
  { system: 'bitbucket', label: 'Source Code', test: (u) => /bitbucket/i.test(u.hostname) },
  { system: 'sharepoint', label: 'Documents (SharePoint / OneDrive)', test: (u) => /sharepoint\.com|onedrive|1drv\.ms/i.test(u.hostname) },
  { system: 'teams', label: 'Collaboration', test: (u) => /teams\.microsoft\.com/i.test(u.hostname) },
  { system: 'slack', label: 'Collaboration', test: (u) => /slack\.com/i.test(u.hostname) },
  { system: 'jenkins', label: 'CI / CD', test: (u) => /jenkins/i.test(u.hostname) },
  { system: 'argocd', label: 'CI / CD', test: (u) => /argo(cd)?/i.test(u.hostname) },
  { system: 'azuredevops', label: 'CI / CD', test: (u) => /dev\.azure\.com|visualstudio\.com/i.test(u.hostname) },
  { system: 'grafana', label: 'Observability', test: (u) => /grafana/i.test(u.hostname) },
  { system: 'kibana', label: 'Observability', test: (u) => /kibana|elastic/i.test(u.hostname) },
  { system: 'datadog', label: 'Observability', test: (u) => /datadoghq/i.test(u.hostname) },
  { system: 'sonar', label: 'Quality Gates', test: (u) => /sonar/i.test(u.hostname) },
  { system: 'kubernetes', label: 'Infrastructure', test: (u) => /(^|\.)k8s|kubernetes|rancher|openshift/i.test(u.hostname) },
  { system: 'aws', label: 'Infrastructure', test: (u) => /aws\.amazon\.com|console\.aws/i.test(u.hostname) },
  { system: 'azure', label: 'Infrastructure', test: (u) => /portal\.azure\.com/i.test(u.hostname) },
  { system: 'swagger', label: 'API Reference', test: (u) => /swagger|openapi|\/api-docs/i.test(u.hostname + u.pathname) },
  { system: 'figma', label: 'Design', test: (u) => /figma\.com/i.test(u.hostname) },
  { system: 'miro', label: 'Design', test: (u) => /miro\.com/i.test(u.hostname) },
  { system: 'video', label: 'Recordings & Media', test: (u) => /youtube\.com|youtu\.be|vimeo\.com|\.mp4$/i.test(u.hostname + u.pathname) },
  { system: 'email', label: 'Contacts', test: (u) => u.protocol === 'mailto:' },
];

export function classifyUrl(rawUrl, { confluenceHost = null, gitlabHosts = [] } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { system: 'unknown', label: 'Unresolved', url: rawUrl };
  }

  if (confluenceHost && url.hostname === confluenceHost) {
    return { system: 'confluence', label: 'Confluence', url: url.toString(), ...extractIds(url, gitlabHosts) };
  }

  // Self-hosted GitLab rarely has "gitlab" in its hostname, so the instances we
  // know about are configured explicitly.
  if (gitlabHosts.some((h) => h && url.hostname.toLowerCase() === h.toLowerCase())) {
    return { system: 'gitlab', label: 'Source Code', url: url.toString(), ...extractIds(url, gitlabHosts) };
  }

  for (const rule of RULES) {
    if (rule.test(url)) {
      return { system: rule.system, label: rule.label, url: url.toString(), ...extractIds(url, gitlabHosts) };
    }
  }
  return { system: 'web', label: 'External References', url: url.toString() };
}

/** Pulls the addressable identifier out of a link so connectors can fetch it. */
function extractIds(url, gitlabHosts = []) {
  const out = {};

  const jiraKey = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
  if (jiraKey) out.issueKey = jiraKey[1];

  const pageId = url.search.match(/pageId=(\d+)/) || url.pathname.match(/\/pages\/(\d+)/);
  if (pageId) out.pageId = pageId[1];

  const isDocsHost = /^(docs|help|about|learn)\./i.test(url.hostname);
  const isGitlabHost =
    !isDocsHost &&
    (gitlabHosts.some((h) => h && url.hostname.toLowerCase() === h.toLowerCase()) ||
      /gitlab/i.test(url.hostname) ||
      /(^|\.)git(bud)?\./i.test(url.hostname));

  const RESERVED = ['orgs', 'users', 'settings', 'groups', 'dashboard', 'admin', 'explore', 'help', 'api', 'projects'];

  if (isGitlabHost) {
    // GitLab separates the project path from the action with "/-/", and supports
    // nested groups (group/subgroup/project), so a two-segment assumption fails.
    const [projectPart, actionPart = ''] = url.pathname.split('/-/');
    const segments = projectPart.split('/').filter(Boolean).map((seg) => seg.replace(/\.git$/, ''));

    if (segments.length >= 2 && !RESERVED.includes(segments[0])) {
      out.owner = segments[0];
      out.repo = segments[segments.length - 1];
      // The full path is what GitLab's API addresses a project by.
      out.projectPath = segments.join('/');
    }

    const mr = actionPart.match(/^merge_requests\/(\d+)/);
    if (mr) out.pullRequest = mr[1];
  } else if (/github|bitbucket/i.test(url.hostname)) {
    // GitHub and Bitbucket are always owner/repo at the first two segments.
    const repo = url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/);
    if (repo && !RESERVED.includes(repo[1])) {
      out.owner = repo[1];
      out.repo = repo[2];
    }
    const pr = url.pathname.match(/\/pull\/(\d+)/);
    if (pr) out.pullRequest = pr[1];
  }

  return out;
}

/** Groups a flat link list into { label: [links] }, ordered by richness. */
export function groupBySystem(links) {
  const groups = new Map();
  for (const link of links) {
    if (!groups.has(link.label)) groups.set(link.label, []);
    groups.get(link.label).push(link);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([label, items]) => ({ label, items }));
}
