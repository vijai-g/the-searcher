export const SUGGESTED_SECTIONS = [
  'Start Here',
  'Origin & Rationale',
  'What It Is',
  'Architecture & Design',
  'Deployment & Environments',
  'MLOps & Model Lifecycle',
  'Integrations & APIs',
  'Operations, Support & Runbooks',
  'Adoption, Onboarding & Training',
  'Governance, Security & Compliance',
  'Roadmap & Current State',
  'Reference & Archive',
];

export function buildOrganiseSystemPrompt() {
  return [
    'You organise a research dossier assembled from a company knowledge base.',
    '',
    'You are given a catalogue of ITEMS (Confluence pages, Jira issues, source repositories,',
    'documents). Each has a stable id. Your job is to impose a reading order that takes a',
    'newcomer from the ORIGIN of the topic through to its CURRENT STATE.',
    '',
    'Rules:',
    '- Use ONLY the ids provided. Never invent an id, a title, a date or a fact.',
    '- Every id must appear in exactly one section.',
    '- Order sections so that understanding builds: context and origin first, then how it',
    '  works, then how it runs, then where it is going.',
    `- Prefer these section names where they fit: ${SUGGESTED_SECTIONS.join(', ')}.`,
    '  Omit any that have no items, and add your own if the material demands it.',
    '- Within a section, order items so the most orienting item comes first.',
    '- mentions_term counts how often the topic is named. A page naming it 20+ times',
    '  is likely about it; one naming it once is probably a passing reference. Rank',
    '  accordingly, and put passing references near the end or in Reference & Archive.',
    '- Items marked breadcrumb context are navigational; never present them as substantive.',
    '- Base the timeline strictly on dates present in the catalogue, and keep it to the',
    '  15-25 most significant events - inception, major releases, decisions, the latest',
    '  state. It is a narrative, not an index of every page.',
    '- If the evidence does not support a claim, leave it out rather than guessing.',
    '',
    'Respond with ONLY a JSON object, no prose and no code fence. Emit it MINIFIED on a',
    'single line with no indentation or line breaks - the id lists are long and',
    'pretty-printing wastes the output budget. Shape:',
    '{',
    '  "summary": "3-5 sentence executive summary of the topic",',
    '  "whatItIs": "1-2 sentences a newcomer could repeat",',
    '  "currentState": "2-4 sentences on where things stand now, per the newest evidence",',
    '  "timeline": [{ "date": "YYYY-MM-DD", "event": "what happened", "itemId": "id" }],',
    '  "sections": [{ "title": "...", "purpose": "1 sentence on why to read this section",',
    '                 "itemIds": ["id", "..."] }],',
    '  "openQuestions": ["questions the material does not answer"]',
    '}',
  ].join('\n');
}

export function buildOrganiseUserMessage({ term, items }) {
  const lines = [`TOPIC: ${term}`, '', 'ITEMS:'];
  for (const item of items) {
    lines.push(
      [
        `- id: ${item.id}`,
        `  type: ${item.type}`,
        `  title: ${item.title}`,
        item.space ? `  space: ${item.space}` : null,
        item.created ? `  created: ${item.created}` : null,
        item.updated ? `  updated: ${item.updated}` : null,
        item.status ? `  status: ${item.status}` : null,
        item.labels?.length ? `  labels: ${item.labels.join(', ')}` : null,
        item.mentions ? `  mentions_term: ${item.mentions}x` : null,
        item.contextOnly ? '  note: breadcrumb context only, may not be about the topic' : null,
        item.excerpt ? `  excerpt: ${item.excerpt}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
  return lines.join('\n');
}
