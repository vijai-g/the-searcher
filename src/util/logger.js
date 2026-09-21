import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let errorLogPath = null;

export function initLogger(outputDir) {
  errorLogPath = `${outputDir}/errors.log`;
  mkdirSync(dirname(errorLogPath), { recursive: true });
}

function timestamp() {
  return new Date().toISOString();
}

export function info(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

export function warn(msg) {
  console.warn(`[${timestamp()}] WARN: ${msg}`);
  appendToErrorLog(`WARN: ${msg}`);
}

export function error(msg) {
  console.error(`[${timestamp()}] ERROR: ${msg}`);
  appendToErrorLog(`ERROR: ${msg}`);
}

function appendToErrorLog(line) {
  if (!errorLogPath) return;
  appendFileSync(errorLogPath, `[${timestamp()}] ${line}\n`);
}
