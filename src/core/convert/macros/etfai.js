import { getMacroBody, getMacroParam, registerMacro } from '../macroRegistry.js';

function extractWebUrl(rawUrl) {
  if (!rawUrl) return null;
  const match = rawUrl.match(/webUrl=([^&]+)/);
  if (!match) return rawUrl;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function registerEtfaiMacros() {
  registerMacro('etfai-button', (node) => {
    const title = getMacroParam(node, 'Title') || 'Link';
    const url = getMacroParam(node, 'URL');
    if (!url) return `\n\n**${title}**\n\n`;
    return `\n\n[${title}](${url})\n\n`;
  });

  registerMacro('etfai-contact-card', (node, ctx) => {
    const name = getMacroParam(node, 'Title') || 'Contact';
    const linkUrl = getMacroParam(node, 'LinkURL');
    const linkTitle = getMacroParam(node, 'LinkTitle') || 'Profile';
    const bodyNode = getMacroBody(node);
    const role = bodyNode ? ctx.convertNode(bodyNode).trim() : '';

    let line = `**${name}**`;
    if (role) line += ` — ${role}`;
    if (linkUrl) line += ` ([${linkTitle}](${linkUrl}))`;
    return `\n\n${line}\n\n`;
  });

  registerMacro('lref-onedrive-embedded-file', (node) => {
    const rawUrl = getMacroParam(node, 'url');
    const webUrl = extractWebUrl(rawUrl);
    if (!webUrl) return '\n\n';
    return `\n\n[Open file](${webUrl})\n\n`;
  });

  registerMacro('lref-onedrive-files-list', (node) => {
    const rawUrl = getMacroParam(node, 'url');
    const webUrl = extractWebUrl(rawUrl);
    if (!webUrl) return '\n\n';
    return `\n\n[Open folder](${webUrl})\n\n`;
  });
}
