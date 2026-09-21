import 'dotenv/config';

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function list(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Chat and embeddings are configured independently on purpose: OpenRouter serves
 * no embedding models, so a working setup normally pairs OpenRouter (chat) with
 * CodeMie (embeddings).
 */
function isAnthropicHost(url) {
  return /(^|\.)api\.anthropic\.com$/i.test(hostOf(url));
}

/**
 * Provider resolution, in order of preference when LLM_PROVIDER=auto:
 *   1. CodeMie, if running inside a codemie-claude session (it exports
 *      ANTHROPIC_AUTH_TOKEN and points ANTHROPIC_BASE_URL at its proxy) - free
 *   2. OpenRouter, if OPENROUTER_API_KEY is set
 *   3. Anthropic directly, if ANTHROPIC_API_KEY is set
 * So `npm run find` needs no keys at all when launched from codemie-claude.
 */
function chatConfig() {
  const requested = (process.env.LLM_PROVIDER || 'auto').toLowerCase();
  const openrouterKey = process.env.OPENROUTER_API_KEY || null;
  const anthropicKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || null;
  const anthropicBase = process.env.ANTHROPIC_BASE_URL || undefined;
  const viaProxy = Boolean(anthropicKey && anthropicBase && !isAnthropicHost(anthropicBase));

  let provider = requested;
  if (requested === 'auto') {
    // CodeMie first: inside a codemie-claude session it costs nothing.
    provider = viaProxy ? 'codemie' : openrouterKey ? 'openrouter' : anthropicKey ? 'anthropic' : 'openrouter';
  }

  if (provider === 'openrouter') {
    return {
      provider,
      apiKey: openrouterKey,
      baseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
      model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
      referer: process.env.OPENROUTER_REFERER || 'https://github.com/the-searcher',
      title: 'The Searcher',
      hint: 'Set OPENROUTER_API_KEY in .env, or run from inside a codemie-claude session.',
    };
  }

  // 'anthropic' and 'codemie' both speak the Anthropic Messages dialect; CodeMie
  // simply points the base URL at its proxy and supplies the token via env.
  return {
    provider,
    apiKey: anthropicKey,
    baseUrl: anthropicBase,
    // codemie-claude exports the model name its proxy serves; honour it so a
    // session never asks the proxy for a model it does not route.
    model:
      process.env.ORGANISE_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
      'claude-sonnet-5',
    hint: provider === 'codemie'
      ? 'Run from inside a codemie-claude session so ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL are exported.'
      : 'Set ANTHROPIC_API_KEY, or run from inside a codemie-claude session.',
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function embedConfig() {
  const provider = (process.env.EMBED_PROVIDER || 'lexical').toLowerCase();

  // BM25 needs nothing external, so it is the default and always works.
  if (provider === 'lexical') {
    return { provider, apiKey: null, baseUrl: null, model: 'bm25', hint: null };
  }

  const apiKey =
    process.env.CODEMIE_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY ||
    null;

  const baseUrl = (process.env.CODEMIE_BASE_URL || process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');

  // api.anthropic.com has no /v1/embeddings route, so a base URL pointing there
  // is a misconfiguration, not a usable endpoint. Catch it here rather than
  // letting it surface as a bewildering 404 midway through a run.
  const pointsAtAnthropic = isAnthropicHost(baseUrl);

  return {
    provider,
    apiKey,
    // The CodeMie proxy serves OpenAI-dialect embeddings at <base>/v1/embeddings.
    baseUrl: baseUrl && !pointsAtAnthropic ? `${baseUrl}/v1` : null,
    model: process.env.EMBED_MODEL || 'codemie-text-embedding-ada-002',
    authStyle: (process.env.EMBED_AUTH_STYLE || 'x-api-key').toLowerCase(),
    hint: pointsAtAnthropic
      ? 'ANTHROPIC_BASE_URL points at api.anthropic.com, which serves no embeddings. Run inside an authenticated CodeMie session, or set CODEMIE_BASE_URL to the CodeMie proxy.'
      : 'Run inside an authenticated CodeMie session so CODEMIE_BASE_URL/ANTHROPIC_BASE_URL and the token are set.',
  };
}

function gitlabTokensByHost() {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    const m = key.match(/^GITLAB_TOKEN_([A-Z0-9_]+)$/);
    if (m && value) out[m[1].toLowerCase().replace(/_/g, '.')] = value;
  }
  return out;
}

export function loadConfig({ requireConfluence = true } = {}) {
  const baseUrl = process.env.CONFLUENCE_BASE_URL;
  const pat = process.env.CONFLUENCE_PAT;

  if (requireConfluence) {
    if (!baseUrl) throw new Error('CONFLUENCE_BASE_URL is required (copy .env.example to .env)');
    if (!pat || pat.startsWith('paste-your')) {
      throw new Error('CONFLUENCE_PAT is required. Create one at <base>/plugins/personalaccesstokens/usertokens.action');
    }
  }

  const chat = chatConfig();
  const embed = embedConfig();

  return {
    baseUrl: (baseUrl || '').replace(/\/+$/, ''),
    pat,
    spaces: list(process.env.SEARCH_SPACES),
    maxPages: Number(process.env.MAX_PAGES || 200),
    requestDelayMs: Number(process.env.REQUEST_DELAY_MS || 200),
    dossierDir: process.env.DOSSIER_DIR || './dossiers',

    relevance: {
      // 'strict'  — the page must mention the term (ancestors kept as context)
      // 'linked'  — also keep pages linked from a title match
      // 'all'     — keep everything the crawl reaches
      mode: (process.env.RELEVANCE_MODE || 'strict').toLowerCase(),
    },

    connectors: {
      jira: {
        baseUrl: (process.env.JIRA_BASE_URL || '').replace(/\/+$/, ''),
        pat: process.env.JIRA_PAT || null,
        max: Number(process.env.MAX_JIRA_ISSUES || 40),
      },
      github: {
        api: (process.env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, ''),
        token: process.env.GITHUB_TOKEN || null,
        max: Number(process.env.MAX_GITHUB_ITEMS || 25),
      },
      gitlab: {
        // Hosts to CLASSIFY as GitLab. Self-hosted instances rarely have
        // "gitlab" in the hostname, so they are listed explicitly.
        hosts: list(process.env.GITLAB_HOSTS || 'git.epam.com,eu.git.epam.com,gitbud.epam.com'),
        // Tokens are instance-specific, so each instance gets its own:
        //   GITLAB_BASE_URL + GITLAB_TOKEN            the primary instance
        //   GITLAB_TOKEN_<HOST>                        any other, e.g.
        //   GITLAB_TOKEN_GITBUD_EPAM_COM=glpat-...     for gitbud.epam.com
        baseUrl: (process.env.GITLAB_BASE_URL || 'https://git.epam.com').replace(/\/+$/, ''),
        token: process.env.GITLAB_TOKEN || null,
        tokensByHost: gitlabTokensByHost(),
        max: Number(process.env.MAX_GITLAB_ITEMS || 25),
      },
      sharepoint: { enabled: bool(process.env.FOLLOW_SHAREPOINT, true) },
      web: { enabled: bool(process.env.FOLLOW_WEB, false), max: Number(process.env.MAX_WEB_PAGES || 15) },
    },

    llm: {
      chat,
      embed,
      topK: Number(process.env.RAG_TOP_K || 8),
    },
  };
}
