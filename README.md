# The Searcher

Give it one word — `EliteA` — and it traces that topic across Confluence and every
system Confluence links out to, from its origin to its current state, then hands you
a Word dossier you can read top to bottom. After that you can keep asking it questions.

```bash
npm run find -- "EliteA"
npm run ask  -- "EliteA" "how is it deployed?"
npm run ask  -- "EliteA" "what is the MLOps behind it?"
```

## Setup

1. `npm install`
2. Create a Confluence **Data Center Personal Access Token** at
   <https://kb.epam.com/plugins/personalaccesstokens/usertokens.action>
   (kb.epam.com is Data Center, so it is a single PAT — *not* the email + API-token
   pair that Confluence Cloud uses).
3. Paste it into `CONFLUENCE_PAT` in `.env`. Everything else already has a default.

That is enough to produce a dossier. The optional tokens below only add depth.

## How a dossier gets built

```
term ──▶ CQL search          instance-wide, relevance ranked        (seeds)
      ──▶ structural expand  ancestors, children, linked pages,
                             shared labels                          (context)
      ──▶ harvest links      every out-link, classified by system
      ──▶ deep-follow        Jira, GitHub, SharePoint, web
      ──▶ organise           LLM imposes origin ▸ current-state order
      ──▶ export             Word document + per-topic Q&A index
```

Two things are worth understanding about this pipeline.

**Search alone is not enough.** A Confluence search returns a flat relevance list.
It reliably finds the pages that *say* "EliteA", but it misses the parent page that
frames why the thing exists and the child runbook that describes how it runs today.
So every search hit is also expanded structurally — up to its ancestors, down to its
children, out along its links, and sideways to pages sharing its labels. Expansion
only continues through pages that actually mention the term, so one hub page linking
to hundreds of unrelated pages cannot flood the dossier.

**You do not need to know which spaces matter.** Every search hit is read and
scored by how often it names the topic; spaces are then ranked by that density
(a page *titled* after the topic counts for ten mentions) and the dossier focuses on
the ones that clearly hold it. On the EliteA run the home space scored 179 against a
runner-up of 20. The chosen spaces, their scores, and the spaces seen but not
expanded are all printed in the document's Coverage & Gaps section, so the plan is
inspectable. `SEARCH_SPACES` in `.env` overrides the plan with a manual list.

**The link inventory is never guessed.** Links are extracted from page storage XML and
classified by pattern matching (`src/discovery/classify.js`), so that section of the
document is fully reproducible. The LLM is used only to *order and narrate* material
that has already been collected — it is given a catalogue of ids and cannot introduce
a source that was not found.

## The Word document

| Section | What it contains |
|---|---|
| Executive Summary | What the thing is, and where it stands now |
| Contents | Word TOC field — right-click ▸ Update field to populate |
| Timeline | Dated events reconstructed from source-system metadata |
| Reading Order | Sections ordered so understanding builds, each item with excerpt and live link |
| Link Inventory | Every out-link, grouped by system, with citation counts |
| Coverage & Gaps | Which connectors ran, what was truncated, what is still unanswered |

**Coverage & Gaps is the section to read first if you are deciding whether to trust
the dossier.** It states plainly which systems were not reached and why.

## Deep-follow connectors

Every linked resource is *always* recorded and grouped. A connector only adds fetched
content on top, so a missing token reduces the dossier's depth, never its inventory.

| System | Auth | Without it |
|---|---|---|
| Confluence | `CONFLUENCE_PAT` (required) | nothing works |
| Jira | `JIRA_PAT` | issues listed as links only |
| GitHub | `GITHUB_TOKEN` (optional) | public repos only, rate limited |
| GitLab (git.epam.com) | `GITLAB_TOKEN` | projects listed as links only |
| SharePoint / OneDrive | the `msgraph` skill's cached token | documents listed as links only |
| Public web | `FOLLOW_WEB=true` | off by default — most external links are noise |

**EliteA's platform code lives on `gitbud.epam.com`, not `git.epam.com`.** All 47
`epm-elps/*` links (ArgoCD, Helm charts, Bedrock and Azure modules, CI templates)
point at gitbud, which is reachable only on the EPAM network. To open them, connect
to VPN and set `GITLAB_TOKEN_GITBUD_EPAM_COM` to a gitbud PAT; each GitLab instance
takes its own token, named after the host.

**GitLab needs two settings, not one.** `GITLAB_HOSTS` lists the hostnames to
*classify* as GitLab — self-hosted instances rarely contain the string "gitlab", so
`git.epam.com` would otherwise be filed under generic external links. `GITLAB_BASE_URL`
plus `GITLAB_TOKEN` name the one instance that can actually be *fetched* from, since a
personal access token is instance-specific: a `git.epam.com` token is not valid on
`eu.git.epam.com`. Links on any other instance are still recorded and grouped, and the
document says why they were not opened.

GitLab paths are parsed differently from GitHub's: groups nest arbitrarily
(`group/subgroup/project`) and a `/-/` separator precedes the action, so the full
project path — not the first two segments — identifies a project.

Jira issues are usually where the *origin* actually lives: Confluence tends to
describe a decision after it was made, while the ticket records who asked and when.

## Using it from a Claude session

The simplest way to use The Searcher is to open `codemie-claude` (or any Claude Code
session) in this folder and talk to it: "EliteA", then "how is it deployed?". The
`CLAUDE.md` here tells the session how to build a dossier and how to answer from the
Markdown workspace every run writes beside the JSON:

```
dossiers/<slug>/
  README.md      spaces chosen, connectors used, pages by relevance
  plan.md        summary, timeline, reading order
  links.md       every link grouped by system
  pages/*.md     one file per page, with frontmatter (url, space, mentions)
  resources/*.md followed Jira / GitLab / GitHub / document content
```

Inside a codemie-claude session no API key is needed: `LLM_PROVIDER=auto` detects the
exported CodeMie credentials and the organiser runs on Claude through the proxy.

## AI providers

AI is used in exactly three places, and deliberately nowhere else:

| Step | Provider | Why |
|---|---|---|
| Organising the reading order | OpenRouter chat model | Turns the catalogue into summary, timeline and sections |
| Building the Q&A index | none (BM25, local) | Lexical retrieval index |
| Expanding a question into search terms | OpenRouter chat model | Closes the semantic gap for lexical search |
| Answering follow-ups | OpenRouter chat model | Cites retrieved chunks |

Discovery, link harvesting, link classification, timeline dates and the Word
document itself are all deterministic. The organiser receives a catalogue of ids
and cannot introduce a source that was not actually found.

**Retrieval needs no embeddings API.** OpenRouter serves no embedding models at all
(445 models, none of them embeddings), so follow-up questions run on a BM25 lexical
index built with zero external calls. The semantic gap that embeddings would cover
is closed differently: the chat model first expands the question into the terms a
page answering it would literally contain, so "what is the MLOps behind it" searches
for *model lifecycle, Bedrock, registry, monitoring…* Pages are then re-ranked by how
much they are about the topic, so a glossary that name-drops it once cannot outrank
the runbook about it, and at most two chunks per page reach the answer.

```ini
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=google/gemini-2.5-flash
EMBED_PROVIDER=lexical           # the default; nothing else needed
```

`EMBED_PROVIDER=codemie` switches to vector embeddings through the CodeMie proxy if
one is available. `api.anthropic.com` cannot serve embeddings either, and the config
says so up front rather than failing with a 404 mid-run.

Cost is not the binding constraint. Organising a 200-page dossier costs about
**$0.025** on gemini-2.5-flash (~43K tokens in, ~5K out), so $5 covers around 200
runs; follow-up questions cost a fraction of a cent each. Every OpenRouter call logs
its token usage and cost. Inside a codemie-claude session it is free.

Two details keep the organiser reliable at this size: items are sent to the model
under short aliases (`p17`, `r3`) rather than real ids, which cut output tokens by
4x, and truncated JSON is repaired rather than discarded - anything the model did
not get to place lands in an "Also Found" section instead of losing the whole plan.

Set `LLM_PROVIDER=anthropic` (or `codemie`) to use the Anthropic Messages dialect
instead; the model layer handles both.

## Follow-up questions

`find` builds a vector index scoped to that one topic, stored beside the dossier.
Topic scoping matters: asking "how is it deployed?" against a whole-knowledge-base
index tends to surface deployment docs for unrelated systems. Answers cite their
sources and will say when the material does not support an answer.

## Relevance

`RELEVANCE_MODE` controls what enters a dossier:

- `strict` (default) — a page must actually mention the term. Seeds from the search
  always qualify; direct ancestors are kept as breadcrumb context and marked as such.
- `linked` — also keeps pages linked from a page whose *title* matches.
- `all` — keeps everything the crawl reaches.

Keeping and traversing are separate decisions. Expansion only continues through
pages that mention the term, but a page being reachable was never sufficient reason
to include it — conflating the two once produced a 120-page dossier spanning 23
unrelated spaces.

Each page also records `mentionCount`. A page naming the topic 25 times is about it;
one naming it once is a passing reference, and the organiser is told to rank on this
and push passing references into Reference & Archive.

## Commands

| Command | Purpose |
|---|---|
| `npm run find -- "<term>"` | Build the dossier, Word document and Q&A index |
| `npm run ask -- "<term>" "<question>"` | Ask a follow-up, scoped to that dossier |
| `npm run list` | List dossiers already built |
| `npm run export -- "<term>"` | Re-generate the Word document from saved data |
| `npm run organise -- "<term>"` | Re-run only the AI ordering on a saved dossier (no crawl) - handy when switching models |

Flags for `find`: `--max <n>` (page budget), `--spaces A,B` (restrict spaces),
`--no-follow` (Confluence only), `--no-index` (skip the Q&A index).

## Layout

```
src/
  cli.js                   command entry point
  config.js                environment and connector configuration
  core/
    confluenceClient.js    Confluence DC REST client (CQL search, history, comments)
    convert/               storage-format XML ▸ Markdown, with macro handling
  discovery/
    collect.js             search + structural expansion orchestrator
    linkHarvester.js       pulls every out-link from page storage
    classify.js            maps a URL to the system it belongs to
  connectors/              Jira, GitHub, SharePoint, web deep-follow
  intelligence/            LLM ordering, with deterministic fallback
  export/docxWriter.js     Word document generation
  rag/topicIndex.js        per-topic embedding index and Q&A
  dossier/store.js         dossier persistence
```

`core/convert`, `rag/*` and the SharePoint resolver are ported from the sibling
`confluence-crawler` project, where the Confluence macro handling was worked out.

## Output

Dossiers are written to `dossiers/<slug>/`:

```
dossier.json                 all collected evidence
plan.json                    the reading order
<slug>-dossier.docx          the deliverable
vectors.json                 topic Q&A index
errors.log                   warnings from the run
```

## Notes and limits

- The organiser degrades gracefully: with no Anthropic credentials it falls back to
  structural ordering and the document says so in Coverage & Gaps.
- Text extraction covers PDF and DOCX. Slide decks and spreadsheets are recorded as
  links without extraction.
- `MAX_PAGES` caps a sweep. When it is hit, the document says so rather than
  quietly presenting a partial picture.
- The Searcher is strictly read-only. It never writes to Confluence or any other
  source system.
