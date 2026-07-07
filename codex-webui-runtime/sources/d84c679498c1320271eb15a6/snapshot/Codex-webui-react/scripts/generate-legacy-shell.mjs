import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceHtmlPath = path.resolve(root, '..', 'Codex-webui-ts', 'public', 'index.html');
const targetShellPath = path.join(root, 'src', 'client', 'legacy-shell.ts');

function removeBlock(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  if (start < 0) return html;
  const end = html.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    throw new Error(`Cannot find end marker after ${startMarker}`);
  }
  return html.slice(0, start) + html.slice(end);
}

let html = await fs.readFile(sourceHtmlPath, 'utf8');
html = removeBlock(html, '\n    <div class="modal" id="terminalModal">', '\n    <div class="modal" id="gitModal">');
html = removeBlock(html, '\n    <div class="modal" id="gitModal">', '\n    <div class="modal" id="settingsModal">');

await fs.writeFile(targetShellPath, `export const legacyShellHtml = ${JSON.stringify(html)};\n`, 'utf8');
