import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const appName = 'Codex WebUI';
const defaultUrl = process.env.CODEX_WEBUI_APP_URL || 'http://127.0.0.1:5055/?app=1';
const profileDir = process.env.CODEX_WEBUI_APP_PROFILE || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'CodexWebUI', 'AppShell');
const iconPath = path.join(root, 'public', 'icons', 'codex-webui.ico');

function parseArgs(argv) {
  const options = {
    browser: process.env.CODEX_WEBUI_BROWSER_KIND || 'chrome',
    dryRun: false,
    installShortcuts: false,
    launch: false,
    pinStart: true,
    skipServiceCheck: false,
    url: defaultUrl
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--install-shortcuts') options.installShortcuts = true;
    else if (arg === '--no-pin-start') options.pinStart = false;
    else if (arg === '--skip-service-check') options.skipServiceCheck = true;
    else if (arg === '--launch') options.launch = true;
    else if (arg.startsWith('--url=')) options.url = arg.slice('--url='.length);
    else if (arg === '--url' && argv[index + 1]) options.url = argv[++index];
    else if (arg.startsWith('--browser=')) options.browser = arg.slice('--browser='.length);
    else if (arg === '--browser' && argv[index + 1]) options.browser = argv[++index];
  }
  if (!options.installShortcuts && !options.dryRun) options.launch = true;
  return options;
}

function expandCandidate(candidate) {
  return candidate
    .replace('%ProgramFiles(x86)%', process.env['ProgramFiles(x86)'] || '')
    .replace('%ProgramFiles%', process.env.ProgramFiles || '')
    .replace('%LocalAppData%', process.env.LOCALAPPDATA || '');
}

function registryAppPath(exeName) {
  const keys = [
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`
  ];
  for (const key of keys) {
    const result = spawnSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) continue;
    const match = `${result.stdout}\n${result.stderr}`.match(/REG_SZ\s+(.+?)(?:\r?\n|$)/);
    if (match && existsSync(match[1].trim())) return match[1].trim();
  }
  return null;
}

function pathAppPath(exeName) {
  const result = spawnSync('where.exe', [exeName], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && existsSync(line)) || null;
}

function browserCandidates(kind) {
  const all = {
    edge: [
      '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%LocalAppData%\\Microsoft\\Edge\\Application\\msedge.exe',
      registryAppPath('msedge.exe'),
      pathAppPath('msedge.exe')
    ],
    chrome: [
      '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
      '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
      '%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe',
      registryAppPath('chrome.exe'),
      pathAppPath('chrome.exe')
    ]
  };
  const order = kind === 'edge' ? ['edge'] : ['chrome'];
  return order.flatMap((name) => all[name].map((candidate) => ({ name, path: candidate && expandCandidate(candidate) })));
}

function resolveBrowser(kind) {
  const explicit = process.env.CODEX_WEBUI_BROWSER;
  if (explicit && existsSync(explicit)) return { name: 'custom', path: explicit };
  for (const candidate of browserCandidates(kind)) {
    if (candidate.path && existsSync(candidate.path) && !candidate.path.includes('$Recycle.Bin')) return candidate;
  }
  throw new Error('No Chrome executable found. Set CODEX_WEBUI_BROWSER to the browser .exe path.');
}

function setPixel(buffer, width, height, x, y, rgba) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = ((height - 1 - y) * width + x) * 4;
  buffer[offset] = rgba[2];
  buffer[offset + 1] = rgba[1];
  buffer[offset + 2] = rgba[0];
  buffer[offset + 3] = rgba[3];
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function writeLine(buffer, width, height, ax, ay, bx, by, stroke, color) {
  const radius = stroke / 2;
  for (let y = Math.floor(Math.min(ay, by) - radius - 1); y <= Math.ceil(Math.max(ay, by) + radius + 1); y += 1) {
    for (let x = Math.floor(Math.min(ax, bx) - radius - 1); x <= Math.ceil(Math.max(ax, bx) + radius + 1); x += 1) {
      if (distanceToSegment(x + 0.5, y + 0.5, ax, ay, bx, by) <= radius) setPixel(buffer, width, height, x, y, color);
    }
  }
}

function roundedRectAlpha(x, y, size, radius) {
  const nx = x < radius ? radius - x : x >= size - radius ? x - (size - radius - 1) : 0;
  const ny = y < radius ? radius - y : y >= size - radius ? y - (size - radius - 1) : 0;
  return nx === 0 || ny === 0 || Math.hypot(nx, ny) <= radius ? 255 : 0;
}

function ensureIcoIcon() {
  if (existsSync(iconPath)) return iconPath;
  mkdirSync(path.dirname(iconPath), { recursive: true });
  const size = 64;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const alpha = roundedRectAlpha(x, y, size, 14);
      const border = x < 5 || y < 5 || x >= size - 5 || y >= size - 5;
      setPixel(pixels, size, size, x, y, border ? [45, 45, 45, alpha] : [2, 2, 2, alpha]);
    }
  }
  writeLine(pixels, size, size, 22, 22, 13, 32, 5, [255, 228, 95, 255]);
  writeLine(pixels, size, size, 13, 32, 22, 42, 5, [255, 228, 95, 255]);
  writeLine(pixels, size, size, 42, 22, 51, 32, 5, [255, 228, 95, 255]);
  writeLine(pixels, size, size, 51, 32, 42, 42, 5, [255, 228, 95, 255]);
  writeLine(pixels, size, size, 35, 18, 28, 46, 5, [77, 215, 200, 255]);
  for (let y = 25; y <= 39; y += 1) {
    for (let x = 25; x <= 39; x += 1) {
      if (Math.hypot(x - 32, y - 32) <= 7) setPixel(pixels, size, size, x, y, [255, 228, 95, 255]);
      if (Math.hypot(x - 32, y - 32) <= 2.6) setPixel(pixels, size, size, x, y, [2, 2, 2, 255]);
    }
  }

  const mask = Buffer.alloc(size * Math.ceil(size / 32) * 4);
  const bitmapHeader = Buffer.alloc(40);
  bitmapHeader.writeUInt32LE(40, 0);
  bitmapHeader.writeInt32LE(size, 4);
  bitmapHeader.writeInt32LE(size * 2, 8);
  bitmapHeader.writeUInt16LE(1, 12);
  bitmapHeader.writeUInt16LE(32, 14);
  bitmapHeader.writeUInt32LE(0, 16);
  bitmapHeader.writeUInt32LE(pixels.length, 20);
  const image = Buffer.concat([bitmapHeader, pixels, mask]);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size, 6);
  header.writeUInt8(size, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(image.length, 14);
  header.writeUInt32LE(header.length, 18);
  writeFileSync(iconPath, Buffer.concat([header, image]));
  return iconPath;
}

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function appArgs(url) {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-features=Translate'
  ];
}

function vbsString(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function createShortcut(shortcutPath, browser, url) {
  mkdirSync(path.dirname(shortcutPath), { recursive: true });
  const tempScript = path.join(os.tmpdir(), `codex-webui-shortcut-${process.pid}-${Date.now()}.vbs`);
  const vbs = [
    'Set shell = CreateObject("WScript.Shell")',
    `Set shortcut = shell.CreateShortcut(${vbsString(shortcutPath)})`,
    `shortcut.TargetPath = ${vbsString(browser.path)}`,
    `shortcut.Arguments = ${vbsString(appArgs(url).map(shellQuote).join(' '))}`,
    `shortcut.WorkingDirectory = ${vbsString(root)}`,
    `shortcut.IconLocation = ${vbsString(`${ensureIcoIcon()},0`)}`,
    `shortcut.Description = ${vbsString(appName)}`,
    'shortcut.Save'
  ].join('\r\n');
  writeFileSync(tempScript, vbs, 'utf8');
  try {
    const result = spawnSync('cscript.exe', ['//NoLogo', tempScript], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'cscript failed').trim());
  } finally {
    rmSync(tempScript, { force: true });
  }
}

function installShortcuts(browser, url) {
  const desktop = path.join(os.homedir(), 'Desktop', `${appName}.lnk`);
  const startMenu = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${appName}.lnk`);
  createShortcut(desktop, browser, url);
  createShortcut(startMenu, browser, url);
  return { desktop, startMenu };
}

function pinShortcutToStart(shortcutPath) {
  if (process.platform !== 'win32') return { ok: false, skipped: true, reason: 'pin-to-start is Windows-only' };
  const tempScript = path.join(os.tmpdir(), `codex-webui-pin-start-${process.pid}-${Date.now()}.vbs`);
  const shortcutDir = path.dirname(shortcutPath);
  const shortcutName = path.basename(shortcutPath);
  const vbs = [
    'On Error Resume Next',
    'Set shell = CreateObject("Shell.Application")',
    `Set folder = shell.Namespace(${vbsString(shortcutDir)})`,
    'If folder Is Nothing Then WScript.Quit 3',
    `Set item = folder.ParseName(${vbsString(shortcutName)})`,
    'If item Is Nothing Then WScript.Quit 4',
    'verbs = ""',
    'For Each verb In item.Verbs',
    '  rawName = verb.Name',
    '  verbs = verbs & "[" & rawName & "]"',
    '  name = LCase(Replace(rawName, "&", ""))',
    '  If InStr(name, "unpin from start") > 0 Or ((InStr(name, "取消固定") > 0 Or InStr(name, "取消钉选") > 0) And InStr(name, "开始") > 0) Then',
    '    WScript.Echo "already pinned"',
    '    WScript.Quit 0',
    '  End If',
    '  If InStr(name, "pin to start") > 0 Or InStr(name, "pin to start menu") > 0 Or InStr(name, "固定到开始") > 0 Or InStr(name, "固定到“开始”") > 0 Or InStr(name, "固定到开始菜单") > 0 Or InStr(name, "固定到开始屏幕") > 0 Then',
    '    verb.DoIt',
    '    WScript.Echo "pinned"',
    '    WScript.Quit 0',
    '  End If',
    'Next',
    'WScript.Echo "pin verb not available " & verbs',
    'WScript.Quit 2'
  ].join('\r\n');
  writeFileSync(tempScript, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]));
  try {
    const result = spawnSync('cscript.exe', ['//NoLogo', tempScript], { encoding: 'utf8', windowsHide: true });
    return {
      ok: result.status === 0,
      status: result.status,
      output: String(result.stdout || result.stderr || '').trim(),
      shortcut: shortcutPath
    };
  } finally {
    rmSync(tempScript, { force: true });
  }
}

function pinStartShortcuts(shortcuts) {
  const attempts = [];
  for (const shortcut of [shortcuts.startMenu, shortcuts.desktop]) {
    const result = pinShortcutToStart(shortcut);
    attempts.push(result);
    if (result.ok) return { ...result, attempts };
  }
  return { ok: false, status: attempts.at(-1)?.status ?? 2, output: attempts.at(-1)?.output || 'pin verb not available', attempts };
}

function runRecovery(args) {
  const script = path.join(root, 'scripts', 'webui-recover.mjs');
  if (!existsSync(script)) return { ok: false, error: `missing recovery script: ${script}` };
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout || '{}'); } catch {}
  return parsed || {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim()
  };
}

function ensureServiceReady() {
  const watchdog = runRecovery(['--mode', 'start-watchdog']);
  const ensure = runRecovery(['--mode', 'ensure']);
  return { watchdog, ensure };
}

async function probeHealth(url) {
  const target = new URL('/health', url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(target, { signal: controller.signal, cache: 'no-store' });
    return { ok: response.ok, status: response.status, url: target.href };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), url: target.href };
  } finally {
    clearTimeout(timeout);
  }
}

function launch(browser, url, shortcutPath = '') {
  mkdirSync(profileDir, { recursive: true });
  const appShortcut = shortcutPath || path.join(profileDir, `${appName}.lnk`);
  createShortcut(appShortcut, browser, url);
  const child = spawn('cmd.exe', ['/c', 'start', '', appShortcut], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  return { browser: browser.path, launcher: appShortcut, pid: child.pid, profileDir, url };
}

const options = parseArgs(process.argv.slice(2));
const browser = resolveBrowser(options.browser);
const plan = {
  appName,
  browser,
  iconPath: ensureIcoIcon(),
  profileDir,
  url: options.url
};

if (options.dryRun) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

let shortcuts = null;
if (options.installShortcuts) {
  shortcuts = installShortcuts(browser, options.url);
  const pinStart = options.pinStart ? pinStartShortcuts(shortcuts) : { ok: false, skipped: true, reason: 'disabled' };
  console.log(JSON.stringify({ ok: true, action: 'install-shortcuts', ...plan, shortcuts, pinStart }, null, 2));
}

if (options.launch) {
  const service = options.skipServiceCheck ? { skipped: true } : ensureServiceReady();
  const health = await probeHealth(options.url);
  const launched = launch(browser, options.url, shortcuts?.desktop);
  console.log(JSON.stringify({ ok: true, action: 'launch', ...plan, service, health, launched }, null, 2));
}
