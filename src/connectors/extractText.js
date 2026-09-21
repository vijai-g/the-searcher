import { createRequire } from 'node:module';
import mammoth from 'mammoth';

const { PDFParse } = createRequire(import.meta.url)('pdf-parse');

export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx'];

export function isSupportedFilename(name) {
  const lower = name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function extractText(buffer, filename) {
  const lower = filename.toLowerCase();
  let text;
  if (lower.endsWith('.pdf')) {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      text = result.text;
    } finally {
      await parser.destroy();
    }
  } else if (lower.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  } else {
    throw new Error(`Unsupported file type: ${filename}`);
  }
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
