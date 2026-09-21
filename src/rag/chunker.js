const HEADING_RE = /^(#{1,6})\s+(.*)$/;

function splitIntoSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  let current = { heading: null, lines: [] };

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      if (current.lines.some((l) => l.trim())) sections.push(current);
      current = { heading: match[2].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some((l) => l.trim())) sections.push(current);

  return sections.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() }));
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;

/**
 * A Markdown table has no blank lines, so paragraph splitting sees it as one
 * block. Confluence pages are full of large tables (environment matrices, config
 * references), and a 10 KB single chunk is invisible to BM25's length
 * normalisation. Split by rows instead, repeating the header so every piece
 * stays self-describing.
 */
function splitTable(lines, maxChars) {
  const header = lines.slice(0, 2).join('\n');
  const chunks = [];
  let rows = [];
  let size = header.length;
  for (const line of lines.slice(2)) {
    if (size + line.length > maxChars && rows.length) {
      chunks.push(`${header}\n${rows.join('\n')}`);
      rows = [];
      size = header.length;
    }
    rows.push(line);
    size += line.length + 1;
  }
  if (rows.length) chunks.push(`${header}\n${rows.join('\n')}`);
  return chunks;
}

function splitOversized(section, maxChars, overlapChars) {
  const { heading, text } = section;
  if (text.length <= maxChars) return [{ heading, text }];

  const chunks = [];
  let buffer = '';
  const flush = () => {
    if (buffer.trim()) chunks.push(buffer);
    buffer = '';
  };

  for (const para of text.split(/\n\s*\n/)) {
    const lines = para.split('\n');
    const tableLines = lines.filter((l) => TABLE_ROW.test(l)).length;
    const isBigTable = para.length > maxChars && lines.length > 2 && tableLines >= lines.length * 0.8;

    if (isBigTable) {
      // Table pieces are complete on their own (header repeated), so they go
      // straight out - no prose overlap glued onto the front of a row set.
      flush();
      chunks.push(...splitTable(lines, maxChars));
      continue;
    }

    const candidate = buffer ? `${buffer}\n\n${para}` : para;
    if (candidate.length > maxChars && buffer) {
      chunks.push(buffer);
      const overlap = buffer.slice(-overlapChars);
      buffer = `${overlap}\n\n${para}`;
    } else {
      buffer = candidate;
    }
  }
  flush();

  return chunks.map((text) => ({ heading, text: text.trim() }));
}

export function chunkMarkdown(markdown, { maxChars = 1500, overlapChars = 200 } = {}) {
  const sections = splitIntoSections(markdown);
  const chunks = [];
  for (const section of sections) {
    chunks.push(...splitOversized(section, maxChars, overlapChars));
  }
  return chunks.filter((c) => c.text.trim().length > 0);
}
