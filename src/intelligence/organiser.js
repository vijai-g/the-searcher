import { createChatClient } from '../llm/chat.js';
import { buildOrganiseSystemPrompt, buildOrganiseUserMessage } from './prompts.js';
import * as log from '../util/logger.js';

const MAX_EXCERPT = 400;

/**
 * Builds the reading order. If no LLM credentials are available the dossier is
 * still fully usable — it just falls back to a deterministic ordering instead of
 * a narrative one, so `find` never hard-fails on a missing API key.
 */
export async function organise(dossier, config, { rawSink = null } = {}) {
  const items = catalogue(dossier);

  const chat = createChatClient(config.llm.chat);

  if (!chat) {
    const hint = config.llm.chat.hint || '';
    log.warn(`No chat credentials for provider "${config.llm.chat.provider}" - falling back to deterministic ordering. ${hint}`);
    return { ...fallbackPlan(dossier, items), degraded: true, degradedReason: `no ${config.llm.chat.provider} credentials` };
  }

  try {
    log.info(`Organising with ${chat.provider}:${chat.model} (${items.length} items)...`);
    // Every id appears in the output, so the budget scales with the catalogue.
    // Real ids like "page:2766082024" cost ~12 tokens each in most tokenizers and
    // appear hundreds of times in the answer; short aliases cut output by ~5x.
    const { aliased, toReal } = aliasIds(items);
    const maxTokens = Math.min(48000, 6000 + items.length * 25);
    const request = {
      system: buildOrganiseSystemPrompt(),
      user: buildOrganiseUserMessage({ term: dossier.term, items: aliased }),
      maxTokens,
      json: true,
    };

    let text = await chat.complete(request);
    let plan = unalias(parseJson(text), toReal);
    if (!plan) {
      log.warn('Organiser returned unparseable JSON - retrying once with a stricter instruction.');
      text = await chat.complete({
        ...request,
        user: `${request.user}\n\nIMPORTANT: respond with one complete, valid JSON object only. No prose, no code fence, no trailing commentary.`,
        temperature: 0,
      });
      plan = unalias(parseJson(text), toReal);
    }
    if (rawSink) rawSink(text);
    if (!plan) throw new Error('model did not return parseable JSON');

    return { ...reconcile(plan, items), degraded: false, model: `${chat.provider}:${chat.model}` };
  } catch (err) {
    log.warn(`Organiser failed (${err.message}) - falling back to deterministic ordering.`);
    return { ...fallbackPlan(dossier, items), degraded: true, degradedReason: err.message };
  }
}

/** One flat, id-addressable catalogue over pages and followed resources. */
export function catalogue(dossier) {
  const items = [];

  for (const page of dossier.pages) {
    items.push({
      id: `page:${page.id}`,
      type: 'confluence-page',
      title: page.title,
      space: page.spaceName || page.spaceKey,
      created: page.createdDate,
      updated: page.lastUpdated,
      labels: page.labels,
      excerpt: truncate(page.excerpt, MAX_EXCERPT),
      url: page.url,
      relation: page.relation,
      mentions: page.mentionCount ?? null,
      contextOnly: Boolean(page.contextOnly),
    });
  }

  (dossier.resources || []).forEach((resource, index) => {
    items.push({
      id: `res:${index}`,
      type: resource.kind,
      title: resource.title,
      created: resource.created || null,
      updated: resource.updated || resource.merged || null,
      status: resource.status || resource.state || null,
      excerpt: truncate((resource.text || resource.description || '').replace(/\s+/g, ' '), MAX_EXCERPT),
      url: resource.url || resource.sourceUrl,
    });
  });

  return items;
}

function aliasIds(items) {
  const toReal = new Map();
  const aliased = items.map((item, i) => {
    const alias = `${item.type === 'confluence-page' ? 'p' : 'r'}${i + 1}`;
    toReal.set(alias, item.id);
    return { ...item, id: alias };
  });
  return { aliased, toReal };
}

function unalias(plan, toReal) {
  if (!plan) return plan;
  const real = (id) => toReal.get(String(id).trim()) || id;
  return {
    ...plan,
    timeline: (plan.timeline || []).map((e) => ({ ...e, itemId: real(e.itemId) })),
    sections: (plan.sections || []).map((s) => ({ ...s, itemIds: (s.itemIds || []).map(real) })),
  };
}

/** Guarantees the plan references only real ids and loses nothing. */
function reconcile(plan, items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const placed = new Set();
  const sections = [];

  for (const section of plan.sections || []) {
    const itemIds = (section.itemIds || []).filter((id) => byId.has(id) && !placed.has(id));
    itemIds.forEach((id) => placed.add(id));
    if (itemIds.length) {
      sections.push({ title: section.title || 'Untitled', purpose: section.purpose || '', itemIds });
    }
  }

  const orphans = items.filter((i) => !placed.has(i.id)).map((i) => i.id);
  if (orphans.length) {
    sections.push({
      title: 'Also Found',
      purpose: 'Related material that did not fit the sections above.',
      itemIds: orphans,
    });
  }

  const timeline = (plan.timeline || [])
    .filter((e) => e.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return {
    summary: plan.summary || '',
    whatItIs: plan.whatItIs || '',
    currentState: plan.currentState || '',
    timeline,
    sections,
    openQuestions: plan.openQuestions || [],
  };
}

/** Structure-based ordering used when the LLM is unavailable. */
function fallbackPlan(dossier, items) {
  const order = { seed: 0, ancestor: 1, child: 2, label: 3, linked: 4 };
  const pages = items
    .filter((i) => i.type === 'confluence-page')
    .sort((a, b) => (order[a.relation] ?? 9) - (order[b.relation] ?? 9));
  const resources = items.filter((i) => i.type !== 'confluence-page');

  const sections = [];
  if (pages.length) {
    sections.push({
      title: 'Confluence Pages (by relevance)',
      purpose: 'Search hits first, then their parents, children and linked pages.',
      itemIds: pages.map((p) => p.id),
    });
  }
  if (resources.length) {
    sections.push({
      title: 'Linked Resources',
      purpose: 'Material followed into other systems.',
      itemIds: resources.map((r) => r.id),
    });
  }

  const timeline = items
    .filter((i) => i.created)
    .sort((a, b) => String(a.created).localeCompare(String(b.created)))
    .slice(0, 25)
    .map((i) => ({ date: String(i.created).slice(0, 10), event: `Created: ${i.title}`, itemId: i.id }));

  return {
    summary: `${dossier.pages.length} Confluence page(s) and ${(dossier.resources || []).length} linked resource(s) mention "${dossier.term}".`,
    whatItIs: '',
    currentState: '',
    timeline,
    sections,
    openQuestions: [],
  };
}

function parseJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through to brace extraction */ }

  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  const end = trimmed.lastIndexOf('}');
  if (end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch { /* fall through to truncation repair */ }
  }

  const repaired = repairTruncated(trimmed.slice(start));
  if (repaired) {
    log.warn('Organiser output was truncated - repaired it; items cut off will land in "Also Found".');
  }
  return repaired;
}

/**
 * Closes whatever a truncated JSON document left open. Output cut mid-string or
 * mid-token is trimmed back to the last complete value first. Anything the model
 * did not get to say is simply absent; reconcile() places unlisted ids in a
 * final section, so a repaired plan is strictly better than no plan.
 */
function repairTruncated(text) {
  let s = text;
  // Drop a dangling partial value after the last complete separator.
  const lastGood = Math.max(s.lastIndexOf('},'), s.lastIndexOf('],'), s.lastIndexOf('",'), s.lastIndexOf('"}'), s.lastIndexOf('"]'));
  if (lastGood > 0) s = s.slice(0, lastGood + 1).replace(/,\s*$/, '');

  const stack = [];
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inString) s += '"';
  s = s.replace(/,\s*$/, '');
  while (stack.length) s += stack.pop() === '{' ? '}' : ']';

  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function truncate(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
