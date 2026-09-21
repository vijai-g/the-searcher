import { getMacroBody, getMacroParam, registerMacro } from '../macroRegistry.js';

// Real macro names confirmed empirically against this Confluence instance's storage
// format (Stiltsoft "Page/Section Tabs" plugin): sp-tabs wraps N sp-tab children.
export function registerTabsMacros() {
  registerMacro('sp-tabs', (node, ctx) => {
    const bodyNode = getMacroBody(node);
    return bodyNode ? ctx.convertNode(bodyNode) : '';
  });

  registerMacro('sp-tab', (node, ctx) => {
    const title = getMacroParam(node, 'title') || 'Tab';
    const bodyNode = getMacroBody(node);
    const bodyMd = bodyNode ? ctx.convertNode(bodyNode) : '';
    return `\n\n#### Tab: ${title}\n\n${bodyMd.trim()}\n\n`;
  });
}
