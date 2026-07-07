#!/usr/bin/env node

const args = new Set(process.argv.slice(2));

function stamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

if (args.has('--with-react')) {
  console.error('[parity-watch] Codex-webui-react watch is closed; no React watcher is available.');
  process.exit(1);
}

console.log(`[${stamp()}] WebUI <-> React parity watch is closed; no watcher started.`);
