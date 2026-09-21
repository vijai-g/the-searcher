import { parseFragment, unwrapCdata } from '../core/convert/domSetup.js';
import { classifyUrl } from './classify.js';

/**
 * Extracts every outbound reference from a page's storage-format XML.
 *
 * The ported Markdown converter only records same-instance page links (it exists
 * to render text faithfully). The Searcher needs the full outbound surface —
 * external systems included — so this walks the DOM independently.
 */
export function harvestLinks(storageXml, { baseUrl, pageId, pageTitle, gitlabHosts = [] } = {}) {
  const confluenceHost = safeHost(baseUrl);
  const body = parseFragment(unwrapCdata(storageXml || ''));
  const found = new Map();

  const record = (rawHref, text) => {
    if (!rawHref) return;
    const href = rawHref.trim();
    if (!href || href.startsWith('#')) return;

    const absolute = toAbsolute(href, baseUrl);
    if (!absolute) return;

    const classified = classifyUrl(absolute, { confluenceHost, gitlabHosts });
    const key = classified.url;
    if (found.has(key)) {
      const existing = found.get(key);
      if (!existing.text && text) existing.text = text;
      return;
    }
    found.set(key, {
      ...classified,
      text: (text || '').trim().replace(/\s+/g, ' ').slice(0, 200) || null,
      sourcePageId: pageId,
      sourcePageTitle: pageTitle,
    });
  };

  // Plain anchors.
  for (const a of body.querySelectorAll('a')) {
    record(a.getAttribute('href'), a.textContent);
  }

  // Namespaced Confluence tags (ri:url, ri:page, ri:attachment) cannot be reached
  // with querySelectorAll — jsdom's CSS engine rejects the colon — so walk by nodeName.
  const internalRefs = [];
  const attachmentRefs = [];

  for (const el of body.getElementsByTagName('*')) {
    const name = el.nodeName.toLowerCase();

    if (name === 'ri:url') {
      record(el.getAttribute('ri:value'), el.textContent);
      continue;
    }

    if (name === 'ri:page') {
      const title = el.getAttribute('ri:content-title');
      if (title) {
        internalRefs.push({
          title,
          spaceKey: el.getAttribute('ri:space-key') || null,
          sourcePageId: pageId,
        });
      }
      continue;
    }

    if (name === 'ri:attachment') {
      const filename = el.getAttribute('ri:filename');
      if (filename) attachmentRefs.push({ filename, sourcePageId: pageId });
    }
  }

  return {
    links: [...found.values()],
    internalRefs,
    attachmentRefs,
  };
}

function safeHost(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
}

function toAbsolute(href, baseUrl) {
  try {
    return new URL(href, baseUrl || undefined).toString();
  } catch {
    return null;
  }
}

/** Merges link lists from many pages, keeping one entry per URL with all sources. */
export function mergeLinks(linkLists) {
  const merged = new Map();
  for (const links of linkLists) {
    for (const link of links) {
      const existing = merged.get(link.url);
      if (existing) {
        existing.sources.push({ pageId: link.sourcePageId, title: link.sourcePageTitle });
        if (!existing.text && link.text) existing.text = link.text;
      } else {
        merged.set(link.url, {
          ...link,
          sources: [{ pageId: link.sourcePageId, title: link.sourcePageTitle }],
        });
      }
    }
  }
  // Links cited by more pages are more central to the topic.
  return [...merged.values()].sort((a, b) => b.sources.length - a.sources.length);
}
