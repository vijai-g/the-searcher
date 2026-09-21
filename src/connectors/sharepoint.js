import { loadGraphToken, graphDownload } from './graphClient.js';
import { parseSharePointUrl, resolveItem, createResolverCache } from './sharepointResolver.js';
import { extractText, isSupportedFilename } from './extractText.js';
import * as log from '../util/logger.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * SharePoint / OneDrive connector. Authentication is borrowed from the msgraph
 * skill's cached token, so no extra secret belongs in .env.
 */
export function createSharePointConnector({ enabled }) {
  let token = null;
  let unavailableReason = null;

  if (enabled) {
    try {
      token = loadGraphToken();
    } catch (err) {
      unavailableReason = err.message;
    }
  } else {
    unavailableReason = 'FOLLOW_SHAREPOINT=false';
  }

  const cache = createResolverCache();

  return {
    system: 'sharepoint',
    available: Boolean(token),
    reason: unavailableReason,
    max: Infinity,

    async fetch(link) {
      if (!token) return null;

      const parsed = parseSharePointUrl(link.url);
      const { item, driveId } = await resolveItem(parsed, token, cache, log);

      const base = {
        kind: 'sharepoint-document',
        title: item.name,
        url: item.webUrl || link.url,
        updated: item.lastModifiedDateTime || null,
      };

      if (!isSupportedFilename(item.name)) {
        // Slides, spreadsheets and the like are still worth recording, just not
        // text-extractable with the ported extractor.
        return { ...base, text: '', note: 'Recorded without text extraction (unsupported file type)' };
      }

      const buffer = await graphDownload(`${GRAPH}/drives/${driveId}/items/${item.id}/content`, token);
      const text = await extractText(buffer, item.name);
      return { ...base, text: text.length > 8000 ? `${text.slice(0, 8000)}...` : text };
    },
  };
}
