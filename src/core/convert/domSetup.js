import { JSDOM } from 'jsdom';

export function unwrapCdata(xml) {
  return xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, content) =>
    content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  );
}

export function parseFragment(xml) {
  const dom = new JSDOM(`<!doctype html><html><body>${xml}</body></html>`);
  const body = dom.window.document.body;
  normalizeBreaksInPre(dom.window.document, body);
  return body;
}

function normalizeBreaksInPre(document, body) {
  for (const pre of body.querySelectorAll('pre')) {
    for (const br of Array.from(pre.querySelectorAll('br'))) {
      br.replaceWith(document.createTextNode('\n'));
    }
  }
}
