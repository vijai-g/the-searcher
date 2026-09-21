import { getMacroParam, registerMacro } from '../macroRegistry.js';

export function registerStatusMacro() {
  registerMacro('status', (node) => {
    const title = getMacroParam(node, 'title') || 'status';
    return `\`${title.toUpperCase()}\``;
  });
}
