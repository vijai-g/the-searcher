export function sanitizeFilename(title, pageId) {
  const slug = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120);
  return `${slug}-${pageId}`;
}
