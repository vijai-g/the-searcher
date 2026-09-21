import { convertStorageToMarkdown } from '../core/convert/htmlToMarkdown.js';
import { harvestLinks, mergeLinks } from './linkHarvester.js';
import * as log from '../util/logger.js';

/**
 * Turns a single term ("EliteA") into a full evidence set, in five phases:
 *
 *   A. reconnaissance  - instance-wide search, every hit read and scored
 *   B. space plan      - rank spaces by evidence density, pick the home spaces
 *   C. fill            - space-restricted searches, since the global one is capped
 *   D. expansion       - ancestors / children / links, confined to focus spaces
 *   E. label sweep     - sibling material inside focus spaces that search missed
 *
 * The user should never need to know which Confluence spaces matter; the plan
 * is derived from where the term actually lives, and recorded in the dossier.
 */
export async function collect(term, { client, config }) {
  const budget = config.maxPages;
  const mode = config.relevance?.mode || 'strict';
  const gitlabHosts = config.connectors?.gitlab?.hosts || [];
  const needle = term.toLowerCase();

  const collected = new Map(); // pageId -> record
  const seenRefs = new Set();
  let fetches = 0;
  let rejected = 0;

  const fetchPage = async (item) => {
    fetches++;
    return item.pageId ? client.getPage(item.pageId) : resolveRef(client, item);
  };

  const admit = (page, item) => {
    const record = buildRecord(page, client, item, gitlabHosts);
    record.mentionCount = record.countTerm(term);
    record.titleMatch = page.title.toLowerCase().includes(needle);
    record.page = page;
    return record;
  };

  // ---------------------------------------------------------------------------
  // Phase A - reconnaissance. Read every hit so the plan is based on how strongly
  // each page is about the term, not merely on whether search returned it.
  // ---------------------------------------------------------------------------
  const manualSpaces = config.spaces || [];
  log.info(
    `Searching Confluence for "${term}"${manualSpaces.length ? ` in ${manualSpaces.join(', ')}` : ' across all spaces'}...`
  );
  const seeds = await client.search(term, { spaces: manualSpaces, max: Math.min(budget, 80) });
  log.info(`Search returned ${seeds.length} candidate page(s).`);
  if (!seeds.length) return emptyResult(term, config);

  for (const [index, seed] of seeds.entries()) {
    if (seenRefs.has(seed.id)) continue;
    seenRefs.add(seed.id);
    try {
      const page = await fetchPage({ pageId: seed.id });
      if (page) collected.set(page.id, admit(page, { relation: 'seed', seedRank: index, depth: 0 }));
    } catch (err) {
      log.warn(`Could not fetch seed ${seed.id}: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase B - space plan.
  // ---------------------------------------------------------------------------
  const spacePlan = manualSpaces.length
    ? { mode: 'manual', focus: manualSpaces.map((key) => ({ key, name: null, score: null })), considered: manualSpaces.length, ranked: [] }
    : planSpaces(collected);

  const focusKeys = new Set(spacePlan.focus.map((f) => f.key));
  if (spacePlan.mode === 'auto') {
    log.info(
      `Space plan: focusing on ${spacePlan.focus.map((f) => `${f.key} (score ${f.score})`).join(', ')} ` +
      `out of ${spacePlan.considered} space(s) with hits.`
    );
  }
  const inFocusSpace = (spaceKey) => mode === 'all' || focusKeys.has(spaceKey);

  // ---------------------------------------------------------------------------
  // Phase C - fill each focus space. The global search is capped, so the home
  // space of a well-documented topic is usually under-represented in it.
  // ---------------------------------------------------------------------------
  // Filling must leave room for Phase D, or the ancestors and children that carry
  // the origin story never get fetched. The fill budget is 45% of the total and is
  // split across focus spaces in proportion to score, so the home space - which
  // holds the runbooks and deployment pages - gets the lion's share.
  const fillBudget = Math.floor(budget * 0.45);
  const scoreSum = spacePlan.focus.reduce((n, f) => n + (f.score || 1), 0) || 1;
  for (const focus of spacePlan.focus) {
    if (collected.size >= budget) break;
    const quota = spacePlan.mode === 'auto'
      ? Math.max(8, Math.round(fillBudget * ((focus.score || 1) / scoreSum)))
      : Math.round(fillBudget / spacePlan.focus.length);
    let more = [];
    try {
      more = await client.search(term, { spaces: [focus.key], max: Math.max(quota * 2, 30) });
    } catch (err) {
      log.warn(`Space search in ${focus.key} failed: ${err.message}`);
      continue;
    }
    let added = 0;
    for (const hit of more) {
      if (collected.size >= budget || added >= quota) break;
      if (seenRefs.has(hit.id)) continue;
      seenRefs.add(hit.id);
      try {
        const page = await fetchPage({ pageId: hit.id });
        if (!page) continue;
        collected.set(page.id, admit(page, { relation: 'seed', seedRank: null, depth: 0 }));
        added++;
      } catch (err) {
        log.warn(`Could not fetch ${hit.id}: ${err.message}`);
      }
    }
    if (added) log.info(`  ${focus.key}: +${added} page(s) from a space-restricted search (quota ${quota}).`);
  }

  // ---------------------------------------------------------------------------
  // Phase D - structural expansion, confined to focus spaces. Keeping a page and
  // traversing through it remain separate decisions.
  // ---------------------------------------------------------------------------
  // Expansion is prioritised by the score of the space it came from, so the home
  // space's children (runbooks, deployment pages) are fetched before a consumer
  // space's, and the budget cannot be exhausted on the periphery first.
  const spaceScore = new Map(spacePlan.focus.map((f) => [f.key, f.score || 1]));
  const queue = [];
  const enqueue = (item) => {
    const key = item.pageId || `${item.spaceKey}::${item.title}`;
    if (seenRefs.has(key)) return;
    seenRefs.add(key);
    queue.push(item);
  };
  const dequeue = () => {
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i];
      const b = queue[best];
      const sa = a.priority || 0;
      const sb = b.priority || 0;
      if (sa > sb || (sa === sb && (a.depth || 0) < (b.depth || 0))) best = i;
    }
    return queue.splice(best, 1)[0];
  };

  const expandFrom = async (record, depth) => {
    const page = record.page;
    if (!page || !inFocusSpace(record.spaceKey)) return;
    const priority = (spaceScore.get(record.spaceKey) || 1) + (record.mentionCount || 0);

    for (const ancestor of page.ancestors || []) {
      enqueue({ pageId: ancestor.id, relation: 'ancestor', depth: depth + 1, priority });
    }
    for (const ref of record.internalRefs) {
      enqueue({
        pageId: ref.pageId || null,
        title: ref.title,
        spaceKey: ref.spaceKey || record.spaceKey,
        relation: 'linked',
        depth: depth + 1,
        fromTitleMatch: record.titleMatch,
        priority,
      });
    }
    try {
      const children = await client.getChildren(page.id);
      for (const child of children) {
        enqueue({ pageId: child.id, relation: 'child', depth: depth + 1, fromTitleMatch: record.titleMatch, priority });
      }
    } catch (err) {
      log.warn(`Could not list children of ${page.id}: ${err.message}`);
    }
  };

  for (const record of [...collected.values()]) {
    if (record.mentionCount > 0) await expandFrom(record, 0);
  }

  const maxFetches = budget * 8;
  while (queue.length && collected.size < budget && fetches < maxFetches) {
    const item = dequeue();

    let page;
    try {
      page = await fetchPage(item);
    } catch (err) {
      log.warn(`Could not fetch ${item.pageId || item.title}: ${err.message}`);
      continue;
    }
    if (!page || collected.has(page.id)) continue;

    const record = admit(page, item);
    const inFocus = inFocusSpace(record.spaceKey);

    let keep;
    let contextOnly = false;
    if (mode === 'all') {
      keep = true;
    } else if (record.mentionCount > 0) {
      keep = true;
    } else if (item.relation === 'ancestor' && inFocus) {
      keep = true; // breadcrumb inside a focus space
      contextOnly = true;
    } else if (mode === 'linked' && item.fromTitleMatch && inFocus) {
      keep = true;
      contextOnly = true;
    } else {
      keep = false;
    }

    if (keep) {
      record.contextOnly = contextOnly;
      collected.set(page.id, record);
    } else {
      rejected++;
    }

    if (record.mentionCount > 0) await expandFrom(record, item.depth || 0);
  }

  log.info(`Fetched ${fetches} page(s); kept ${collected.size}, filtered out ${rejected} as off-topic (relevance mode: ${mode}).`);

  // ---------------------------------------------------------------------------
  // Phase E - label sweep inside focus spaces.
  // ---------------------------------------------------------------------------
  const labels = topLabels(collected);
  const spaceClause = focusKeys.size && mode !== 'all'
    ? ` and space in (${[...focusKeys].map((k) => `"${k}"`).join(',')})`
    : '';
  for (const label of labels.slice(0, 3)) {
    if (collected.size >= budget) break;
    try {
      const tagged = await client.searchCql(`label = "${label}" and type = page${spaceClause}`, { max: 20 });
      for (const hit of tagged) {
        if (collected.size >= budget) break;
        if (collected.has(hit.id)) continue;
        try {
          const full = await fetchPage({ pageId: hit.id });
          const record = admit(full, { relation: 'label', depth: 2 });
          if (record.mentionCount > 0) collected.set(full.id, record);
        } catch { /* skip unreadable page */ }
      }
    } catch (err) {
      log.warn(`Label sweep for "${label}" failed: ${err.message}`);
    }
  }

  const pages = [...collected.values()].map((r) => r.toJSON());
  const links = mergeLinks(pages.map((p) => p.links));

  log.info(`Collected ${pages.length} page(s), ${links.length} distinct outbound link(s).`);

  return {
    term,
    generatedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    spacePlan,
    pages,
    links,
    attachments: pages.flatMap((p) => p.attachmentRefs.map((a) => ({ ...a, sourcePageTitle: p.title }))),
    spaces: [...new Set(pages.map((p) => p.spaceKey).filter(Boolean))],
    stats: {
      pageCount: pages.length,
      linkCount: links.length,
      seedCount: seeds.length,
      truncated: collected.size >= budget,
    },
  };
}

/**
 * Ranks spaces by evidence density and keeps the ones that clearly hold the
 * topic. A title match is worth ten body mentions: a page *named* after the
 * topic is a stronger signal than one that discusses it at length. On an early
 * EliteA run the top space scored 178 and the runner-up 20, so a relative
 * threshold separates home spaces from incidental mentions cleanly.
 */
export function planSpaces(collected) {
  const bySpace = new Map();
  for (const record of collected.values()) {
    const key = record.spaceKey;
    if (!key) continue;
    const entry = bySpace.get(key) || {
      key, name: record.page?.space?.name || null, hits: 0, titleMatches: 0, mentions: 0,
    };
    entry.hits += 1;
    entry.titleMatches += record.titleMatch ? 1 : 0;
    entry.mentions += record.mentionCount || 0;
    bySpace.set(key, entry);
  }

  const ranked = [...bySpace.values()]
    .map((e) => ({ ...e, score: e.mentions + 10 * e.titleMatches }))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return { mode: 'auto', focus: [], considered: 0, ranked: [] };

  const top = ranked[0].score;
  const threshold = Math.max(8, top * 0.2);
  // A space holding a page *named* after the topic is a home space regardless
  // of how it scores against a dominant sibling.
  const focus = ranked
    .filter((e, i) => i === 0 || e.score >= threshold || e.titleMatches > 0)
    .slice(0, 5);

  return { mode: 'auto', focus, considered: ranked.length, ranked: ranked.slice(0, 12) };
}

async function resolveRef(client, item) {
  if (!item.title || !item.spaceKey) return null;
  const stub = await client.resolveByTitle(item.spaceKey, item.title);
  if (!stub) return null;
  return client.getPage(stub.id);
}

function buildRecord(page, client, item, gitlabHosts = []) {
  const storage = page.body?.storage?.value || '';
  let markdown = '';
  try {
    ({ markdown } = convertStorageToMarkdown(storage, {
      pageId: page.id,
      pageTitle: page.title,
      warn: () => {},
    }));
  } catch (err) {
    log.warn(`Markdown conversion failed for ${page.id}: ${err.message}`);
  }

  const { links, internalRefs, attachmentRefs } = harvestLinks(storage, {
    baseUrl: client.baseUrl,
    pageId: page.id,
    pageTitle: page.title,
    gitlabHosts,
  });

  const history = page.history || {};

  const record = {
    internalRefs,
    spaceKey: page.space?.key || null,
    // Occurrence count separates a page about the topic from one that merely
    // name-drops it once; the space plan and the organiser both rank on it.
    countTerm(term) {
      const needle = term.toLowerCase();
      if (!needle) return 0;
      const haystack = `${page.title}\n${markdown}`.toLowerCase();
      return haystack.split(needle).length - 1;
    },
    toJSON: () => ({
      id: page.id,
      title: page.title,
      url: client.pageUrl(page),
      spaceKey: page.space?.key || null,
      spaceName: page.space?.name || null,
      relation: item.relation || 'linked',
      contextOnly: Boolean(record.contextOnly),
      mentionCount: record.mentionCount ?? null,
      seedRank: item.seedRank ?? null,
      depth: item.depth ?? 0,
      version: page.version?.number ?? null,
      createdBy: history.createdBy?.displayName || null,
      createdDate: history.createdDate || null,
      lastUpdatedBy: history.lastUpdated?.by?.displayName || page.version?.by?.displayName || null,
      lastUpdated: history.lastUpdated?.when || page.version?.when || null,
      labels: (page.metadata?.labels?.results || []).map((l) => l.name),
      markdown,
      excerpt: excerptOf(markdown),
      links,
      internalRefs,
      attachmentRefs,
    }),
  };

  return record;
}

function excerptOf(markdown, max = 600) {
  const text = markdown
    .replace(/^#+\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function topLabels(collected) {
  const counts = new Map();
  for (const record of collected.values()) {
    for (const label of record.toJSON().labels) {
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);
}

function emptyResult(term, config) {
  return {
    term,
    generatedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    spacePlan: { mode: 'auto', focus: [], considered: 0, ranked: [] },
    pages: [],
    links: [],
    attachments: [],
    spaces: [],
    stats: { pageCount: 0, linkCount: 0, seedCount: 0, truncated: false },
  };
}
