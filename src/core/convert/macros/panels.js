import { getMacroBody, getMacroParam, registerMacro, quoteBlock } from '../macroRegistry.js';

const LABELS = {
  info: 'ℹ️ Info',
  note: '📝 Note',
  warning: '⚠️ Warning',
  tip: '💡 Tip',
};

function makePanelHandler(defaultLabel) {
  return (node, ctx) => {
    const title = getMacroParam(node, 'title');
    const bodyNode = getMacroBody(node);
    const bodyMd = bodyNode ? ctx.convertNode(bodyNode) : '';
    const label = title ? `${defaultLabel}: ${title}` : defaultLabel;
    return `\n\n> **${label}**\n>\n${quoteBlock(bodyMd)}\n\n`;
  };
}

export function registerPanelMacros() {
  for (const [name, label] of Object.entries(LABELS)) {
    registerMacro(name, makePanelHandler(label));
  }
}
