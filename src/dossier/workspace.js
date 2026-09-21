import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeFilename } from '../util/sanitize.js';
import { groupBySystem } from '../discovery/classify.js';

/**
 * Writes a dossier as a folder of Markdown files beside the JSON.
 *
 * The JSON is the machine record; this is the human (and Claude Code) record.
 * A Claude session opened in the project can grep `pages/`, read `plan.md`,
 * and answer questions with the full tool set, which is a better experience
 * than a single retrieval call - and it needs no API key of its own.
 */
export function writeWorkspace(paths, dossier, plan) {
  const pagesDir = join(paths.dir, 'pages');
  const resourcesDir = join(paths.dir, 'resources');
  for (const dir of [pagesDir, resourcesDir]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  const pageFiles = new Map();
  for (const page of dossier.pages) {
    const file = `${sanitizeFilename(page.title, page.id)}.md`;
    pageFiles.set(`page:${page.id}`, `pages/${file}`);
    writeFileSync(join(pagesDir, file), renderPage(page));
  }

  const resourceFiles = new Map();
  (dossier.resources || []).forEach((resource, index) => {
    const file = `${sanitizeFilename(`${resource.system}-${resource.title}`, index)}.md`;
    resourceFiles.set(`res:${index}`, `resources/${file}`);
    writeFileSync(join(resourcesDir, file), renderResource(resource));
  });

  writeFileSync(join(paths.dir, 'links.md'), renderLinks(dossier));
  writeFileSync(join(paths.dir, 'plan.md'), renderPlan(dossier, plan, pageFiles, resourceFiles));
  writeFileSync(join(paths.dir, 'README.md'), renderIndex(dossier, plan, pageFiles, resourceFiles));

  return { pages: pageFiles.size, resources: resourceFiles.size };
}

// --- renderers --------------------------------------------------------------

function renderPage(page) {
  const fm = frontmatter({
    title: page.title,
    url: page.url,
    space: page.spaceKey,
    space_name: page.spaceName,
    relation: page.relation,
    mentions: page.mentionCount ?? null,
    context_only: page.contextOnly || false,
    created: page.createdDate,
    created_by: page.createdBy,
    updated: page.lastUpdated,
    updated_by: page.lastUpdatedBy,
    labels: page.labels,
  });
  return `${fm}\n# ${page.title}\n\n${page.markdown || '_(no body)_'}\n`;
}

function renderResource(resource) {
  const fm = frontmatter({
    title: resource.title,
    kind: resource.kind,
    system: resource.system,
    url: resource.url || resource.sourceUrl,
    status: resource.status || resource.state || null,
    created: resource.created || null,
    updated: resource.updated || resource.merged || null,
    cited_by: (resource.citedBy || []).map((c) => c.title).filter(Boolean),
  });
  const meta = [
    resource.description ? `> ${resource.description}` : null,
    resource.language ? `Language: ${resource.language}` : null,
    resource.topics?.length ? `Topics: ${resource.topics.join(', ')}` : null,
    resource.fixVersions?.length ? `Fix versions: ${resource.fixVersions.join(', ')}` : null,
    resource.note ? `_${resource.note}_` : null,
  ].filter(Boolean).join('\n\n');
  return `${fm}\n# ${resource.title}\n\n${meta}${meta ? '\n\n' : ''}${resource.text || '_(no text extracted)_'}\n`;
}

function renderLinks(dossier) {
  const out = [`# Link inventory - ${dossier.term}`, '', 'Every outbound reference, grouped by system. Citation counts show how many pages point at each link.', ''];
  for (const group of groupBySystem(dossier.links)) {
    out.push(`## ${group.label} (${group.items.length})`, '');
    for (const link of group.items) {
      const label = link.text || link.issueKey || link.projectPath || link.url;
      const cites = link.sources.length > 1 ? ` _(cited by ${link.sources.length} pages)_` : '';
      out.push(`- [${label}](${link.url})${cites}`);
    }
    out.push('');
  }
  if (dossier.skippedResources?.length) {
    out.push('## Not opened', '', 'Linked resources that were recorded but not fetched, and why.', '');
    const reasons = new Map();
    for (const s of dossier.skippedResources) {
      reasons.set(s.reason, (reasons.get(s.reason) || 0) + 1);
    }
    for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`- ${n} x ${reason}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function renderPlan(dossier, plan, pageFiles, resourceFiles) {
  const items = new Map((dossier.catalogue || []).map((i) => [i.id, i]));
  const fileFor = (id) => pageFiles.get(id) || resourceFiles.get(id) || null;

  const out = [`# ${dossier.term} - reading plan`, ''];
  if (plan.summary) out.push('## Summary', '', plan.summary, '');
  if (plan.whatItIs) out.push('## In one line', '', plan.whatItIs, '');
  if (plan.currentState) out.push('## Where it stands now', '', plan.currentState, '');

  if (plan.timeline?.length) {
    out.push('## Timeline', '', '| Date | Event | Source |', '|---|---|---|');
    for (const e of plan.timeline) {
      const item = items.get(e.itemId);
      const src = item ? `[${item.title}](${fileFor(e.itemId) || item.url})` : '-';
      out.push(`| ${String(e.date).slice(0, 10)} | ${e.event || ''} | ${src} |`);
    }
    out.push('');
  }

  out.push('## Reading order', '');
  plan.sections.forEach((section, i) => {
    out.push(`### ${i + 1}. ${section.title}`, '');
    if (section.purpose) out.push(`_${section.purpose}_`, '');
    for (const id of section.itemIds) {
      const item = items.get(id);
      if (!item) continue;
      const local = fileFor(id);
      const meta = [item.type, item.space, item.mentions ? `${item.mentions}x` : null].filter(Boolean).join(' | ');
      out.push(`- [${item.title}](${local || item.url})${local ? ` - [source](${item.url})` : ''} _(${meta})_`);
    }
    out.push('');
  });

  if (plan.openQuestions?.length) {
    out.push('## Open questions', '');
    for (const q of plan.openQuestions) out.push(`- ${q}`);
    out.push('');
  }
  if (plan.degraded) out.push(`> Ordering is structural for this run (${plan.degradedReason}).`, '');
  return out.join('\n');
}

function renderIndex(dossier, plan, pageFiles, resourceFiles) {
  const sp = dossier.spacePlan;
  const out = [
    `# ${dossier.term} dossier`,
    '',
    `Generated ${dossier.generatedAt} from ${dossier.baseUrl}.`,
    '',
    `- **${dossier.pages.length}** Confluence pages -> \`pages/\``,
    `- **${(dossier.resources || []).length}** followed resources (Jira, GitLab, GitHub, documents) -> \`resources/\``,
    `- **${dossier.links.length}** outbound links, grouped by system -> \`links.md\``,
    `- Reading order, summary and timeline -> \`plan.md\``,
    `- Word document -> \`${dossier.term ? dossier.term.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'dossier'}-dossier.docx\``,
    '',
  ];

  if (sp?.focus?.length) {
    out.push('## Spaces', '');
    out.push(sp.mode === 'auto'
      ? `Ranked ${sp.considered} space(s) by evidence density; focused on:`
      : 'Spaces were set manually:');
    for (const f of sp.focus) {
      out.push(`- **${f.key}**${f.name ? ` (${f.name})` : ''}${f.score != null ? ` - score ${f.score}, ${f.mentions} mentions, ${f.titleMatches} title match(es)` : ''}`);
    }
    out.push('');
  }

  out.push('## Connectors', '');
  for (const c of dossier.connectorStatus || []) {
    out.push(`- ${c.system}: ${c.available ? 'followed' : `not followed - ${c.reason}`}`);
  }
  out.push('');

  out.push('## Pages by relevance', '');
  const pages = [...dossier.pages].sort((a, b) => (b.mentionCount || 0) - (a.mentionCount || 0));
  for (const p of pages) {
    out.push(`- [${p.title}](${pageFiles.get(`page:${p.id}`)}) - ${p.spaceKey}, ${p.mentionCount ?? '?'}x${p.contextOnly ? ', context only' : ''}`);
  }
  out.push('');

  if (resourceFiles.size) {
    out.push('## Followed resources', '');
    (dossier.resources || []).forEach((r, i) => {
      out.push(`- [${r.title}](${resourceFiles.get(`res:${i}`)}) - ${r.system}`);
    });
    out.push('');
  }

  out.push('## Asking questions', '', 'From a Claude session in this project: just ask, naming the topic. From a terminal:', '', '```', `npm run ask -- "${dossier.term}" "your question"`, '```', '');
  return out.join('\n');
}

function frontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      lines.push(`${key}: [${value.map((v) => JSON.stringify(String(v))).join(', ')}]`);
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(String(value))}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}
