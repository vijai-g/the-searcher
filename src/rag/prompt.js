export function buildRagSystemPrompt() {
  return [
    'You are a documentation assistant answering questions using ONLY the numbered context excerpts provided by the user.',
    'Rules:',
    '- Answer using only facts present in the provided context. Do not use outside knowledge.',
    '- Cite the excerpts you used inline as [1], [2], etc., matching their number.',
    '- The question is about one specific topic. Some excerpts come from other projects that',
    '  merely USE that topic; do not present their environments, processes or plans as the',
    "  topic's own. Prefer excerpts whose title names the topic itself.",
    '- Synthesise across excerpts into a coherent answer rather than listing them; name',
    '  concrete systems, environments, tools and URLs when the context gives them.',
    '- If the context does not contain enough information to answer, say so plainly instead of guessing.',
    '- Be direct. Use short headings or bullets when the answer has several parts.',
  ].join('\n');
}

export function buildRagUserMessage({ question, chunks }) {
  const context = chunks
    .map((c, i) => `[${i + 1}] ${c.metadata.title} (${c.metadata.url})\n${c.text}`)
    .join('\n\n---\n\n');

  return `Context excerpts:\n\n${context}\n\n---\n\nQuestion: ${question}`;
}
