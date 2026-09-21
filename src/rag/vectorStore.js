import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadIndex(path) {
  if (!existsSync(path)) return { chunks: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return { chunks: parsed.chunks || [] };
  } catch {
    return { chunks: [] };
  }
}

export function saveIndex(path, index) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(index));
}

export function removeChunksForPage(index, pageId) {
  index.chunks = index.chunks.filter((c) => c.metadata.pageId !== pageId);
}

export function addChunks(index, chunks) {
  index.chunks.push(...chunks);
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function search(index, queryVector, topK) {
  const scored = index.chunks.map((chunk) => ({
    chunk,
    score: cosineSimilarity(queryVector, chunk.vector),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
