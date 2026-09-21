const registry = new Map();

export function registerMacro(name, handler) {
  registry.set(name, handler);
}

export function getMacroHandler(name) {
  return registry.get(name) || fallbackHandler;
}

export function getMacroParam(macroNode, paramName) {
  for (const child of Array.from(macroNode.children)) {
    if (child.tagName?.toLowerCase() === 'ac:parameter' && child.getAttribute('ac:name') === paramName) {
      return child.textContent.trim();
    }
  }
  return null;
}

export function getMacroBody(macroNode) {
  for (const child of Array.from(macroNode.children)) {
    const tag = child.tagName?.toLowerCase();
    if (tag === 'ac:rich-text-body' || tag === 'ac:plain-text-body') return child;
  }
  return null;
}

function quoteBlock(markdown) {
  return markdown
    .trim()
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

function fallbackHandler(node, ctx) {
  const macroName = node.getAttribute('ac:name') || 'unknown-macro';
  ctx.warn(`Unrecognized macro "${macroName}" on page "${ctx.pageTitle}" (${ctx.pageId})`);
  const title = getMacroParam(node, 'title') || macroName;
  const bodyNode = getMacroBody(node);
  const bodyMd = bodyNode ? ctx.convertNode(bodyNode) : '';
  return `\n\n> **[${macroName}] ${title}**\n>\n${quoteBlock(bodyMd)}\n\n`;
}

export { quoteBlock };
