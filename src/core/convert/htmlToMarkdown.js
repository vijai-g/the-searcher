import TurndownService from 'turndown';
import { strikethrough, taskListItems } from 'turndown-plugin-gfm';
import { unwrapCdata, parseFragment } from './domSetup.js';
import { getMacroHandler } from './macroRegistry.js';
import { registerLinksRule } from './linksRule.js';
import { registerImagesRule } from './imagesRule.js';
import { registerTableRule } from './tableRule.js';
import { registerLayoutListRule } from './layoutListRule.js';
import './macros/index.js';

function buildTurndownService(ctx) {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });
  // Only strikethrough/task-lists come from the gfm plugin — its table rule leaks raw HTML
  // for cells with nested block content, so tables get our own rule (see tableRule.js).
  turndownService.use([strikethrough, taskListItems]);

  turndownService.addRule('confluenceMacro', {
    filter: (node) => node.nodeName.toLowerCase() === 'ac:structured-macro',
    replacement: (content, node) => {
      const handler = getMacroHandler(node.getAttribute('ac:name'));
      return handler(node, ctx);
    },
  });

  registerLinksRule(turndownService, ctx);
  registerImagesRule(turndownService, ctx);
  registerTableRule(turndownService, ctx);
  registerLayoutListRule(turndownService);

  return turndownService;
}

export function convertStorageToMarkdown(storageXml, { pageId, pageTitle, warn = () => {} } = {}) {
  const cleanedXml = unwrapCdata(storageXml || '');
  const bodyEl = parseFragment(cleanedXml);

  const ctx = {
    pageId,
    pageTitle,
    warn,
    discoveredLinks: [],
    discoveredAttachments: [],
    convertNode: null,
  };

  const turndownService = buildTurndownService(ctx);
  ctx.convertNode = (node) => turndownService.turndown(node);

  const markdown = turndownService.turndown(bodyEl).trim();
  return { markdown, links: ctx.discoveredLinks, attachments: ctx.discoveredAttachments };
}
