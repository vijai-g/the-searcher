function findChild(node, tagName) {
  return Array.from(node.children).find((c) => c.tagName?.toLowerCase() === tagName);
}

export function registerImagesRule(turndownService, ctx) {
  turndownService.addRule('confluenceImage', {
    filter: (node) => node.nodeName.toLowerCase() === 'ac:image',
    replacement: (content, node) => {
      const attachmentRef = findChild(node, 'ri:attachment');
      if (attachmentRef) {
        const filename = attachmentRef.getAttribute('ri:filename');
        if (filename) {
          ctx.discoveredAttachments.push({ filename });
          return `![${filename}](assets/${ctx.pageId}/${encodeURIComponent(filename)})`;
        }
      }
      const urlRef = findChild(node, 'ri:url');
      if (urlRef) {
        const url = urlRef.getAttribute('ri:value');
        if (url) return `![](${url})`;
      }
      return '';
    },
  });
}
