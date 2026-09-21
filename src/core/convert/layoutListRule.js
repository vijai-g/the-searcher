const LAYOUT_CLASS_RE = /\b(columnLayout|cell|innerCell)\b/;

function hasLayoutClass(node) {
  const cls = node.getAttribute?.('class') || '';
  return LAYOUT_CLASS_RE.test(cls);
}

// Some older Confluence content encodes multi-column layout as <ul>/<ol>/<li> wrappers
// (class="columnLayout"/"cell"/"innerCell") purely for CSS positioning, not as real lists.
// Left alone, turndown's default list rule renders these as garbled nested bullets/numbers.
// Flatten them to their converted inner content instead, same as the div-based layout macros.
export function registerLayoutListRule(turndownService) {
  turndownService.addRule('confluenceLayoutList', {
    filter: (node) => {
      const tag = node.nodeName.toLowerCase();
      if (tag === 'li') return hasLayoutClass(node);
      if (tag === 'ul' || tag === 'ol') {
        const children = Array.from(node.children);
        return children.length > 0 && children.every((c) => c.tagName?.toLowerCase() === 'li' && hasLayoutClass(c));
      }
      return false;
    },
    replacement: (content) => content,
  });
}
