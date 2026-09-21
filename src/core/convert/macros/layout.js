import { getMacroBody, registerMacro } from '../macroRegistry.js';

// Confluence's multi-column layout macros have no meaningful Markdown equivalent;
// flatten sections/columns into sequential content instead of dropping them.
export function registerLayoutMacros() {
  for (const name of ['section', 'column']) {
    registerMacro(name, (node, ctx) => {
      const bodyNode = getMacroBody(node);
      return bodyNode ? ctx.convertNode(bodyNode) : '';
    });
  }
}
