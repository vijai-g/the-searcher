function findChild(node, tagName) {
  return Array.from(node.children).find((c) => c.tagName?.toLowerCase() === tagName);
}

export function registerLinksRule(turndownService, ctx) {
  // ac:link has no href — internal targets are referenced by title (+ optional space key)
  // and only resolvable to a real page/URL via the Confluence API at crawl time.
  turndownService.addRule('confluenceInternalLink', {
    filter: (node) => node.nodeName.toLowerCase() === 'ac:link',
    replacement: (content, node) => {
      const pageRef = findChild(node, 'ri:page');
      if (pageRef) {
        const title = pageRef.getAttribute('ri:content-title');
        const spaceKey = pageRef.getAttribute('ri:space-key') || null;
        if (title) {
          ctx.discoveredLinks.push({ title, spaceKey });
          return `[[${title}]]`;
        }
      }
      const attachmentRef = findChild(node, 'ri:attachment');
      if (attachmentRef) {
        const filename = attachmentRef.getAttribute('ri:filename') || 'attachment';
        return `[[attachment: ${filename}]]`;
      }
      return content || '';
    },
  });

  // Plain <a href> — keep normal Markdown link rendering, and additionally capture
  // same-instance page links (viewpage.action?pageId=N or /spaces/S/pages/N/...) for crawling.
  turndownService.addRule('linkWithDiscovery', {
    filter: 'a',
    replacement: (content, node) => {
      const href = node.getAttribute('href') || '';
      if (href) {
        const pageIdMatch = href.match(/pageId=(\d+)/) || href.match(/\/spaces\/[^/]+\/pages\/(\d+)/);
        if (pageIdMatch) {
          ctx.discoveredLinks.push({ pageId: pageIdMatch[1] });
        }
      }
      const text = content || node.getAttribute('title') || href;
      return href ? `[${text}](${href})` : content;
    },
  });
}
