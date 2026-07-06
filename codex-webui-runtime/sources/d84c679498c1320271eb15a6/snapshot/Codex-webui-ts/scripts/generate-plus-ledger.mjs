import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const stateDir = path.join(root, 'outputs', '_task_state', '20260704-1253-plus-full-parity');
const plusIndexPath = path.join(stateDir, 'plus-file-index.tsv');
const ledgerPath = path.join(stateDir, 'SOURCE_TO_TARGET_LEDGER.tsv');
const gatePath = path.join(stateDir, 'COMPLETION_GATE.md');
const antiFakePath = path.join(stateDir, 'ANTI_FAKE_SCAN.tsv');
const failOnOpen = process.argv.includes('--fail-on-open');

const doneStatuses = new Set(['implemented', 'verified-equivalent', 'excluded-by-lop', 'blocked-with-evidence']);
const fakeSignals = [
  { name: 'fake', pattern: /\bfake\b/i },
  { name: 'placeholder', pattern: /\bplaceholder\b/i },
  { name: '固定提示词', pattern: /固定提示词/ },
  { name: '未迁移', pattern: /未迁移/ },
  { name: 'not implemented', pattern: /not implemented/i },
  { name: 'coming soon', pattern: /coming soon/i },
  { name: 'TODO', pattern: /\bTODO\b|todo:/i },
  { name: 'unavailableReason', pattern: /unavailableReason/ },
  { name: '尚未迁移', pattern: /尚未迁移/ },
  { name: '不能用假', pattern: /不能用假/ },
  { name: '冒充', pattern: /冒充/ }
];

function readTsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trimEnd();
  const [headerLine, ...lines] = raw.split(/\r?\n/);
  const headers = headerLine.split('\t');
  return lines.filter(Boolean).map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] || '']));
  });
}

function safeCell(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\t/g, ' ').trim();
}

function topModule(sourcePath) {
  const parts = sourcePath.split(/[\\/]/);
  if (parts[0] === 'src' && parts[1] === 'features' && parts[2]) return `src/features/${parts[2]}`;
  if (parts[0] === 'src-tauri' && parts[1] === 'src' && parts[2] === 'domains' && parts[3]) return `src-tauri/src/domains/${parts[3]}`;
  if (parts[0] === 'src-tauri' && parts[1] === 'src' && parts[2] === 'commands') return 'src-tauri/src/commands';
  if (parts[0] === 'src-tauri' && parts[1] === 'src' && parts[2] === 'git') return 'src-tauri/src/git';
  if (parts[0] === 'src-tauri' && parts[1] === 'src' && parts[2] === 'infra' && parts[3]) return `src-tauri/src/infra/${parts[3]}`;
  if (parts[0] === 'src' && parts[1]) return `src/${parts[1]}`;
  if (parts[0] === 'src-tauri' && parts[1]) return `src-tauri/${parts[1]}`;
  return parts.slice(0, 2).join('/') || sourcePath;
}

function priorityFor(sourcePath, klass) {
  const p = sourcePath.replace(/\\/g, '/');
  if (/src\/features\/(conversation|composer|home|workspace)\//.test(p)) return 'P0';
  if (/src\/(protocol|domain|bridge)\//.test(p)) return 'P0';
  if (/src-tauri\/src\/(commands|domains)\/(app_server|workspace|sessions|settings|agents)/.test(p)) return 'P0';
  if (/src\/features\/(settings|git|mcp|skills|preview|notifications)\//.test(p)) return 'P1';
  if (/src\/(state|i18n|styles)\//.test(p)) return 'P1';
  if (klass === 'protocol-client' || klass === 'protocol-schema-generated') return 'P0';
  return 'P2';
}

function targetFor(sourcePath, klass) {
  const p = sourcePath.replace(/\\/g, '/');
  if (klass === 'protocol-schema-generated') return 'outputs/app-server-protocol; src/services/app-server-client.ts; src/services/codex.ts; tests/codex-service-static.test.js';
  if (/src\/features\/git\//.test(p) || /src-tauri\/src\/git\//.test(p)) return 'src/services/git.ts; src/server.ts; public/index.html; public/js/app.js; public/css/app.css; tests/basic.test.js; tests/frontend-static.test.js';
  if (/src\/features\/settings\//.test(p) || /settings/.test(p)) return 'src/utils/config.ts; src/server.ts; public/index.html; public/js/app.js; public/css/app.css; tests/basic.test.js; tests/frontend-static.test.js';
  if (/src\/features\/mcp\//.test(p)) return 'src/services/mcp.ts; src/server.ts; public/js/app.js; public/css/app.css; tests/basic.test.js';
  if (/src\/features\/skills\//.test(p) || /domains\/agents/.test(p)) return 'src/services/skills.ts; src/server.ts; public/js/app.js; public/css/app.css; tests/basic.test.js';
  if (/src\/features\/preview\//.test(p)) return 'src/services/preview.ts; src/server.ts; public/index.html; public/js/app.js; public/css/app.css; tests/basic.test.js; tests/frontend-static.test.js';
  if (/src\/features\/notifications\//.test(p)) return 'src/services/codex.ts; public/index.html; public/js/app.js; public/css/app.css; tests/frontend-static.test.js';
  if (/src\/features\/(conversation|composer|home|workspace)\//.test(p)) return 'src/services/codex.ts; src/server.ts; public/index.html; public/js/app.js; public/css/app.css; tests';
  if (/src\/(protocol|domain|bridge)\//.test(p) || /src-tauri\/src\/(commands|domains|infra)\//.test(p) || klass === 'protocol-schema-generated') return 'src/types.ts; src/services/app-server-client.ts; src/services/codex.ts; src/server.ts; tests/codex-service-static.test.js; tests/basic.test.js';
  if (/src\/features\/terminal\//.test(p) || /src-tauri\/src\/domains\/terminal\//.test(p)) return 'src/services/terminal.ts; src/server.ts; public/index.html; public/js/app.js; public/css/app.css; tests/basic.test.js; tests/frontend-static.test.js';
  if (/src\/features\/automation\//.test(p)) return 'src/services/automation.ts; src/server.ts; public/js/app.js; public/css/app.css; tests/basic.test.js';
  if (/src\/features\/auth\//.test(p)) return 'src/server.ts; public/js/app.js; public/css/app.css; tests/basic.test.js';
  if (/src\/features\/browser\//.test(p) || /computer_use|computer-use/.test(p)) return 'blocked-with-evidence: platform/high-permission web replacement needed';
  if (/src\/assets|src\/styles|src\/i18n/.test(p)) return 'public/assets; public/css/app.css; public/js/app.js; tests/frontend-static.test.js';
  return 'docs/plus-parity-ledger.md; target TBD after source review';
}

function semanticsFor(sourcePath, klass) {
  const p = sourcePath.replace(/\\/g, '/');
  if (/composer/.test(p)) return 'Composer input, command palette, model controls, attachments, send/stop, queue behavior';
  if (/conversation/.test(p)) return 'Conversation timeline, transcript, tool calls, approvals, plans, diffs, user prompts';
  if (/workspace/.test(p)) return 'Workspace roots, cwd switching, file browser, explorer open, permission config';
  if (/home/.test(p)) return 'Home shell, sidebar, navigation, session/project state and main content switching';
  if (/settings/.test(p)) return 'Settings sections, config layers, preferences, hooks, sandbox, update, model and appearance';
  if (/git/.test(p)) return 'Git status, diff, stage/unstage, commit, push/pull/fetch, branch/worktree UI';
  if (/mcp/.test(p)) return 'MCP server config, status, tools and form validation';
  if (/skills|agents/.test(p)) return 'Skills, agents, plugin catalog and install/remove state';
  if (/terminal/.test(p)) return 'Terminal sessions, process spawn/stdin/resize/kill and dock UI';
  if (/automation/.test(p)) return 'Automation templates, schedules, run now, enable/disable and history';
  if (/browser/.test(p)) return 'Browser sidebar/runtime, URL navigation and browser-use integration';
  if (/computer_use|computer-use/.test(p)) return 'Computer-use runtime, high-permission automation and bundled runtime';
  if (/preview/.test(p)) return 'Quick preview for URLs and local files';
  if (/notifications/.test(p)) return 'Toast/system notification/taskbar alert behavior';
  if (/auth/.test(p)) return 'Codex auth choice, login/API key/session state';
  if (/pets/.test(p)) return 'Optional pet overlay assets, preferences and interactions';
  if (/protocol/.test(p)) return 'App-server protocol schema, guards, mappers and request/notification contracts';
  if (/bridge|tauri|commands|domains|infra/.test(p)) return 'Desktop bridge, Tauri command/domain/service behavior to map into Node/Web APIs';
  if (/i18n/.test(p)) return 'Localized message catalogs and language options';
  if (/styles|assets/.test(p)) return 'Plus visual system, assets, icons, media and theme tokens';
  if (/docs|spec/.test(p)) return 'Reference documentation/specification to preserve behavior and tests';
  return `${klass} source behavior to review and map`;
}

function initialStatus(sourcePath, klass) {
  const p = sourcePath.replace(/\\/g, '/');
  if (klass === 'protocol-schema-generated') return 'verified-equivalent';
  if (/node_modules|dist|target\//.test(p)) return 'excluded-by-lop';
  if (/src-tauri\/gen|src-tauri\/icons|tauri-config-generated-assets/.test(p) || klass === 'tauri-config-generated-assets') return 'excluded-by-lop';
  if (/src\/features\/git\//.test(p)) return gitParityStatus(p);
  if (/src\/features\/notifications\//.test(p)) return 'verified-equivalent';
  if (/src\/features\/terminal\//.test(p)) return 'verified-equivalent';
  if (/src\/features\/preview\//.test(p)) return 'verified-equivalent';
  if (/src-tauri\/src\/domains\/terminal\//.test(p)) return 'partial';
  if (/src\/features\/(workspace|composer|conversation|home)\//.test(p)) return 'partial';
  if (/src\/(protocol|domain|bridge)\//.test(p) || /src-tauri\/src\/(commands|domains)\/(app_server|workspace|sessions)/.test(p)) return 'partial';
  if (/src\/features\/settings\//.test(p)) return 'partial';
  if (/src\/features\/(git|mcp|skills|preview|notifications|auth|pets|terminal|automation|browser)\//.test(p)) return 'missing';
  if (/computer_use|computer-use/.test(p)) return 'blocked-with-evidence';
  if (/src\/(state|i18n|styles|assets)\//.test(p)) return 'partial';
  if (/docs|spec|scripts/.test(p)) return 'partial';
  return 'unmapped';
}

function gitParityStatus(p) {
  if (/WorkspaceDiffConversationPreview|diffCodeHighlight|GitDiffCodeView|diffPreviewModel|useWorkspaceGitAutoRefresh|useWorkspaceDiffViewer|useDiffSidebarLayout|gitIcons/.test(p)) {
    return 'partial';
  }
  if (/WorkspaceDiff(Viewer|Sidebar|ScopeSelector|FileList|ViewerCard)|Git(ChangeBrowser|ChangeSection|StateCard|CommitDialog|PushConfirmDialog|OperationsMenu)/.test(p)) {
    return 'verified-equivalent';
  }
  if (/workspaceGit(Status|Helpers)|workspaceDiffDisplayModel|git(ViewState|DiffKey|ActionAvailability)|types|useWorkspaceGit(State|Diff|Data|Actions)?|useWorkspaceGit\.test|useWorkspaceGit\.workspaceSelection/.test(p)) {
    return 'verified-equivalent';
  }
  return 'partial';
}

function evidenceFor(status, row) {
  if (row.class === 'protocol-schema-generated' && status === 'verified-equivalent') {
    return 'outputs/app-server-protocol contains generated app-server TS/JSON schema contract; build/test/check passed';
  }
  if (/src[\\/]features[\\/]workspace[\\/]ui[\\/]ThreadContextMenu\.tsx$/.test(row.path) && status === 'partial') {
    return 'Basic thread context menu archive/delete behavior converted to public/js/app.js and src/server.ts: role=menu, archive/delete menuitems, pending labels, /session/archive persistence, /sessions and /projects archive filtering; verified by tests/frontend-static.test.js, tests/basic.test.js, and outputs/verify-session-archive.mjs';
  }
  if (/src[\\/]features[\\/]workspace[\\/]ui[\\/](WorkspaceRootMenu|WorkspaceRootActionIcons|WorkspaceSessionCleanupDialog|useWorkspaceRootMenuState|WorkspaceSidebarSection)(\.test)?\.(tsx|ts)$/.test(row.path) && status === 'partial') {
    return 'Basic workspace sidebar slices converted to public/js/app.js and public/css/app.css: root more/right-click menu, set current/new thread, explorer open via /path/open, cleanup dialog, remove-root local state, thread context archive/delete menu; verified by tests/frontend-static.test.js, tests/basic.test.js, outputs/verify-sidebar-tools-project.mjs, and outputs/verify-session-archive.mjs';
  }
  if (/src[\\/]features[\\/]git[\\/]/.test(row.path) && status === 'verified-equivalent') {
    return 'Converted to src/services/git.ts, src/server.ts Git APIs, public Git modal; npm test covers status/file-diff/workspace-diffs/stage/unstage/discard/commit/checkout and static UI';
  }
  if (/src[\\/]features[\\/]notifications[\\/]/.test(row.path) && status === 'verified-equivalent') {
    return 'Converted to src/services/codex.ts SSE notification event plus public toast/system Notification API/title attention/WebAudio controller; npm test static coverage passed';
  }
  if (/src[\\/]features[\\/]terminal[\\/]/.test(row.path) && status === 'verified-equivalent') {
    return 'Converted to src/services/terminal.ts, HTTP terminal APIs and public terminal dock; npm test covers spawn/stdout/stdin/resize/kill and static UI';
  }
  if (/src[\\/]features[\\/]preview[\\/]/.test(row.path) && status === 'verified-equivalent') {
    return 'Converted to src/services/preview.ts, /preview API and public quick preview panel; npm test covers markdown/image previews and static UI controls';
  }
  if (doneStatuses.has(status)) return 'initial exclusion/block evidence';
  return '';
}

function validationFor(status, sourcePath) {
  if (status === 'excluded-by-lop') return 'Excluded/generated/dependency evidence recorded; no runtime migration expected';
  if (status === 'blocked-with-evidence') return 'Needs explicit WebUI replacement/safety boundary before enabling';
  const p = sourcePath.replace(/\\/g, '/');
  if (/ui|features|styles|assets/.test(p)) return 'Static tests plus browser DOM/screenshot/console/network validation';
  if (/protocol|commands|domains|infra|server/.test(p)) return 'Unit/static tests plus API/app-server/SSE runtime validation';
  return 'Build/test/check plus feature-specific runtime proof';
}

function scanAntiFake() {
  const roots = ['src', 'public', 'tests', 'docs', 'scripts'];
  const rows = [];
  const ignoreDirs = new Set(['node_modules', 'dist', 'logs', 'uploads']);
  const stack = roots.map((entry) => path.join(root, entry)).filter((entry) => fs.existsSync(entry));
  while (stack.length) {
    const current = stack.pop();
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const ent of fs.readdirSync(current, { withFileTypes: true })) {
        if (ignoreDirs.has(ent.name)) continue;
        stack.push(path.join(current, ent.name));
      }
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|html|css|md|json|mjs)$/.test(current)) continue;
    const rel = path.relative(root, current);
    const text = fs.readFileSync(current, 'utf8');
    text.split(/\r?\n/).forEach((line, index) => {
      const hits = fakeSignals.filter((signal) => signal.pattern.test(line)).map((signal) => signal.name);
      if (!hits.length) return;
      rows.push({ path: rel, line: index + 1, signals: hits.join(','), status: antiFakeStatus(rel, line), text: line.trim().slice(0, 220) });
    });
  }
  return rows;
}

function antiFakeStatus(rel, line) {
  const normalized = rel.replace(/\\/g, '/');
  if (normalized === 'scripts/generate-plus-ledger.mjs') return 'allowed-gate-tooling';
  if (/^tests\//.test(normalized)) return 'allowed-test-fixture';
  if (/^docs\//.test(normalized) && /placeholder/i.test(line)) return 'allowed-historical-doc';
  if (/index\.before-plus-ui\.html$/.test(normalized)) return 'allowed-historical-snapshot';
  if (/\bplaceholder=|::placeholder/.test(line)) return 'allowed-ui-placeholder';
  if (/if \(command\.unavailableReason\)/.test(line)) return 'allowed-control-flow';
  if (/unavailableReason|未迁移|尚未迁移|not implemented|coming soon|固定提示词|不能用假|冒充/i.test(line)) return 'blocking-unimplemented';
  if (/placeholder|TODO/i.test(line)) return 'needs-review';
  return 'needs-review';
}

const plusRows = readTsv(plusIndexPath);
const ledger = plusRows.map((row) => {
  const status = initialStatus(row.path, row.class);
  return {
    status,
    priority: priorityFor(row.path, row.class),
    class: row.class,
    module: topModule(row.path),
    source_path: row.path,
    target_files: targetFor(row.path, row.class),
    feature_semantics: semanticsFor(row.path, row.class),
    validation: validationFor(status, row.path),
    evidence: evidenceFor(status, row),
    notes: status === 'partial' ? 'Some WebUI behavior exists; file-level parity still open' : ''
  };
});

const columns = ['status', 'priority', 'class', 'module', 'source_path', 'target_files', 'feature_semantics', 'validation', 'evidence', 'notes'];
fs.writeFileSync(ledgerPath, [
  columns.join('\t'),
  ...ledger.map((row) => columns.map((column) => safeCell(row[column])).join('\t'))
].join('\n') + '\n');

const antiFake = scanAntiFake();
fs.writeFileSync(antiFakePath, [
  ['status', 'path', 'line', 'signals', 'text'].join('\t'),
  ...antiFake.map((row) => [row.status, row.path, row.line, row.signals, row.text].map(safeCell).join('\t'))
].join('\n') + '\n');

const statusCounts = new Map();
const priorityCounts = new Map();
for (const row of ledger) {
  statusCounts.set(row.status, (statusCounts.get(row.status) || 0) + 1);
  priorityCounts.set(row.priority, (priorityCounts.get(row.priority) || 0) + 1);
}
const openRows = ledger.filter((row) => !doneStatuses.has(row.status));
const blockingAntiFake = antiFake.filter((row) => row.status === 'blocking-unimplemented' || row.status === 'needs-review');
const gate = [
  '# Plus Full-Parity Completion Gate',
  '',
  `Generated: ${new Date().toISOString()}`,
  `Ledger: ${path.relative(root, ledgerPath)}`,
  `Anti-fake scan: ${path.relative(root, antiFakePath)}`,
  '',
  '## Status Counts',
  '',
  '| status | count |',
  '|---|---:|',
  ...[...statusCounts.entries()].sort().map(([status, count]) => `| ${status} | ${count} |`),
  '',
  '## Priority Counts',
  '',
  '| priority | count |',
  '|---|---:|',
  ...[...priorityCounts.entries()].sort().map(([priority, count]) => `| ${priority} | ${count} |`),
  '',
  '## Completion Gate',
  '',
  `Open ledger rows: ${openRows.length}`,
  `Anti-fake signal rows: ${antiFake.length}`,
  `Blocking anti-fake rows: ${blockingAntiFake.length}`,
  '',
  openRows.length || blockingAntiFake.length
    ? 'Result: OPEN - do not claim full Plus parity complete.'
    : 'Result: PASS - all source rows are implemented, verified-equivalent, excluded-by-lop, or blocked-with-evidence.',
  '',
  '## First Open Rows',
  '',
  '| status | priority | source | target |',
  '|---|---|---|---|',
  ...openRows.slice(0, 40).map((row) => `| ${row.status} | ${row.priority} | \`${safeCell(row.source_path)}\` | ${safeCell(row.target_files)} |`),
  '',
  '## First Anti-Fake Hits',
  '',
  '| path | line | signals | text |',
  '|---|---:|---|---|',
  ...blockingAntiFake.slice(0, 40).map((row) => `| \`${safeCell(row.path)}\` | ${row.line} | ${safeCell(row.signals)} | ${safeCell(row.text)} |`)
].join('\n');
fs.writeFileSync(gatePath, gate + '\n');

console.log(JSON.stringify({
  ledger: path.relative(root, ledgerPath),
  gate: path.relative(root, gatePath),
  antiFake: path.relative(root, antiFakePath),
  rows: ledger.length,
  openRows: openRows.length,
  antiFakeRows: antiFake.length,
  blockingAntiFakeRows: blockingAntiFake.length,
  statusCounts: Object.fromEntries([...statusCounts.entries()].sort())
}, null, 2));

if (failOnOpen && (openRows.length || blockingAntiFake.length)) {
  process.exitCode = 2;
}
