import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * BM25 lexical index. No embeddings API, no model download, no proxy exposure.
 *
 * Technical documentation is unusually well suited to lexical retrieval: the
 * terms that matter (ArgoCD, Helm, Keycloak, Bedrock) are distinctive tokens that
 * embeddings tend to blur together. The semantic gap that remains — "MLOps" versus
 * "model lifecycle" — is closed at query time by LLM keyword expansion instead.
 */

const K1 = 1.5;
const B = 0.75;

const STOPWORDS = new Set(
  ('a an and are as at be by for from has have how in is it its of on or that the this to was what when where which who will with ' +
   'does do did can could should would about into than then there these those they them their you your we our i me my ' +
   'not no yes if but so also any all each such some more most very just').split(/\s+/)
);

/**
 * Technical documentation abbreviates relentlessly - an environment matrix says
 * "Env", "Prod", "Dev", "k8s" - while questions use the full words. Normalising
 * both sides to one form is what lets "what environments exist" find a table
 * whose header reads "Dev Env | AWS Env | Prod Env".
 */
const ABBREVIATIONS = {
  env: 'environment', envs: 'environment', environ: 'environment',
  prod: 'production', dev: 'development', stg: 'staging', stage: 'staging',
  config: 'configuration', configs: 'configuration', cfg: 'configuration',
  k8s: 'kubernetes', kube: 'kubernetes',
  repo: 'repository', repos: 'repository',
  auth: 'authentication', authn: 'authentication', authz: 'authorization',
  infra: 'infrastructure', db: 'database', dbs: 'database',
  deploy: 'deployment', deploys: 'deployment', deployed: 'deployment',
  integ: 'integration', integr: 'integration',
  doc: 'documentation', docs: 'documentation',
  svc: 'service', svcs: 'service',
  mon: 'monitoring', obs: 'observability',
  ci: 'ci', cd: 'cd',
};

const URL_RE = /https?:\/\/[^\s)\]>|]+/g;

export function tokenize(text) {
  const out = [];
  // URLs are token confetti (hostnames, path segments, query strings) that
  // inflate a chunk's length and drown its real words; link text carries the meaning.
  const withoutUrls = String(text || '').replace(URL_RE, ' ');
  const raw = withoutUrls
    // split camelCase and letter/digit boundaries so "ArgoCD" also yields "argo", "cd"
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase();

  for (const token of raw.split(/[^a-z0-9]+/)) {
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    out.push(normalise(token));
  }
  // keep the un-split compound too, so an exact "argocd" query still matches strongly
  for (const compound of withoutUrls.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []) {
    if (!STOPWORDS.has(compound)) out.push(normalise(compound));
  }
  return out;
}

function normalise(token) {
  if (ABBREVIATIONS[token]) return ABBREVIATIONS[token];
  const stemmed = stem(token);
  return ABBREVIATIONS[stemmed] || stemmed;
}

/** Light suffix stripping — enough to unify deploy/deploys/deployed/deployment. */
function stem(word) {
  if (word.length <= 4) return word;
  return word
    .replace(/(ations?|ments?|ings?|ies|ers?|ed|es|s)$/, (m) => (m === 'ies' ? 'y' : ''))
    .replace(/(.)\1$/, '$1');
}

export function buildLexicalIndex(entries) {
  const docs = [];
  const df = new Map();
  let totalLen = 0;

  for (const entry of entries) {
    // A page titled "CodeMie Environments" should win a question about
    // environments even if its body says "Env"; count title tokens three times.
    const titleTokens = tokenize(entry.metadata?.title || '');
    const tokens = [...tokenize(entry.text), ...titleTokens, ...titleTokens];
    const tf = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    for (const t of Object.keys(tf)) df.set(t, (df.get(t) || 0) + 1);
    docs.push({ text: entry.text, metadata: entry.metadata, tf, len: tokens.length, titleTokens: [...new Set(titleTokens)] });
    totalLen += tokens.length;
  }

  return {
    kind: 'lexical',
    docs,
    df: Object.fromEntries(df),
    avgdl: docs.length ? totalLen / docs.length : 0,
  };
}

export function searchLexical(index, queryText, topK, { boostTerms = [], topic = '' } = {}) {
  const N = index.docs.length;
  if (!N) return [];

  const queryTokens = tokenize(queryText);
  const boosted = new Set(tokenize(boostTerms.join(' ')));
  const weights = new Map();
  for (const t of queryTokens) weights.set(t, (weights.get(t) || 0) + 1);
  // expansion terms count, but the user's own words count a little more
  for (const t of boosted) if (!weights.has(t)) weights.set(t, 0.7);

  // Query words that name the topic itself match every chunk's title and carry
  // no signal for the title boost; only the other words count.
  const topicTokens = new Set(tokenize(topic || ''));
  const askTokens = [...new Set(queryTokens)].filter((t) => !topicTokens.has(t));

  const scored = index.docs.map((doc) => {
    let score = 0;
    for (const [term, weight] of weights) {
      const f = doc.tf[term];
      if (!f) continue;
      const n = index.df[term] || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const norm = f * (K1 + 1) / (f + K1 * (1 - B + (B * doc.len) / index.avgdl));
      score += weight * idf * norm;
    }
    // A page *named* for what was asked ("CodeMie Environments" for "what
    // environments exist") is the answer far more often than a page that merely
    // uses the word in passing; reward each distinct title hit.
    if (score > 0 && doc.titleTokens?.length) {
      const titleHits = askTokens.filter((t) => doc.titleTokens.includes(t)).length;
      if (titleHits) score *= 1 + 0.9 * titleHits;
    }
    return { chunk: doc, score };
  });

  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function saveLexicalIndex(path, index) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(index));
}

export function loadLexicalIndex(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed.kind === 'lexical' ? parsed : null;
  } catch {
    return null;
  }
}
