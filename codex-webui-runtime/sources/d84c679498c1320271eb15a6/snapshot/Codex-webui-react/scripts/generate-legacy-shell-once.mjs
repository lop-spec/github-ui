import fs from 'fs';

const html = fs.readFileSync('public/index.html', 'utf8');
fs.writeFileSync('src/client/legacy-shell.ts', `export const legacyShellHtml = ${JSON.stringify(html)};\n`, 'utf8');
