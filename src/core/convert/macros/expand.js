import { getMacroBody, getMacroParam, registerMacro } from '../macroRegistry.js';

export function registerExpandMacro() {
  registerMacro('expand', (node, ctx) => {
    const title = getMacroParam(node, 'title') || 'Details';
    const bodyNode = getMacroBody(node);
    const bodyMd = bodyNode ? ctx.convertNode(bodyNode) : '';
    return `\n\n<details>\n<summary>${title}</summary>\n\n${bodyMd.trim()}\n\n</details>\n\n`;
  });
}
