import { JSDOM } from 'jsdom';

/** Plain public web pages. Off by default — most external links are noise. */
export function createWebConnector({ enabled, max }) {
  return {
    system: 'web',
    available: Boolean(enabled),
    reason: enabled ? null : 'FOLLOW_WEB=false',
    max,

    async fetch(link) {
      if (!enabled) return null;
      const res = await fetch(link.url, {
        headers: { 'User-Agent': 'the-searcher/0.1 (documentation indexer)' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('html')) {
        return { kind: 'web-page', title: link.text || link.url, url: link.url, text: '', note: `Skipped non-HTML (${contentType})` };
      }

      const html = await res.text();
      const dom = new JSDOM(html);
      const doc = dom.window.document;
      for (const el of doc.querySelectorAll('script,style,nav,footer,header,aside')) el.remove();

      const title = doc.querySelector('title')?.textContent?.trim() || link.text || link.url;
      const main = doc.querySelector('main,article') || doc.body;
      const text = (main?.textContent || '').replace(/\s+/g, ' ').trim();

      return { kind: 'web-page', title, url: link.url, text: text.slice(0, 5000) };
    },
  };
}
