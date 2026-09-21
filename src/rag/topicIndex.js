import { existsSync } from 'node:fs';
import { chunkMarkdown } from './chunker.js';
import { createEmbeddingsClient } from '../llm/embeddings.js';
import { createChatClient } from '../llm/chat.js';
import { buildRagSystemPrompt, buildRagUserMessage } from './prompt.js';
import { loadIndex, saveIndex, search as searchVectors } from './vectorStore.js';
import { buildLexicalIndex, searchLexical, saveLexicalIndex, loadLexicalIndex } from './lexicalIndex.js';
import * as log from '../util/logger.js';

/**
 * Per-topic retrieval index, in one of two forms:
 *
 *  - lexical (default): BM25 over chunks, built with no external calls at all.
 *    Follow-up questions are expanded into keywords by the chat model first, which
 *    closes most of the semantic gap that embeddings would otherwise cover.
 *  - vector: embeddings from a provider (CodeMie), for when one is available.
 *
 * Scoping to one dossier keeps answers on subject and the index small.
 */
export async function buildTopicIndex(dossier, paths, config) {
  const entries = collectChunks(dossier);
  if (!entries.length) return { indexed: 0, skipped: false, kind: 'none' };

  if (config.llm.embed.provider === 'lexical') {
    const index = buildLexicalIndex(entries);
    saveLexicalIndex(paths.lexical, index);
    log.info(`Lexical index built (${index.docs.length} chunks, no external calls).`);
    return { indexed: index.docs.length, skipped: false, kind: 'lexical' };
  }

  const embeddings = createEmbeddingsClient(config.llm.embed);
  if (!embeddings) {
    // Never leave a dossier without a way to be questioned.
    log.warn(
      `No embeddings provider available (${config.llm.embed.provider}) - building a lexical index instead. ` +
      `${config.llm.embed.hint || ''}`
    );
    const index = buildLexicalIndex(entries);
    saveLexicalIndex(paths.lexical, index);
    return { indexed: index.docs.length, skipped: false, kind: 'lexical' };
  }

  log.info(`Embedding ${entries.length} chunk(s) via ${embeddings.provider}:${embeddings.model}...`);
  const vectors = await embeddings.embedTexts(entries.map((e) => e.text));
  const index = { chunks: entries.map((e, i) => ({ text: e.text, metadata: e.metadata, vector: vectors[i] })) };
  saveIndex(paths.vectors, index);
  return { indexed: index.chunks.length, skipped: false, kind: 'vector' };
}

export async function askTopic(question, paths, config) {
  const chat = createChatClient(config.llm.chat);
  if (!chat) {
    throw new Error(`No chat credentials for provider "${config.llm.chat.provider}". ${config.llm.chat.hint || ''}`);
  }

  const results = await retrieve(question, paths, config, chat);
  if (!results.length) {
    return { answer: 'The dossier contains nothing matching that question.', sources: [], expansion: [] };
  }

  const answer = await chat.complete({
    system: buildRagSystemPrompt(),
    user: buildRagUserMessage({ question, chunks: results.map((r) => r.chunk) }),
    maxTokens: 1500,
  });

  const sources = [];
  const seen = new Set();
  for (const { chunk, score } of results) {
    const key = chunk.metadata.url || chunk.metadata.title;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ title: chunk.metadata.title, url: chunk.metadata.url, system: chunk.metadata.system, score });
  }

  return { answer, sources, expansion: results.expansion || [] };
}

// --- retrieval --------------------------------------------------------------

async function retrieve(question, paths, config, chat) {
  const lexical = loadLexicalIndex(paths.lexical);
  if (lexical) {
    const expansion = await expandQuery(question, paths.slug, chat);
    // Over-fetch, re-rank with the topic prior, then enforce source diversity.
    const raw = searchLexical(lexical, question, config.llm.topK * 6, { boostTerms: expansion, topic: paths.slug });
    const hits = diversify(rerank(raw), config.llm.topK);
    hits.expansion = expansion;
    return hits;
  }

  if (existsSync(paths.vectors)) {
    const embeddings = createEmbeddingsClient(config.llm.embed);
    if (!embeddings) {
      throw new Error(
        `This dossier has a vector index but no embeddings provider is configured to query it. ` +
        `Rebuild with EMBED_PROVIDER=lexical, or ${config.llm.embed.hint || 'configure the provider'}.`
      );
    }
    const index = loadIndex(paths.vectors);
    const [queryVector] = await embeddings.embedTexts([question]);
    return searchVectors(index, queryVector, config.llm.topK);
  }

  throw new Error(`No index for this dossier yet. Build it with: npm run find -- "${paths.slug}"`);
}

/** Topic prior: log-scaled so a 30x page beats a 1x page without drowning lexical fit. */
function rerank(hits) {
  return hits
    .map((h) => {
      const m = h.chunk.metadata;
      const prior = m.contextOnly ? 0.6 : 1 + Math.log1p(m.mentions || 0) / 2;
      return { ...h, score: h.score * prior };
    })
    .sort((a, b) => b.score - a.score);
}

/** At most two chunks per source page, so the context spans several documents. */
function diversify(hits, topK, perSource = 2) {
  const used = new Map();
  const out = [];
  for (const h of hits) {
    const key = h.chunk.metadata.sourceId;
    const n = used.get(key) || 0;
    if (n >= perSource) continue;
    used.set(key, n + 1);
    out.push(h);
    if (out.length >= topK) break;
  }
  return out;
}

/**
 * Asks the chat model which terms documentation answering this question would
 * contain. One short call, fractions of a cent, and it is what lets a lexical
 * index answer "what is the MLOps behind it" when no page says "MLOps".
 */
async function expandQuery(question, topic, chat) {
  try {
    const text = await chat.complete({
      system:
        'You expand a question into search keywords for a lexical index over technical documentation. ' +
        'Reply with 10-15 comma-separated terms or short phrases that pages answering the question would ' +
        'literally contain: synonyms, tool names, and the concrete nouns behind abstract words. ' +
        'No explanations, no numbering, terms only.',
      user: `Topic: ${topic}\nQuestion: ${question}`,
      maxTokens: 200,
      temperature: 0.3,
    });
    return text
      .split(/[,\n]/)
      .map((t) => t.trim().replace(/^[-*\d.)\s]+/, ''))
      .filter((t) => t && t.length < 60)
      .slice(0, 20);
  } catch (err) {
    log.warn(`Query expansion failed (${err.message}) - searching with the raw question.`);
    return [];
  }
}

// --- chunking ---------------------------------------------------------------

function collectChunks(dossier) {
  const entries = [];

  const term = (dossier.term || '').toLowerCase();

  for (const page of dossier.pages) {
    if (!page.markdown?.trim()) continue;
    // How much this page is *about* the topic - used as a ranking prior so a
    // glossary that name-drops the term once cannot outrank the runbook about it.
    const mentions = page.mentionCount ?? (term ? page.markdown.toLowerCase().split(term).length - 1 : 0);
    for (const chunk of chunkMarkdown(page.markdown)) {
      entries.push({
        text: chunk.heading ? `${page.title} > ${chunk.heading}\n\n${chunk.text}` : `${page.title}\n\n${chunk.text}`,
        metadata: {
          sourceId: `page:${page.id}`, title: page.title, url: page.url, system: 'confluence',
          heading: chunk.heading || null, mentions, contextOnly: Boolean(page.contextOnly),
        },
      });
    }
  }

  (dossier.resources || []).forEach((resource, index) => {
    if (!resource.text?.trim()) return;
    for (const chunk of chunkMarkdown(resource.text)) {
      entries.push({
        text: `${resource.title}\n\n${chunk.text}`,
        metadata: {
          sourceId: `res:${index}`,
          title: resource.title,
          url: resource.url || resource.sourceUrl,
          system: resource.system,
          heading: chunk.heading || null,
          mentions: 10,
        },
      });
    }
  });

  return entries;
}
