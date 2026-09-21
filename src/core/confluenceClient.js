const PAGE_EXPAND =
  'body.storage,ancestors,space,version,metadata.labels,history,history.lastUpdated,history.createdBy';
const PAGE_EXPAND_SAFE = 'body.storage,ancestors,metadata.labels,history,history.createdBy';

export class ConfluenceClient {
  constructor({ baseUrl, pat, requestDelayMs = 0 }) {
    this.baseUrl = baseUrl;
    this.requestDelayMs = requestDelayMs;
    this.headers = {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/json',
    };
  }

  async #sleep() {
    if (this.requestDelayMs > 0) await new Promise((r) => setTimeout(r, this.requestDelayMs));
  }

  /**
   * kb.epam.com is a cluster whose nodes disagree: the same request can 404 on
   * one node and succeed on another seconds later. Every id we fetch came from
   * the API itself, so a 404 is far more likely to be that than a missing page -
   * retry before believing it. 5xx and 429 get the same treatment.
   */
  async #request(url, { attempts = 3 } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.#sleep();
      const res = await fetch(url, { headers: this.headers });
      if (res.ok) return res.json();

      const body = await res.text().catch(() => '');
      lastErr = new Error(`Confluence request failed: ${res.status} ${res.statusText} for ${url}`);
      lastErr.status = res.status;
      lastErr.url = url;
      lastErr.body = body;

      const transient = res.status === 404 || res.status === 429 || res.status >= 500;
      if (!transient || attempt === attempts) break;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
    throw lastErr;
  }

  async #fetchAllPaginated(startPath, { max = Infinity } = {}) {
    let url = new URL(startPath, this.baseUrl).toString();
    const results = [];
    while (url && results.length < max) {
      const page = await this.#request(url);
      results.push(...(page.results || []));
      url = page._links?.next ? new URL(page._links.next, this.baseUrl).toString() : null;
    }
    return results.slice(0, max === Infinity ? undefined : max);
  }

  /** Verifies the PAT and returns the authenticated user. */
  async whoAmI() {
    return this.#request(new URL('/rest/api/user/current', this.baseUrl).toString());
  }

  /**
   * Instance-wide relevance-ranked search. `siteSearch` is the ranked full-text
   * operator on Data Center; some instances only expose `text`, so we fall back.
   */
  async search(term, { spaces = [], max = 100, types = ['page', 'blogpost'] } = {}) {
    const escaped = String(term).replace(/"/g, '\\"');
    const typeClause = `type in (${types.join(',')})`;
    const spaceClause = spaces.length ? ` and space in (${spaces.map((s) => `"${s}"`).join(',')})` : '';

    for (const operator of ['siteSearch', 'text']) {
      // No ORDER BY: siteSearch/text then rank by relevance, so a capped result
      // set holds the pages most *about* the term rather than the most recent.
      const cql = `${operator} ~ "${escaped}" and ${typeClause}${spaceClause}`;
      try {
        const path = `/rest/api/search?cql=${encodeURIComponent(cql)}&limit=50&expand=content.space,content.version`;
        const results = await this.#fetchAllPaginated(path, { max });
        return results.map((r) => r.content).filter(Boolean);
      } catch (err) {
        if (operator === 'text') throw err;
        // siteSearch unsupported on this instance — retry with `text`.
      }
    }
    return [];
  }

  /** Raw CQL escape hatch, used for label and ancestor sweeps. */
  async searchCql(cql, { max = 100 } = {}) {
    const path = `/rest/api/search?cql=${encodeURIComponent(cql)}&limit=50&expand=content.space,content.version`;
    const results = await this.#fetchAllPaginated(path, { max });
    return results.map((r) => r.content).filter(Boolean);
  }

  /**
   * Some pages 404 when `space`, `version` or `history.lastUpdated` is expanded
   * (a Data Center quirk, typically when the last editor's account was deleted),
   * even though the page itself is readable. Fall back to the expansions that
   * never fail, so a page is never lost over metadata.
   */
  async getPage(pageId) {
    try {
      return await this.#request(
        new URL(`/rest/api/content/${pageId}?expand=${PAGE_EXPAND}`, this.baseUrl).toString()
      );
    } catch (err) {
      if (err.status !== 404) throw err;
      const page = await this.#request(
        new URL(`/rest/api/content/${pageId}?expand=${PAGE_EXPAND_SAFE}`, this.baseUrl).toString()
      );
      page._partialMetadata = true;
      return page;
    }
  }

  async resolveByTitle(spaceKey, title) {
    const url = new URL(
      `/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}&expand=version`,
      this.baseUrl
    ).toString();
    const result = await this.#request(url);
    return result.results?.[0] || null;
  }

  async getChildren(pageId) {
    return this.#fetchAllPaginated(`/rest/api/content/${pageId}/child/page?limit=100`);
  }

  async getAttachments(pageId) {
    return this.#fetchAllPaginated(`/rest/api/content/${pageId}/child/attachment?limit=100`);
  }

  /** Page comments carry decision history that the page body often omits. */
  async getComments(pageId) {
    try {
      return await this.#fetchAllPaginated(
        `/rest/api/content/${pageId}/child/comment?limit=50&expand=body.storage,history,version`
      );
    } catch {
      return [];
    }
  }

  async downloadAttachment(downloadUrl) {
    await this.#sleep();
    const url = new URL(downloadUrl, this.baseUrl).toString();
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`Failed to download attachment: ${res.status} ${res.statusText} for ${url}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  pageUrl(page) {
    const webui = page?._links?.webui;
    if (webui) return new URL(webui, this.baseUrl).toString();
    return new URL(`/pages/viewpage.action?pageId=${page?.id}`, this.baseUrl).toString();
  }
}
