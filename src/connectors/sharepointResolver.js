import { graphGetJson } from './graphClient.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export function parseSharePointUrl(rawUrl) {
  const url = new URL(rawUrl);
  const hostname = url.hostname;
  const pathname = decodeURIComponent(url.pathname);
  const segments = pathname.split('/').filter(Boolean);

  if (pathname.toLowerCase().includes('/_layouts/') && url.searchParams.has('file')) {
    const sitesIdx = segments.findIndex((s) => s.toLowerCase() === 'sites');
    const siteName = sitesIdx >= 0 ? segments[sitesIdx + 1] : null;
    const fileParam = decodeURIComponent(url.searchParams.get('file'));
    const filename = fileParam.split('/').pop();
    if (!siteName || !filename) {
      throw new Error(`Could not parse Doc.aspx URL: ${rawUrl}`);
    }
    return { hostname, siteName, style: 'docAspx', filename, rawUrl };
  }

  const sitesIdx = segments.findIndex((s) => s.toLowerCase() === 'sites');
  if (sitesIdx === -1 || sitesIdx + 1 >= segments.length) {
    throw new Error(`Unrecognized SharePoint URL shape (no /sites/{name}): ${rawUrl}`);
  }
  const siteName = segments[sitesIdx + 1];
  const remainderSegments = segments.slice(sitesIdx + 2);
  if (!remainderSegments.length) {
    throw new Error(`SharePoint URL has no path beyond the site: ${rawUrl}`);
  }
  return { hostname, siteName, style: 'path', remainderSegments, rawUrl };
}

export function createResolverCache() {
  return { sites: new Map(), drives: new Map(), defaultDrives: new Map() };
}

export async function resolveSite(hostname, siteName, token, cache) {
  const key = `${hostname}:${siteName}`;
  if (cache.sites.has(key)) return cache.sites.get(key);
  const site = await graphGetJson(`${GRAPH}/sites/${hostname}:/sites/${encodeURIComponent(siteName)}`, token);
  cache.sites.set(key, site.id);
  return site.id;
}

export async function listSiteDrives(siteId, token, cache) {
  if (cache.drives.has(siteId)) return cache.drives.get(siteId);
  const res = await graphGetJson(`${GRAPH}/sites/${siteId}/drives?$select=id,name`, token);
  cache.drives.set(siteId, res.value || []);
  return res.value || [];
}

async function resolveDefaultDriveId(siteId, token, cache) {
  if (cache.defaultDrives.has(siteId)) return cache.defaultDrives.get(siteId);
  const drive = await graphGetJson(`${GRAPH}/sites/${siteId}/drive?$select=id`, token);
  cache.defaultDrives.set(siteId, drive.id);
  return drive.id;
}

function encodePath(pathSegments) {
  return pathSegments.map(encodeURIComponent).join('/');
}

function escapeODataQuote(str) {
  return str.replace(/'/g, "''");
}

async function listChildren(driveId, itemId, token) {
  const res = await graphGetJson(`${GRAPH}/drives/${driveId}/items/${itemId}/children?$top=200`, token);
  return res.value || [];
}

async function resolvePathStyle(parsed, token, cache, log) {
  const siteId = await resolveSite(parsed.hostname, parsed.siteName, token, cache);
  const drives = await listSiteDrives(siteId, token, cache);

  const [librarySegment, ...rest] = parsed.remainderSegments;
  const matchedDrive = drives.find((d) => d.name.toLowerCase() === librarySegment.toLowerCase());

  const driveId = matchedDrive ? matchedDrive.id : await resolveDefaultDriveId(siteId, token, cache);
  const relSegments = matchedDrive ? rest : parsed.remainderSegments;

  if (!relSegments.length) {
    const item = await graphGetJson(`${GRAPH}/drives/${driveId}/root?$select=id,name,file,folder,webUrl,lastModifiedDateTime`, token);
    return { item, driveId };
  }

  const encoded = encodePath(relSegments);
  try {
    const item = await graphGetJson(
      `${GRAPH}/drives/${driveId}/root:/${encoded}?$select=id,name,file,folder,webUrl,lastModifiedDateTime`,
      token
    );
    return { item, driveId };
  } catch (err) {
    if (err.status !== 404) throw err;
    const wantedName = relSegments[relSegments.length - 1];

    // The exact path 404'd (macro-embedded URLs can go stale). Climb up the path
    // one segment at a time until we find an ancestor that actually exists, and
    // report its real children — this surfaces staleness instead of guessing.
    let probeSegments = relSegments.slice(0, -1);
    let resolvedParent = null;
    while (!resolvedParent) {
      if (!probeSegments.length) {
        const root = await graphGetJson(`${GRAPH}/drives/${driveId}/root?$select=id`, token);
        resolvedParent = { id: root.id, label: `${parsed.siteName}/${librarySegment} (library root)` };
        break;
      }
      try {
        const enc = encodePath(probeSegments);
        const p = await graphGetJson(`${GRAPH}/drives/${driveId}/root:/${enc}?$select=id`, token);
        resolvedParent = { id: p.id, label: `${parsed.siteName}/${librarySegment}/${probeSegments.join('/')}` };
      } catch (inner) {
        if (inner.status !== 404) throw inner;
        probeSegments = probeSegments.slice(0, -1);
      }
    }

    const siblings = await listChildren(driveId, resolvedParent.id, token);
    const names = siblings.map((s) => s.name).join(', ') || '(none)';
    log?.warn(
      `Not found: "${wantedName}" — closest existing folder is "${resolvedParent.label}", which contains: ${names} (source URL: ${parsed.rawUrl})`
    );
    const notFound = new Error(`SharePoint item not found: ${parsed.rawUrl}`);
    notFound.code = 'NOT_FOUND';
    notFound.siblings = siblings;
    throw notFound;
  }
}

async function resolveDocAspxStyle(parsed, token, cache, log) {
  const siteId = await resolveSite(parsed.hostname, parsed.siteName, token, cache);
  const drives = await listSiteDrives(siteId, token, cache);

  // The Doc.aspx `file` param is sometimes a short display alias, not the real
  // filename (e.g. "Operating Model.docx" vs the real "AI Factory Operating
  // Model Guidebook.docx") — so alongside exact-name matches, keep fuzzy
  // matches whose name contains every significant word of the searched name.
  const baseName = parsed.filename.replace(/\.[^.]+$/, '').toLowerCase();
  const words = baseName.split(/[^a-z0-9]+/).filter(Boolean);

  const exactMatches = [];
  const fuzzyMatches = [];
  for (const drive of drives) {
    let res;
    try {
      res = await graphGetJson(
        `${GRAPH}/drives/${drive.id}/root/search(q='${escapeODataQuote(parsed.filename)}')?$select=id,name,file,folder,webUrl,lastModifiedDateTime,parentReference`,
        token
      );
    } catch {
      continue;
    }
    for (const item of res.value || []) {
      if (!item.file) continue;
      const nameLower = item.name.toLowerCase();
      if (nameLower === parsed.filename.toLowerCase()) {
        exactMatches.push({ item, driveId: drive.id });
      } else if (words.length && words.every((w) => nameLower.includes(w))) {
        fuzzyMatches.push({ item, driveId: drive.id });
      }
    }
  }

  if (exactMatches.length) {
    if (exactMatches.length > 1) {
      log?.warn(`Ambiguous filename search for "${parsed.filename}" matched ${exactMatches.length} drives, using first (source URL: ${parsed.rawUrl})`);
    }
    return exactMatches[0];
  }
  if (fuzzyMatches.length === 1) {
    log?.info(`Doc.aspx link named "${parsed.filename}" not found verbatim; using closest match "${fuzzyMatches[0].item.name}" (source URL: ${parsed.rawUrl})`);
    return fuzzyMatches[0];
  }
  if (fuzzyMatches.length > 1) {
    const names = fuzzyMatches.map((m) => m.item.name).join(', ');
    log?.warn(`Ambiguous filename search for "${parsed.filename}" — multiple candidates (${names}), skipping (source URL: ${parsed.rawUrl})`);
  }

  const notFound = new Error(`SharePoint item not found by filename search: ${parsed.filename} (source URL: ${parsed.rawUrl})`);
  notFound.code = 'NOT_FOUND';
  throw notFound;
}

export async function resolveItem(parsed, token, cache, log) {
  if (parsed.style === 'docAspx') return resolveDocAspxStyle(parsed, token, cache, log);
  return resolvePathStyle(parsed, token, cache, log);
}

export async function listFolderChildrenOneLevel(driveId, folderItemId, token) {
  return listChildren(driveId, folderItemId, token);
}
