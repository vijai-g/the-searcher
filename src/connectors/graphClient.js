import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_CACHE_PATH = join(homedir(), '.ms_graph_token_cache.json');

export function loadGraphToken() {
  let cache;
  try {
    cache = JSON.parse(readFileSync(TOKEN_CACHE_PATH, 'utf8'));
  } catch {
    throw new Error(
      `No MS Graph token cache found at ${TOKEN_CACHE_PATH}. Run the msgraph skill's login command first.`
    );
  }
  if (!cache.access_token) {
    throw new Error(`MS Graph token cache at ${TOKEN_CACHE_PATH} has no access_token. Re-run the msgraph skill's login command.`);
  }
  if (cache.expires_at && cache.expires_at * 1000 < Date.now()) {
    throw new Error(`MS Graph access token expired. Re-run the msgraph skill's login (or refresh) command.`);
  }
  return cache.access_token;
}

export async function graphGetJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

export async function graphDownload(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} downloading ${url}`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}
