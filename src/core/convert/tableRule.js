function directRows(table) {
  const rows = [];
  for (const child of Array.from(table.children)) {
    const tag = child.tagName?.toLowerCase();
    if (tag === 'tr') {
      rows.push(child);
    } else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      for (const tr of Array.from(child.children)) {
        if (tr.tagName?.toLowerCase() === 'tr') rows.push(tr);
      }
    }
  }
  return rows;
}

function directCells(row) {
  return Array.from(row.children).filter((c) => ['th', 'td'].includes(c.tagName?.toLowerCase()));
}

function cellToMarkdown(cellNode, ctx) {
  const raw = ctx.convertNode(cellNode).trim();
  // GFM table cells can't contain literal newlines/pipes; <br> is the standard escape for
  // multi-paragraph cell content (common in Confluence's single-cell "layout box" tables).
  return raw.replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
}

// Replaces turndown-plugin-gfm's table rule, which leaks raw HTML for tables whose cells
// contain nested block content (multiple <p>, lists, etc.) instead of converting them.
// Only walks direct row/cell children so nested tables (inside a cell) convert independently
// via the recursive ctx.convertNode call rather than having their rows/cells double-counted here.
export function registerTableRule(turndownService, ctx) {
  turndownService.addRule('confluenceTable', {
    filter: 'table',
    replacement: (content, node) => {
      const rows = directRows(node);
      if (rows.length === 0) return '';

      const renderRow = (row) => `| ${directCells(row).map((c) => cellToMarkdown(c, ctx)).join(' | ')} |`;

      const headerCellCount = directCells(rows[0]).length || 1;
      const lines = [renderRow(rows[0]), `| ${Array(headerCellCount).fill('---').join(' | ')} |`];
      for (let i = 1; i < rows.length; i++) {
        lines.push(renderRow(rows[i]));
      }
      return `\n\n${lines.join('\n')}\n\n`;
    },
  });
}
