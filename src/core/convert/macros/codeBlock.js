import { getMacroBody, getMacroParam, registerMacro } from '../macroRegistry.js';

export function registerCodeMacro() {
  registerMacro('code', (node) => {
    const language = getMacroParam(node, 'language') || '';
    const bodyNode = getMacroBody(node);
    const codeText = bodyNode ? bodyNode.textContent : '';
    return `\n\n\`\`\`${language}\n${codeText.replace(/\n+$/, '')}\n\`\`\`\n\n`;
  });
}
