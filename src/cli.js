#!/usr/bin/env node
import { loadConfig } from './config.js';
import { ConfluenceClient } from './core/confluenceClient.js';
import { collect } from './discovery/collect.js';
import { buildRegistry } from './connectors/registry.js';
import { organise, catalogue } from './intelligence/organiser.js';
import { writeDossierDocx } from './export/docxWriter.js';
import { buildTopicIndex, askTopic } from './rag/topicIndex.js';
import { dossierPaths, saveDossier, loadDossier, loadPlan, listDossiers } from './dossier/store.js';
import { writeWorkspace } from './dossier/workspace.js';
import * as log from './util/logger.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const USAGE = `
The Searcher - traces a topic from its origin to its current state.

  npm run find  -- "EliteA"                    Build a dossier and Word document
  npm run ask   -- "EliteA" "how is it deployed?"   Ask a follow-up question
  npm run list                                 List dossiers already built
  npm run export -- "EliteA"                   Re-generate the Word document only
  npm run organise -- "EliteA"                 Re-run the AI ordering on a saved dossier (no crawl)

Options for find:
  --max <n>          Override MAX_PAGES for this run
  --spaces A,B       Restrict to these space keys
  --no-follow        Skip deep-follow connectors (Confluence only)
  --no-index         Skip building the Q&A index
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'find':
      return cmdFind(rest);
    case 'ask':
      return cmdAsk(rest);
    case 'list':
      return cmdList();
    case 'export':
      return cmdExport(rest);
    case 'organise':
    case 'organize':
      return cmdOrganise(rest);
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

// --- find -------------------------------------------------------------------

async function cmdFind(args) {
  const { positional, flags } = parseArgs(args);
  const term = positional.join(' ').trim();
  if (!term) {
    console.error('Usage: npm run find -- "EliteA"');
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  if (flags.max) config.maxPages = Number(flags.max);
  if (flags.spaces) config.spaces = String(flags.spaces).split(',').map((s) => s.trim()).filter(Boolean);

  const paths = dossierPaths(config.dossierDir, term);
  log.initLogger(paths.dir);

  const client = new ConfluenceClient({
    baseUrl: config.baseUrl,
    pat: config.pat,
    requestDelayMs: config.requestDelayMs,
  });

  // Fail fast and clearly on a bad token rather than midway through a sweep.
  try {
    const me = await client.whoAmI();
    log.info(`Authenticated to ${config.baseUrl} as ${me.displayName || me.username || 'unknown user'}.`);
  } catch (err) {
    throw new Error(
      `Could not authenticate to ${config.baseUrl} (${err.status || '?'}). ` +
      'Check CONFLUENCE_PAT is a valid Data Center Personal Access Token.'
    );
  }

  const dossier = await collect(term, { client, config });

  if (!dossier.pages.length) {
    log.warn(`Nothing found for "${term}". Try a different spelling, or widen SEARCH_SPACES.`);
    return;
  }

  // Deep-follow every linked system.
  if (flags['no-follow']) {
    dossier.resources = [];
    dossier.skippedResources = [];
    dossier.connectorStatus = [{ system: 'all', available: false, reason: '--no-follow' }];
  } else {
    const registry = buildRegistry(config);
    dossier.connectorStatus = registry.describe();
    for (const status of dossier.connectorStatus) {
      if (!status.available) log.info(`Connector ${status.system} inactive: ${status.reason}`);
    }

    log.info(`Following ${dossier.links.length} link(s) into other systems...`);
    const { resources, skipped } = await registry.followAll(dossier.links);
    dossier.resources = resources;
    dossier.skippedResources = skipped;
    log.info(`Followed ${resources.length} resource(s); ${skipped.length} recorded as links only.`);
  }

  // Impose the reading order.
  log.info('Organising into a consumable order...');
  const plan = await organise(dossier, config, {
    // Keep the raw model output beside the dossier so a bad plan can be inspected.
    rawSink: (text) => { try { writeFileSync(join(paths.dir, 'organiser-raw.txt'), text); } catch { /* best effort */ } },
  });
  dossier.catalogue = catalogue(dossier);

  saveDossier(paths, dossier, plan);
  const ws = writeWorkspace(paths, dossier, plan);
  log.info(`Markdown workspace written (${ws.pages} pages, ${ws.resources} resources) - browsable from a Claude session.`);

  const docxPath = await writeDossierDocx(dossier, plan, paths.docx);
  log.info(`Word document written: ${docxPath}`);

  if (!flags['no-index']) {
    const { indexed, kind } = await buildTopicIndex(dossier, paths, config);
    if (indexed) log.info(`Q&A index ready (${kind}, ${indexed} chunks). Ask: npm run ask -- "${term}" "your question"`);
  }

  console.log('');
  console.log(`Dossier ready: ${paths.dir}`);
  console.log(`  Word document : ${paths.docx}`);
  console.log(`  Pages         : ${dossier.stats.pageCount}`);
  console.log(`  Links         : ${dossier.stats.linkCount}`);
  console.log(`  Followed      : ${(dossier.resources || []).length}`);
  console.log(`  Sections      : ${plan.sections.length}`);
}

// --- ask --------------------------------------------------------------------

async function cmdAsk(args) {
  const term = args[0];
  const question = args.slice(1).join(' ').trim();
  if (!term || !question) {
    console.error('Usage: npm run ask -- "EliteA" "how is it deployed?"');
    process.exitCode = 1;
    return;
  }

  const config = loadConfig({ requireConfluence: false });
  const paths = dossierPaths(config.dossierDir, term);
  if (!loadDossier(paths)) {
    console.error(`No dossier for "${term}" yet. Build one first: npm run find -- "${term}"`);
    process.exitCode = 1;
    return;
  }

  const { answer, sources, expansion } = await askTopic(question, paths, config);
  if (expansion?.length) console.log(`(searched for: ${expansion.slice(0, 8).join(', ')}...)
`);
  console.log(answer);
  if (sources.length) {
    console.log('\n--- Sources ---');
    for (const s of sources) {
      console.log(`- [${s.system}] ${s.title}${s.url ? ` (${s.url})` : ''}`);
    }
  }
}

// --- list / export ----------------------------------------------------------

function cmdList() {
  const config = loadConfig({ requireConfluence: false });
  const dossiers = listDossiers(config.dossierDir);
  if (!dossiers.length) {
    console.log('No dossiers yet. Build one with: npm run find -- "EliteA"');
    return;
  }
  console.log('Term'.padEnd(28) + 'Pages'.padEnd(8) + 'Links'.padEnd(8) + 'Followed'.padEnd(10) + 'Generated');
  for (const d of dossiers) {
    console.log(
      String(d.term).slice(0, 26).padEnd(28) +
      String(d.pages).padEnd(8) +
      String(d.links).padEnd(8) +
      String(d.resources).padEnd(10) +
      String(d.generatedAt).slice(0, 16)
    );
  }
}

async function cmdExport(args) {
  const term = args.join(' ').trim();
  const config = loadConfig({ requireConfluence: false });
  const paths = dossierPaths(config.dossierDir, term);
  const dossier = loadDossier(paths);
  const plan = loadPlan(paths);
  if (!dossier || !plan) {
    console.error(`No saved dossier for "${term}". Build one first: npm run find -- "${term}"`);
    process.exitCode = 1;
    return;
  }
  writeWorkspace(paths, dossier, plan);
  await writeDossierDocx(dossier, plan, paths.docx);
  const { indexed, kind } = await buildTopicIndex(dossier, paths, config);
  console.log(`Word document, Markdown workspace and ${kind} index (${indexed} chunks) written: ${paths.dir}`);
}

async function cmdOrganise(args) {
  const term = args.join(' ').trim();
  const config = loadConfig({ requireConfluence: false });
  const paths = dossierPaths(config.dossierDir, term);
  const dossier = loadDossier(paths);
  if (!dossier) {
    console.error(`No saved dossier for "${term}". Build one first: npm run find -- "${term}"`);
    process.exitCode = 1;
    return;
  }
  log.initLogger(paths.dir);
  const plan = await organise(dossier, config, {
    rawSink: (text) => { try { writeFileSync(join(paths.dir, 'organiser-raw.txt'), text); } catch { /* best effort */ } },
  });
  dossier.catalogue = catalogue(dossier);
  saveDossier(paths, dossier, plan);
  writeWorkspace(paths, dossier, plan);
  await writeDossierDocx(dossier, plan, paths.docx);
  console.log(`Re-organised (${plan.degraded ? 'structural fallback: ' + plan.degradedReason : plan.model}): ${plan.sections.length} sections, ${plan.timeline.length} timeline entries.`);
  console.log(`  ${paths.docx}`);
}

// --- helpers ----------------------------------------------------------------

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

main().catch((err) => {
  log.error(err.message);
  process.exitCode = 1;
});
