import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function slugify(term) {
  return String(term)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'dossier';
}

export function dossierPaths(dossierDir, term) {
  const slug = slugify(term);
  const dir = join(dossierDir, slug);
  return {
    slug,
    dir,
    json: join(dir, 'dossier.json'),
    plan: join(dir, 'plan.json'),
    vectors: join(dir, 'vectors.json'),
    lexical: join(dir, 'lexical.json'),
    docx: join(dir, `${slug}-dossier.docx`),
  };
}

export function saveDossier(paths, dossier, plan) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.json, JSON.stringify(dossier, null, 2));
  if (plan) writeFileSync(paths.plan, JSON.stringify(plan, null, 2));
}

export function loadDossier(paths) {
  if (!existsSync(paths.json)) return null;
  return JSON.parse(readFileSync(paths.json, 'utf-8'));
}

export function loadPlan(paths) {
  if (!existsSync(paths.plan)) return null;
  return JSON.parse(readFileSync(paths.plan, 'utf-8'));
}

export function listDossiers(dossierDir) {
  if (!existsSync(dossierDir)) return [];
  const out = [];
  for (const entry of readdirSync(dossierDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonPath = join(dossierDir, entry.name, 'dossier.json');
    if (!existsSync(jsonPath)) continue;
    try {
      const d = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      out.push({
        slug: entry.name,
        term: d.term,
        generatedAt: d.generatedAt,
        pages: d.stats?.pageCount ?? 0,
        links: d.stats?.linkCount ?? 0,
        resources: (d.resources || []).length,
      });
    } catch { /* unreadable dossier, skip */ }
  }
  return out.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
}
