import { createJiraConnector } from './jira.js';
import { createGithubConnector } from './github.js';
import { createGitlabConnector } from './gitlab.js';
import { createSharePointConnector } from './sharepoint.js';
import { createWebConnector } from './web.js';
import * as log from '../util/logger.js';

/**
 * Deep-follow layer. Every linked resource is *always* recorded and grouped in
 * the dossier; a connector only adds fetched content on top. A missing token
 * therefore degrades the dossier's depth, never its link inventory.
 */
export function buildRegistry(config) {
  const connectors = {
    jira: createJiraConnector(config.connectors.jira),
    github: createGithubConnector(config.connectors.github),
    gitlab: createGitlabConnector(config.connectors.gitlab),
    sharepoint: createSharePointConnector(config.connectors.sharepoint),
    web: createWebConnector(config.connectors.web),
  };

  return {
    connectors,

    describe() {
      return Object.values(connectors)
        .filter(Boolean)
        .map((c) => ({ system: c.system, available: c.available, reason: c.reason }));
    },

    async followAll(links) {
      const resources = [];
      const skipped = [];
      const counts = new Map();
      const seenKeys = new Map();

      for (const link of links) {
        // Many distinct URLs address the same underlying resource - a repo's
        // README, a blob path and an Actions run all resolve to one repository.
        // Deduplicating by URL alone once spent 12 of 25 GitHub slots on a
        // single repo, so collapse to the resource identity instead.
        const key = resourceKey(link);
        if (seenKeys.has(key)) {
          // Merge the extra citation, and never re-attempt a key that already failed.
          const prior = seenKeys.get(key);
          if (prior) prior.citedBy.push(...(link.sources || []));
          continue;
        }

        const connector = connectors[link.system];
        if (!connector) {
          skipped.push({ url: link.url, system: link.system, reason: 'no connector for this system' });
          continue;
        }
        if (!connector.available) {
          skipped.push({ url: link.url, system: link.system, reason: connector.reason });
          continue;
        }

        const used = counts.get(link.system) || 0;
        if (used >= connector.max) {
          skipped.push({ url: link.url, system: link.system, reason: `per-system limit (${connector.max}) reached` });
          continue;
        }

        try {
          const fetched = await connector.fetch(link);
          if (!fetched) {
            skipped.push({ url: link.url, system: link.system, reason: 'not addressable (no id parsed from URL)' });
            continue;
          }
          counts.set(link.system, used + 1);
          const resource = { ...fetched, system: link.system, sourceUrl: link.url, citedBy: [...(link.sources || [])] };
          resources.push(resource);
          seenKeys.set(key, resource);
          log.info(`  followed ${link.system}: ${fetched.title}`);
        } catch (err) {
          seenKeys.set(key, null);
          skipped.push({ url: link.url, system: link.system, reason: err.message });
          log.warn(`  ${link.system} fetch failed for ${link.url}: ${err.message}`);
        }
      }

      return { resources, skipped };
    },
  };
}

/** Collapses many URLs that address one underlying resource to a single key. */
function resourceKey(link) {
  if (link.system === 'jira' && link.issueKey) return `jira:${link.issueKey}`;
  // projectPath preserves GitLab's nested groups; owner/repo alone would collide
  // for group/a/proj and group/b/proj.
  const repoPath = link.projectPath || (link.owner && link.repo ? `${link.owner}/${link.repo}` : null);
  if (repoPath) {
    return link.pullRequest
      ? `${link.system}:${repoPath}#${link.pullRequest}`
      : `${link.system}:${repoPath}`;
  }
  try {
    const u = new URL(link.url);
    return `${link.system}:${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return `${link.system}:${link.url}`;
  }
}
