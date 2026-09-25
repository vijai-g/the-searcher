# The Searcher

You are working inside The Searcher: a tool that traces a topic (a feature, a
product, a platform - e.g. "EliteA") across Confluence and every system Confluence
links out to, from its origin to its current state, and produces a Word dossier.

**The person you are talking to uses you as the chat interface to it.** When they
name a topic or ask a question about one, act - do not explain the tool.

## How to respond

**A bare topic ("EliteA", "look up ScanHub")** - build the dossier:

```
npm run find -- "<topic>"
```

Run it in the foreground; it takes 2-6 minutes and logs progress. When it finishes,
read `dossiers/<slug>/plan.md` and give a short brief: what the topic is, where it
stands now, the spaces it lives in, and the path to the Word document. Mention
anything the run could not reach (the log and `README.md` in the dossier say why).

**A question about a topic ("EliteA - how is it deployed?", "what's the MLOps
behind it?")** - answer from the dossier folder using your own tools:

1. If `dossiers/<slug>/` does not exist, build it first (above).
2. Read `dossiers/<slug>/plan.md` for orientation - it has the reading order.
3. `grep -ril` the question's key terms across `dossiers/<slug>/pages/` and
   `dossiers/<slug>/resources/`, then read the matching files. Every file has
   frontmatter with `url`, `space`, `mentions` (how often the page names the topic -
   higher means more about it) and `context_only` (a breadcrumb, not substantive).
4. Prefer pages with high `mentions` and followed resources (GitLab READMEs, Jira
   issues) over pages that name the topic once.
5. Answer from the material only. Cite each claim with the page title and its `url`.
   If the dossier does not contain the answer, say so plainly and name the most
   likely place it would be (a space, a repo, a system that was not followed).

`npm run ask -- "<topic>" "<question>"` exists too, but you have the full material
and better tools than a single retrieval call - use them.

**A follow-up that needs fresher or wider data** - rerun `find`. Each run rebuilds
the dossier from scratch, so it is safe to repeat.

## The dossier folder

```
dossiers/<slug>/
  README.md          index: spaces chosen, connectors used, pages by relevance
  plan.md            summary, timeline, reading order (AI-organised when a model was available)
  links.md           every outbound link grouped by system, plus what was not opened and why
  pages/*.md         one file per Confluence page, frontmatter + Markdown body
  resources/*.md     followed Jira issues, GitLab/GitHub projects and MRs, documents
  <slug>-dossier.docx  the Word deliverable
  dossier.json / plan.json / lexical.json   machine records; do not edit
```

## What the tool does and does not do

- It chooses Confluence spaces itself by ranking where the topic actually lives; the
  chosen spaces and scores are in the dossier `README.md`. `SEARCH_SPACES` in `.env`
  overrides that only if someone wants a manual list.
- It is strictly read-only against Confluence, Jira, GitLab and every other source.
- Deep-follow connectors degrade to "recorded as a link" without a token. The
  GitLab token matters most: EliteA's deployment repos live under `epm-elps/` on
  git.epam.com and are private.
- Provider resolution is automatic (`LLM_PROVIDER=auto`): inside a codemie-claude
  session the organiser uses Claude through the CodeMie proxy with no key; outside
  one it uses OpenRouter if `OPENROUTER_API_KEY` is set; otherwise it falls back to
  a structural ordering and says so in the document.

## Working on the code

- Node 24, ESM. Entry point `src/cli.js`. `README.md` has the architecture.
- `src/core/convert/` and the SharePoint resolver were ported from `../confluence-crawler`
  and are known-good; prefer not to touch them.
- Verify changes with `node --check` on edited files and by running
  `npm run export -- "<existing topic>"`, which regenerates the workspace and Word
  document from saved JSON without hitting the network.
- Never commit `.env` or `dossiers/`.
