#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_URL = 'http://127.0.0.1:5055/?debug_no_events=1';
const DEFAULT_RUNS = 3;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    runs: DEFAULT_RUNS,
    output: '',
    cases: '',
    list: false,
    startServer: true,
    keepProfiles: false,
    timeoutMs: 20000,
    switchTimeoutMs: 45000,
    workload: true,
    sessionSwitches: 4,
    candidateProbes: 12
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') options.url = argv[++i] || options.url;
    else if (arg === '--runs') options.runs = Math.max(1, Number(argv[++i] || options.runs) || options.runs);
    else if (arg === '--output') options.output = argv[++i] || '';
    else if (arg === '--cases') options.cases = argv[++i] || '';
    else if (arg === '--timeout-ms') options.timeoutMs = Math.max(3000, Number(argv[++i] || options.timeoutMs) || options.timeoutMs);
    else if (arg === '--switch-timeout-ms') options.switchTimeoutMs = Math.max(3000, Number(argv[++i] || options.switchTimeoutMs) || options.switchTimeoutMs);
    else if (arg === '--session-switches') options.sessionSwitches = Math.max(1, Number(argv[++i] || options.sessionSwitches) || options.sessionSwitches);
    else if (arg === '--candidate-probes') options.candidateProbes = Math.max(1, Number(argv[++i] || options.candidateProbes) || options.candidateProbes);
    else if (arg === '--list') options.list = true;
    else if (arg === '--no-start-server') options.startServer = false;
    else if (arg === '--keep-profiles') options.keepProfiles = true;
    else if (arg === '--no-workload') options.workload = false;
  }
  return options;
}

function stamp() {
  const d = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function uniqueExisting(paths) {
  const seen = new Set();
  const out = [];
  for (const item of paths.filter(Boolean)) {
    const resolved = path.resolve(item);
    const key = IS_WIN ? resolved.toLowerCase() : resolved;
    if (seen.has(key) || !existsSync(resolved)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function browserPaths() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LocalAppData || '';
  return {
    chrome: uniqueExisting([
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localAppData && path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'chrome.exe'
    ]),
    edge: uniqueExisting([
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      localAppData && path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      'msedge.exe'
    ])
  };
}

function findWebView2Runtime() {
  const base = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'EdgeWebView', 'Application');
  if (!existsSync(base)) return null;
  try {
    for (const version of readdirSync(base).sort().reverse()) {
      const exe = path.join(base, version, 'msedgewebview2.exe');
      if (existsSync(exe)) return exe;
    }
  } catch {}
  return null;
}

function buildCases() {
  const paths = browserPaths();
  const cases = [];
  if (paths.chrome[0]) {
    cases.push({ id: 'chrome-window-clean', browser: 'Chrome', mode: 'window', exe: paths.chrome[0], notes: 'Chrome new-window with isolated temporary profile.' });
    cases.push({ id: 'chrome-app-clean', browser: 'Chrome', mode: 'app', exe: paths.chrome[0], notes: 'Chrome app mode with isolated temporary profile.' });
  }
  if (paths.edge[0]) {
    cases.push({ id: 'edge-window-clean', browser: 'Edge', mode: 'window', exe: paths.edge[0], notes: 'Edge new-window with isolated temporary profile.' });
    cases.push({ id: 'edge-app-clean', browser: 'Edge', mode: 'app', exe: paths.edge[0], notes: 'Edge app mode with isolated temporary profile; closest zero-build desktop shell available here.' });
  }
  return {
    cases,
    skipped: [
      {
        id: 'webview2-host',
        available: Boolean(findWebView2Runtime()),
        reason: findWebView2Runtime()
          ? 'WebView2 runtime exists, but no local WebView2 host app is present to benchmark.'
          : 'WebView2 runtime host executable was not found.'
      },
      {
        id: 'tauri-host',
        available: existsSync(path.join(ROOT, 'src-tauri')),
        reason: existsSync(path.join(ROOT, 'src-tauri'))
          ? 'Tauri project exists but is not included in this WebUI tree benchmark.'
          : 'No src-tauri project exists in this WebUI tree.'
      }
    ]
  };
}

async function fetchText(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function ensureTarget(url, startServer) {
  const origin = new URL(url).origin;
  try {
    const health = await fetchText(`${origin}/health`, 2000);
    if (health.ok) return { origin, started: false, child: null, health };
  } catch {}
  if (!startServer) throw new Error(`Target is not reachable: ${origin}`);
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: new URL(url).port || '5055',
      HOST: '127.0.0.1',
      CODEX_RESUME: '0',
      CODEX_WEBUI_CLI_AUTO_UPDATE: '0'
    }
  });
  for (let i = 0; i < 80; i += 1) {
    try {
      const health = await fetchText(`${origin}/health`, 1000);
      if (health.ok) return { origin, started: true, child, health };
    } catch {}
    await wait(150);
  }
  try { child.kill(); } catch {}
  throw new Error(`Failed to start target server: ${origin}`);
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { ...options, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function processRows() {
  if (!IS_WIN) return [];
  const result = await execFilePromise('wmic', ['process', 'get', 'Name,ProcessId,ParentProcessId,WorkingSetSize', '/format:csv']);
  if (result.error || !result.stdout.trim()) return [];
  const rows = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Node,')) continue;
    const parts = trimmed.split(',');
    if (parts.length < 5) continue;
    rows.push({
      name: parts[1],
      parentPid: Number(parts[2]) || 0,
      pid: Number(parts[3]) || 0,
      workingSet: Number(parts[4]) || 0
    });
  }
  return rows;
}

async function processTreeMemory(rootPid) {
  const rows = await processRows();
  if (!rows.length) return null;
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.parentPid)) byParent.set(row.parentPid, []);
    byParent.get(row.parentPid).push(row);
  }
  const seen = new Set();
  const stack = [rootPid];
  const tree = [];
  while (stack.length) {
    const pid = stack.pop();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.find((item) => item.pid === pid);
    if (row) tree.push(row);
    for (const child of byParent.get(pid) || []) stack.push(child.pid);
  }
  if (!tree.length) return null;
  return {
    processCount: tree.length,
    workingSetMb: Math.round(tree.reduce((sum, item) => sum + item.workingSet, 0) / 1024 / 1024 * 10) / 10,
    names: [...new Set(tree.map((item) => item.name).filter(Boolean))].sort()
  };
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => this.handleMessage(event.data));
  }

  static async connect(url) {
    if (typeof WebSocket === 'undefined') throw new Error('Node.js WebSocket is unavailable.');
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 8000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket error')); }, { once: true });
    });
    return new CdpClient(ws);
  }

  handleMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result || {});
      return;
    }
    this.events.push(message);
    if (this.events.length > 400) this.events.shift();
  }

  send(method, params = {}, sessionId = '', timeoutMs = 10000) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async waitForEvent(method, sessionId, timeoutMs = 10000) {
    const started = Date.now();
    let cursor = 0;
    while (Date.now() - started < timeoutMs) {
      const next = this.events.slice(cursor).find((event) => event.method === method && (!sessionId || event.sessionId === sessionId));
      if (next) return next.params || {};
      cursor = this.events.length;
      await wait(25);
    }
    throw new Error(`Timed out waiting for ${method}`);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function waitForDevTools(profileDir, timeoutMs) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const text = await readFile(file, 'utf8');
      const [port, browserPath] = text.trim().split(/\r?\n/);
      if (port && browserPath) return `ws://127.0.0.1:${port}${browserPath}`;
    } catch {}
    await wait(50);
  }
  throw new Error('DevToolsActivePort was not created.');
}

async function attachFirstPage(client) {
  const targets = await client.send('Target.getTargets');
  let page = (targets.targetInfos || []).find((target) => target.type === 'page');
  if (!page) {
    const created = await client.send('Target.createTarget', { url: 'about:blank' });
    page = { targetId: created.targetId };
  }
  const attached = await client.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  return attached.sessionId;
}

async function evaluate(client, sessionId, expression, awaitPromise = false, timeoutMs = 10000) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  }, sessionId, timeoutMs);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'Runtime evaluation failed';
    throw new Error(text);
  }
  return result.result?.value;
}

const SNAPSHOT_EXPR = `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || null;
  const paints = Object.fromEntries(performance.getEntriesByType('paint').map((item) => [item.name, item.startTime]));
  const debug = typeof window.__codexWebuiDebug === 'function' ? window.__codexWebuiDebug() : null;
  const timeline = document.querySelector('.timeline');
  return {
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    hasDebug: Boolean(debug),
    debug,
    bodyTextLength: document.body ? document.body.innerText.length : 0,
    activeElementId: document.activeElement ? document.activeElement.id : '',
    counts: {
      messages: document.querySelectorAll('.bubble').length,
      timelineCards: document.querySelectorAll('.timeline-card').length,
      threadItems: document.querySelectorAll('.thread-item, .workspace-thread-item').length,
      projectItems: document.querySelectorAll('.project-item, .workspace-root-row').length
    },
    viewport: { width: innerWidth, height: innerHeight },
    timing: {
      now: performance.now(),
      domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
      loadEventMs: nav ? nav.loadEventEnd : null,
      firstPaintMs: paints['first-paint'] || null,
      firstContentfulPaintMs: paints['first-contentful-paint'] || null
    },
    scroll: timeline ? { scrollHeight: timeline.scrollHeight, clientHeight: timeline.clientHeight } : null
  };
})()`;

const SSE_EXPR = `new Promise((resolve) => {
  const started = performance.now();
  let settled = false;
  const done = (value) => {
    if (settled) return;
    settled = true;
    try { source.close(); } catch {}
    clearTimeout(timer);
    resolve(value);
  };
  const source = new EventSource('/events');
  const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), 5000);
  source.addEventListener('status', () => done({ ok: true, firstStatusEventMs: performance.now() - started }));
  source.onerror = () => done({ ok: false, error: 'error', elapsedMs: performance.now() - started });
})`;

const SCROLL_EXPR = `new Promise((resolve) => {
  const el = document.querySelector('.timeline') || document.scrollingElement;
  if (!el) return resolve({ ok: false, error: 'no scroll container' });
  const frames = [];
  const started = performance.now();
  let last = started;
  let count = 0;
  const timer = setTimeout(() => {
    resolve({
      ok: false,
      error: 'scroll benchmark timeout',
      frames: frames.length,
      avgFrameMs: frames.length ? frames.reduce((sum, item) => sum + item, 0) / frames.length : null,
      maxFrameMs: frames.length ? Math.max(...frames) : null,
      longFrames: frames.filter((item) => item > 20).length,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight
    });
  }, 4000);
  function step() {
    const now = performance.now();
    frames.push(now - last);
    last = now;
    el.scrollTop = count % 2 ? 0 : el.scrollHeight;
    count += 1;
    if (count < 80) requestAnimationFrame(step);
    else {
      clearTimeout(timer);
      const totalMs = performance.now() - started;
      const avgFrameMs = frames.reduce((sum, item) => sum + item, 0) / frames.length;
      resolve({
        ok: true,
        totalMs,
        avgFrameMs,
        maxFrameMs: Math.max(...frames),
        longFrames: frames.filter((item) => item > 20).length,
        frames: frames.length,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight
      });
    }
  }
  requestAnimationFrame(step);
})`;

function targetSessionsExpression(targetLimit, probeLimit) {
  const targets = Math.max(1, Number(targetLimit) || 4);
  const probes = Math.max(targets, Number(probeLimit) || 12);
  return `new Promise(async (resolve) => {
    const normalize = (value) => String(value || '').replace(/\\\\/g, '/').toLowerCase();
    const basename = (value) => String(value || '').split(/[\\\\/]/).filter(Boolean).pop() || String(value || '');
    const messageText = (message) => {
      if (message == null) return '';
      if (typeof message === 'string') return message;
      const direct = [message.text, message.content, message.message, message.output, message.summary]
        .filter((item) => typeof item === 'string' && item)
        .join('\\n');
      if (direct) return direct;
      try { return JSON.stringify(message); } catch { return String(message); }
    };
    try {
      const response = await fetch('/sessions', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.sessions)) throw new Error(data.error || 'sessions response is not an array');
      const currentKey = normalize(data.current || '');
      const ranked = data.sessions
        .filter((session) => session && session.path)
        .map((session) => ({
          path: session.path,
          key: normalize(session.path),
          title: session.name || basename(session.path),
          cwd: session.cwd || '',
          projectRoot: session.projectRoot || '',
          messageCount: Number(session.messageCount || 0) || 0,
          size: Number(session.size || 0) || 0,
          mtimeMs: Number(session.mtimeMs || session.last_used || 0) || 0
        }))
        .sort((a, b) => ((b.messageCount * 100000) + b.size) - ((a.messageCount * 100000) + a.size));
      const nonCurrent = ranked.filter((session) => session.key !== currentKey);
      const probeList = (nonCurrent.length >= ${targets} ? nonCurrent : ranked).slice(0, ${probes});
      const probed = [];
      for (const session of probeList) {
        let parsedMessages = 0;
        let parsedChars = 0;
        let parseOk = false;
        try {
          const messagesResponse = await fetch('/session-messages?path=' + encodeURIComponent(session.path), { cache: 'no-store' });
          const messagesData = await messagesResponse.json();
          const messages = Array.isArray(messagesData.messages) ? messagesData.messages : [];
          parsedMessages = messages.length;
          parsedChars = messages.reduce((sum, message) => sum + messageText(message).length, 0);
          parseOk = messagesResponse.ok;
        } catch {}
        probed.push({
          ...session,
          parsedMessages,
          parsedChars,
          parseOk,
          longScore: parsedChars + parsedMessages * 1000 + Math.min(session.size, 2 * 1024 * 1024) / 1000
        });
      }
      probed.sort((a, b) => b.longScore - a.longScore);
      resolve({
        ok: true,
        selectionMode: 'api-longest',
        totalSessions: ranked.length,
        probedCount: probed.length,
        currentKey,
        targets: probed.slice(0, ${targets})
      });
    } catch (error) {
      resolve({ ok: false, error: error.message || String(error), selectionMode: 'api-longest' });
    }
  })`;
}

const VISIBLE_SESSIONS_EXPR = `new Promise((resolve) => {
  const selector = '.thread-item[data-session-key],.workspace-thread-item[data-session-key]';
  const compactText = (value) => String(value || '').trim().replace(/[\\s]+/g, ' ');
  const parseCount = (text) => {
    const match = String(text || '').match(/([0-9]+)[ ]*条/);
    return match ? Number(match[1]) || 0 : 0;
  };
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  for (const button of document.querySelectorAll('.sidebar-overflow-btn')) {
    const text = compactText(button.innerText);
    if (visible(button) && /显示/.test(text)) button.click();
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const buttons = Array.from(document.querySelectorAll(selector)).filter(visible);
    resolve({
      ok: true,
      totalVisible: buttons.length,
      sessions: buttons.map((button, index) => {
        const text = compactText(button.innerText).slice(0, 240);
        return {
          index,
          key: button.dataset.sessionKey || '',
          text,
          count: parseCount(text),
          active: button.classList.contains('active') || button.getAttribute('aria-current') === 'page'
        };
      })
    });
  }));
})`;

function switchSessionExpression(candidate, timeoutMs) {
  const targetIndex = Number(candidate?.index) || 0;
  const targetPath = JSON.stringify(candidate?.path || '');
  const targetKey = JSON.stringify(candidate?.key || '');
  const expectedMessages = Math.max(0, Number(candidate?.parsedMessages || candidate?.messageCount || 0) || 0);
  const expectedChars = Math.max(0, Number(candidate?.parsedChars || 0) || 0);
  const timeout = Math.max(3000, Number(timeoutMs) || 15000);
  return `new Promise((resolve) => {
    const selector = '.thread-item[data-session-key],.workspace-thread-item[data-session-key]';
    const normalize = (value) => String(value || '').replace(/\\\\/g, '/').toLowerCase();
    const targetPath = ${targetPath};
    const targetKey = ${targetKey};
    const expectedMessages = ${expectedMessages};
    const expectedChars = ${expectedChars};
    const expectedKey = targetKey || normalize(targetPath);
    const targetIndex = ${targetIndex};
    const compactText = (value) => String(value || '').trim().replace(/[\\s]+/g, ' ');
    const afterFrames = (count = 2) => new Promise((done) => {
      const step = () => {
        count -= 1;
        if (count <= 0) done();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const revealTarget = async () => {
      const sideFilter = document.getElementById('sideFilter');
      if (targetPath && sideFilter) {
        sideFilter.value = targetPath;
        sideFilter.dispatchEvent(new Event('input', { bubbles: true }));
        await afterFrames(2);
      }
      const buttons = Array.from(document.querySelectorAll(selector));
      let target = expectedKey ? buttons.find((button) => button.dataset.sessionKey === expectedKey) : null;
      if (!target && targetPath && sideFilter) {
        sideFilter.value = targetPath.split(/[\\\\/]/).filter(Boolean).pop() || targetPath;
        sideFilter.dispatchEvent(new Event('input', { bubbles: true }));
        await afterFrames(2);
        const retryButtons = Array.from(document.querySelectorAll(selector));
        target = expectedKey ? retryButtons.find((button) => button.dataset.sessionKey === expectedKey) : retryButtons[targetIndex];
      }
      if (!target) target = Array.from(document.querySelectorAll(selector))[targetIndex];
      return target || null;
    };
    (async () => {
      const benchSwitch = window.__codexWebuiBench && typeof window.__codexWebuiBench.switchToPath === 'function'
        ? window.__codexWebuiBench.switchToPath
        : null;
      const target = benchSwitch && targetPath ? null : await revealTarget();
      if (!target && !benchSwitch) return resolve({ ok: false, error: 'target session button not found', targetIndex, targetKey: expectedKey, targetPath });
      const clickable = target?.classList?.contains('workspace-thread-item') ? (target.querySelector('button') || target) : target;
      const started = performance.now();
      let benchSwitchError = '';
      const longTasks = [];
      let observer = null;
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch {}
      let inputReadyAt = null;
      let inputFocusedAt = null;
      let renderCompleteAt = null;
      let readyFrames = 0;
      let settled = false;
      const snapshot = () => {
        const log = document.getElementById('log') || document.querySelector('.timeline');
        const text = document.getElementById('text');
        const timeline = document.getElementById('timeline') || document.querySelector('.timeline') || document.scrollingElement;
        const bubbleCount = document.querySelectorAll('.bubble').length;
        const cardCount = document.querySelectorAll('.timeline-card').length;
        const timelineItems = document.querySelectorAll('.timeline-item,.timeline-card,.bubble').length;
        const bodyChars = timeline ? (timeline.innerText || '').length : (document.body?.innerText || '').length;
        const activeNode = expectedKey ? Array.from(document.querySelectorAll('[data-session-key]')).find((node) => node.dataset.sessionKey === expectedKey) : null;
        const activeTarget = activeNode
          ? (activeNode.getAttribute('aria-current') === 'true' || activeNode.classList.contains('active') || activeNode.classList.contains('workspace-thread-item-active'))
          : true;
        const switching = Boolean(log && log.classList.contains('timeline-switching'));
        const inputReady = Boolean(text && !text.disabled && !text.readOnly && getComputedStyle(text).visibility !== 'hidden');
        if (inputReady && inputReadyAt === null) {
          inputReadyAt = performance.now() - started;
          try { text.focus({ preventScroll: true }); } catch { try { text.focus(); } catch {} }
        }
        if (inputReady && document.activeElement === text && inputFocusedAt === null) inputFocusedAt = performance.now() - started;
        return {
          bubbleCount,
          cardCount,
          timelineItems,
          bodyChars,
          activeTarget,
          switching,
          inputReady,
          inputFocused: document.activeElement === text,
          scrollHeight: timeline ? timeline.scrollHeight : null,
          clientHeight: timeline ? timeline.clientHeight : null
        };
      };
      const finish = (ok, error, state) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { observer?.disconnect(); } catch {}
        const elapsedMs = performance.now() - started;
        resolve({
          ok,
          error: error || '',
          targetIndex,
          targetKey: expectedKey,
          targetPath,
          targetText: compactText(target?.innerText || targetPath).slice(0, 240),
          benchSwitchError,
          renderCompleteMs: renderCompleteAt,
          inputReadyMs: inputReadyAt,
          inputFocusedMs: inputFocusedAt,
          elapsedMs,
          state,
          longTasks: {
            count: longTasks.length,
            maxMs: longTasks.length ? Math.max(...longTasks.map((item) => item.duration)) : 0,
            totalMs: longTasks.reduce((sum, item) => sum + item.duration, 0)
          }
        });
      };
      const timer = setTimeout(() => finish(false, 'session switch timeout', snapshot()), ${timeout});
      if (benchSwitch && targetPath) {
        try {
          Promise.resolve(benchSwitch.call(window.__codexWebuiBench, targetPath)).catch((error) => {
            benchSwitchError = error.message || String(error);
          });
        } catch (error) {
          benchSwitchError = error.message || String(error);
        }
      } else {
        clickable.click();
      }
      const scheduleTick = () => {
        let fired = false;
        const fallback = setTimeout(() => {
          if (fired || settled) return;
          fired = true;
          tick();
        }, 50);
        requestAnimationFrame(() => {
          if (fired || settled) return;
          fired = true;
          clearTimeout(fallback);
          tick();
        });
      };
      const tick = () => {
        if (settled) return;
        const state = snapshot();
        const hasExpectedContent = expectedMessages > 0
          ? (state.timelineItems > 0 || state.bubbleCount > 0 || state.bodyChars >= Math.max(120, Math.min(expectedChars * 0.05, 1200)))
          : true;
        if (inputReadyAt !== null && state.activeTarget && hasExpectedContent && !state.switching) readyFrames += 1;
        else readyFrames = 0;
        if (readyFrames >= 4) {
          renderCompleteAt = performance.now() - started;
          finish(true, '', state);
        } else {
          scheduleTick();
        }
      };
      scheduleTick();
    })().catch((error) => resolve({ ok: false, error: error.message || String(error), targetIndex, targetKey: expectedKey, targetPath }));
  })`;
}

function historyPagingExpression(maxSteps = 90) {
  const stepCap = Math.max(16, Number(maxSteps) || 90);
  return `new Promise((resolve) => {
    const el = document.getElementById('timeline') || document.querySelector('.timeline') || document.scrollingElement;
    if (!el) return resolve({ ok: false, error: 'no timeline scroll container' });
    const frames = [];
    const started = performance.now();
    let last = started;
    const scrollable = Math.max(0, el.scrollHeight - el.clientHeight);
    const pages = Math.max(1, Math.ceil(scrollable / Math.max(1, el.clientHeight * 0.85)));
    const steps = Math.min(${stepCap}, Math.max(16, pages * 2));
    const half = Math.ceil(steps / 2);
    let count = 0;
    let settled = false;
    el.scrollTop = el.scrollHeight;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const totalMs = performance.now() - started;
      const avgFrameMs = frames.length ? frames.reduce((sum, item) => sum + item, 0) / frames.length : null;
      resolve({
        ok,
        error: error || '',
        totalMs,
        avgFrameMs,
        maxFrameMs: frames.length ? Math.max(...frames) : null,
        longFrames20: frames.filter((item) => item > 20).length,
        longFrames50: frames.filter((item) => item > 50).length,
        frames: frames.length,
        steps,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollable
      });
    };
    const timer = setTimeout(() => finish(false, 'history paging timeout'), Math.max(12000, steps * 1500));
    const tick = () => {
      if (settled) return;
      const now = performance.now();
      frames.push(now - last);
      last = now;
      const direction = count < half ? -1 : 1;
      el.scrollTop += direction * Math.max(1, el.clientHeight * 0.88);
      count += 1;
      if (count >= steps) finish(true, '');
      else schedule();
    };
    const schedule = () => {
      let fired = false;
      const fallback = setTimeout(() => {
        if (fired || settled) return;
        fired = true;
        tick();
      }, 50);
      requestAnimationFrame(() => {
        if (fired || settled) return;
        fired = true;
        clearTimeout(fallback);
        tick();
      });
    };
    schedule();
  })`;
}

async function waitForSnapshot(client, sessionId, timeoutMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await evaluate(client, sessionId, SNAPSHOT_EXPR);
    if (last.readyState === 'complete' && last.hasDebug && last.activeElementId === 'text') return last;
    await wait(100);
  }
  return last;
}

function chooseWorkloadCandidates(sessions, limit) {
  const scored = sessions
    .map((session) => ({
      ...session,
      score: (Number(session.count) || 0) * 1000 + String(session.text || '').length
    }))
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? 1 : -1;
      return b.score - a.score;
    });
  const selected = [];
  const seen = new Set();
  for (const session of scored) {
    const key = session.key || `${session.index}:${session.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(session);
    if (selected.length >= limit) break;
  }
  return selected;
}

async function measureConversationWorkload(client, sessionId, options) {
  if (!options.workload) return { ok: false, skipped: 'disabled' };
  const targetList = await evaluate(
    client,
    sessionId,
    targetSessionsExpression(options.sessionSwitches, Math.max(options.candidateProbes, options.sessionSwitches)),
    true,
    Math.max(20000, options.timeoutMs)
  ).catch((error) => ({ ok: false, error: error.message, selectionMode: 'api-longest' }));
  let candidates = targetList.ok ? (targetList.targets || []) : [];
  let fallbackVisible = null;
  if (!candidates.length) {
    fallbackVisible = await evaluate(client, sessionId, VISIBLE_SESSIONS_EXPR, true).catch((error) => ({
      ok: false,
      error: error.message
    }));
  }
  if (!candidates.length && fallbackVisible?.ok) candidates = chooseWorkloadCandidates(fallbackVisible.sessions || [], options.sessionSwitches);
  if (!candidates.length) return {
    ok: false,
    error: targetList.error || fallbackVisible?.error || 'no history sessions found',
    targetList,
    visible: fallbackVisible
  };
  const switches = [];
  const switchTimeoutMs = options.switchTimeoutMs;
  for (const candidate of candidates) {
    await client.send('Page.bringToFront', {}, sessionId).catch(() => {});
    const switched = await evaluate(client, sessionId, switchSessionExpression(candidate, switchTimeoutMs), true, switchTimeoutMs + 10000)
      .catch((error) => ({ ok: false, error: error.message }));
    await client.send('Page.bringToFront', {}, sessionId).catch(() => {});
    const paging = switched.ok
      ? await evaluate(client, sessionId, historyPagingExpression(16), true, 30000).catch((error) => ({ ok: false, error: error.message }))
      : null;
    switches.push({ candidate, switch: switched, paging });
    await wait(120);
  }
  return {
    ok: switches.some((item) => item.switch?.ok),
    selectionMode: targetList.ok ? targetList.selectionMode : 'visible-fallback',
    totalSessions: targetList.totalSessions || null,
    probedCount: targetList.probedCount || null,
    visibleCount: fallbackVisible?.totalVisible || null,
    selectedCount: candidates.length,
    selected: candidates,
    switches
  };
}

async function launchCase(testCase, runIndex, options, runDir) {
  const profileDir = path.join(runDir, 'profiles', `${testCase.id}-${runIndex}`);
  await mkdir(profileDir, { recursive: true });
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--enable-precise-memory-info',
    '--window-size=1440,960'
  ];
  if (testCase.mode === 'app') args.push('--app=about:blank');
  else args.push('--new-window', 'about:blank');

  const startedAt = performance.now();
  const child = spawn(testCase.exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const stderrChunks = [];
  child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk).toString('utf8')));
  let client = null;
  try {
    const wsUrl = await waitForDevTools(profileDir, options.timeoutMs);
    client = await CdpClient.connect(wsUrl);
    const sessionId = await attachFirstPage(client);
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Performance.enable', {}, sessionId).catch(() => {});
    const loadPromise = client.waitForEvent('Page.loadEventFired', sessionId, options.timeoutMs).catch(() => null);
    await client.send('Page.navigate', { url: options.url }, sessionId);
    await loadPromise;
    const snapshot = await waitForSnapshot(client, sessionId, options.timeoutMs);
    await client.send('Page.bringToFront', {}, sessionId).catch(() => {});
    const readyMs = performance.now() - startedAt;
    const sse = await evaluate(client, sessionId, SSE_EXPR, true).catch((error) => ({ ok: false, error: error.message }));
    const scroll = await evaluate(client, sessionId, SCROLL_EXPR, true).catch((error) => ({ ok: false, error: error.message }));
    const workload = await measureConversationWorkload(client, sessionId, options);
    const perfMetricsRaw = await client.send('Performance.getMetrics', {}, sessionId).catch(() => ({ metrics: [] }));
    const perfMetrics = Object.fromEntries((perfMetricsRaw.metrics || []).map((item) => [item.name, item.value]));
    const memory = await processTreeMemory(child.pid).catch(() => null);
    await client.send('Browser.close').catch(() => {});
    await wait(500);
    return {
      id: testCase.id,
      browser: testCase.browser,
      mode: testCase.mode,
      run: runIndex,
      ok: true,
      readyMs,
      snapshot,
      sse,
      workload,
      scroll,
      performance: {
        jsHeapUsedMb: perfMetrics.JSHeapUsedSize ? Math.round(perfMetrics.JSHeapUsedSize / 1024 / 1024 * 10) / 10 : null,
        jsHeapTotalMb: perfMetrics.JSHeapTotalSize ? Math.round(perfMetrics.JSHeapTotalSize / 1024 / 1024 * 10) / 10 : null,
        nodes: perfMetrics.Nodes || null,
        layoutCount: perfMetrics.LayoutCount || null,
        recalcStyleCount: perfMetrics.RecalcStyleCount || null
      },
      memory,
      stderr: stderrChunks.join('').trim().slice(0, 1000)
    };
  } catch (error) {
    return {
      id: testCase.id,
      browser: testCase.browser,
      mode: testCase.mode,
      run: runIndex,
      ok: false,
      error: error.message,
      stderr: stderrChunks.join('').trim().slice(0, 1000)
    };
  } finally {
    client?.close();
    if (!child.killed) {
      try { child.kill(); } catch {}
    }
    if (IS_WIN && child.pid) {
      await execFilePromise('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => null);
    }
    if (!options.keepProfiles) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function median(values) {
  const filtered = values.filter((item) => Number.isFinite(item)).sort((a, b) => a - b);
  if (!filtered.length) return null;
  const mid = Math.floor(filtered.length / 2);
  return filtered.length % 2 ? filtered[mid] : (filtered[mid - 1] + filtered[mid]) / 2;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function workloadItems(okRuns) {
  return okRuns.flatMap((run) => run.workload?.switches || []);
}

function summarize(results) {
  const byCase = new Map();
  for (const result of results) {
    if (!byCase.has(result.id)) byCase.set(result.id, []);
    byCase.get(result.id).push(result);
  }
  return [...byCase.entries()].map(([id, runs]) => {
    const okRuns = runs.filter((run) => run.ok);
    const scrollOkRuns = okRuns.filter((run) => run.scroll?.ok).length;
    const scrollErrors = [...new Set(okRuns.map((run) => run.scroll?.error).filter(Boolean))];
    const workloads = okRuns.map((run) => run.workload).filter(Boolean);
    const switchItems = workloadItems(okRuns);
    const okSwitchItems = switchItems.filter((item) => item.switch?.ok);
    const okPagingItems = switchItems.filter((item) => item.paging?.ok);
    const workloadErrors = [...new Set(workloads.map((item) => item.error || item.skipped).filter(Boolean))];
    const switchErrors = [...new Set(switchItems.map((item) => item.switch?.error).filter(Boolean))];
    return {
      id,
      browser: runs[0]?.browser || '',
      mode: runs[0]?.mode || '',
      runs: runs.length,
      okRuns: okRuns.length,
      readyMs: round(median(okRuns.map((run) => run.readyMs))),
      domContentLoadedMs: round(median(okRuns.map((run) => run.snapshot?.timing?.domContentLoadedMs))),
      loadEventMs: round(median(okRuns.map((run) => run.snapshot?.timing?.loadEventMs))),
      fcpMs: round(median(okRuns.map((run) => run.snapshot?.timing?.firstContentfulPaintMs))),
      sseFirstStatusMs: round(median(okRuns.map((run) => run.sse?.firstStatusEventMs))),
      workloadOkRuns: workloads.filter((item) => item.ok).length,
      workloadError: workloadErrors.join('; '),
      availableHistory: round(median(workloads.map((item) => item.totalSessions ?? item.visibleCount)), 0),
      probedHistory: round(median(workloads.map((item) => item.probedCount)), 0),
      selectedHistory: round(median(workloads.map((item) => item.selectedCount)), 0),
      switchAttempts: switchItems.length,
      switchSamples: okSwitchItems.length,
      switchError: switchErrors.join('; '),
      switchRenderMs: round(median(okSwitchItems.map((item) => item.switch?.renderCompleteMs))),
      switchInputReadyMs: round(median(okSwitchItems.map((item) => item.switch?.inputReadyMs))),
      switchInputFocusedMs: round(median(okSwitchItems.map((item) => item.switch?.inputFocusedMs))),
      switchLongTaskMaxMs: round(median(okSwitchItems.map((item) => item.switch?.longTasks?.maxMs))),
      renderedItems: round(median(okSwitchItems.map((item) => item.switch?.state?.timelineItems)), 0),
      renderedChars: round(median(okSwitchItems.map((item) => item.switch?.state?.bodyChars)), 0),
      renderedScrollHeight: round(median(okSwitchItems.map((item) => item.switch?.state?.scrollHeight)), 0),
      pagingSamples: okPagingItems.length,
      pagingAvgFrameMs: round(median(okPagingItems.map((item) => item.paging?.avgFrameMs)), 2),
      pagingMaxFrameMs: round(median(okPagingItems.map((item) => item.paging?.maxFrameMs)), 2),
      pagingLongFrames20: round(median(okPagingItems.map((item) => item.paging?.longFrames20)), 0),
      pagingLongFrames50: round(median(okPagingItems.map((item) => item.paging?.longFrames50)), 0),
      scrollAvgFrameMs: round(median(okRuns.map((run) => run.scroll?.avgFrameMs)), 2),
      scrollMaxFrameMs: round(median(okRuns.map((run) => run.scroll?.maxFrameMs)), 2),
      scrollLongFrames: round(median(okRuns.map((run) => run.scroll?.longFrames)), 0),
      scrollOkRuns,
      scrollError: scrollErrors.join('; '),
      jsHeapUsedMb: round(median(okRuns.map((run) => run.performance?.jsHeapUsedMb))),
      workingSetMb: round(median(okRuns.map((run) => run.memory?.workingSetMb))),
      processCount: round(median(okRuns.map((run) => run.memory?.processCount)), 0),
      messages: round(median(okRuns.map((run) => run.snapshot?.counts?.messages)), 0),
      threadItems: round(median(okRuns.map((run) => run.snapshot?.counts?.threadItems)), 0),
      error: okRuns.length ? '' : runs.map((run) => run.error).filter(Boolean).join('; ')
    };
  });
}

function bestBy(summary, key) {
  const candidates = summary.filter((item) => Number.isFinite(item[key]));
  if (!candidates.length) return null;
  return candidates.reduce((best, item) => item[key] < best[key] ? item : best, candidates[0]);
}

function ratioText(value, base) {
  if (!Number.isFinite(value) || !Number.isFinite(base) || base === 0) return '';
  const delta = round(value - base, 1);
  const ratio = round(value / base, 2);
  return `${delta >= 0 ? '+' : ''}${delta} ms / ${ratio}x`;
}

function markdownReport(payload) {
  const baseline = payload.summary.find((item) => item.id === 'chrome-window-clean') || payload.summary[0];
  const readyBest = bestBy(payload.summary, 'readyMs');
  const memoryBest = bestBy(payload.summary, 'workingSetMb');
  const switchBest = bestBy(payload.summary, 'switchRenderMs');
  const inputBest = bestBy(payload.summary, 'switchInputReadyMs');
  const pagingBest = bestBy(payload.summary, 'pagingMaxFrameMs');
  const lines = [];
  lines.push('# Codex WebUI Browser Shell Benchmark');
  lines.push('');
  lines.push(`- Time: ${payload.createdAt}`);
  lines.push(`- URL: \`${payload.url}\``);
  lines.push(`- Runs per case: ${payload.runs}`);
  lines.push(`- History switches per run: ${payload.sessionSwitches}`);
  lines.push(`- Long-session API probes per run: ${payload.candidateProbes}`);
  lines.push(`- Switch timeout: ${payload.switchTimeoutMs} ms`);
  lines.push(`- Baseline: ${baseline ? baseline.id : 'none'}`);
  lines.push(`- Fastest history switch render: ${switchBest ? `${switchBest.id} (${switchBest.switchRenderMs} ms)` : 'unavailable'}`);
  lines.push(`- Fastest input ready after switch: ${inputBest ? `${inputBest.id} (${inputBest.switchInputReadyMs} ms)` : 'unavailable'}`);
  lines.push(`- Best long-history page max frame: ${pagingBest ? `${pagingBest.id} (${pagingBest.pagingMaxFrameMs} ms)` : 'unavailable'}`);
  lines.push(`- Fastest ready: ${readyBest ? `${readyBest.id} (${readyBest.readyMs} ms)` : 'unavailable'}`);
  lines.push(`- Lowest working set: ${memoryBest ? `${memoryBest.id} (${memoryBest.workingSetMb} MB)` : 'unavailable'}`);
  lines.push('');
  lines.push('## Long Conversation Workload');
  lines.push('');
  lines.push('| Case | OK | Switch samples | History total/probed/selected | Switch render ms | vs baseline | Input ready ms | Input focus ms | Page avg/max frame | >20/>50 frames | Rendered items/chars | Scroll height | Switch long task max | Working set MB |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const item of payload.summary) {
    lines.push([
      item.id,
      `${item.okRuns}/${item.runs}`,
      item.workloadError || item.switchError ? `${item.switchSamples}/${item.switchAttempts} (${item.workloadError || item.switchError})` : `${item.switchSamples}/${item.switchAttempts}`,
      `${item.availableHistory ?? ''}/${item.probedHistory ?? ''}/${item.selectedHistory ?? ''}`,
      item.switchRenderMs ?? '',
      baseline ? ratioText(item.switchRenderMs, baseline.switchRenderMs) : '',
      item.switchInputReadyMs ?? '',
      item.switchInputFocusedMs ?? '',
      `${item.pagingAvgFrameMs ?? ''}/${item.pagingMaxFrameMs ?? ''}`,
      `${item.pagingLongFrames20 ?? ''}/${item.pagingLongFrames50 ?? ''}`,
      `${item.renderedItems ?? ''}/${item.renderedChars ?? ''}`,
      item.renderedScrollHeight ?? '',
      item.switchLongTaskMaxMs ?? '',
      item.workingSetMb ?? ''
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('');
  lines.push('## Startup And Shell Baseline');
  lines.push('');
  lines.push('| Case | OK | Ready ms | vs baseline | DOMContentLoaded | FCP | SSE first status | Simple scroll OK | Simple scroll avg/max | Long frames | JS heap MB | Working set MB | Processes | Initial messages | Threads |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const item of payload.summary) {
    lines.push([
      item.id,
      `${item.okRuns}/${item.runs}`,
      item.readyMs ?? '',
      baseline ? ratioText(item.readyMs, baseline.readyMs) : '',
      item.domContentLoadedMs ?? '',
      item.fcpMs ?? '',
      item.sseFirstStatusMs ?? '',
      item.scrollError ? `${item.scrollOkRuns}/${item.okRuns} ${item.scrollError}` : `${item.scrollOkRuns}/${item.okRuns}`,
      `${item.scrollAvgFrameMs ?? ''}/${item.scrollMaxFrameMs ?? ''}`,
      item.scrollLongFrames ?? '',
      item.jsHeapUsedMb ?? '',
      item.workingSetMb ?? '',
      item.processCount ?? '',
      item.messages ?? '',
      item.threadItems ?? ''
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('');
  lines.push('## Skipped');
  for (const skipped of payload.skipped) {
    lines.push(`- ${skipped.id}: ${skipped.available ? 'available but not benchmarked' : 'not available'}; ${skipped.reason}`);
  }
  lines.push('');
  lines.push('## Interpretation');
  lines.push('- The primary workload is real UI switching through visible history sessions, including transcript rendering, composer readiness, and page-by-page timeline scrolling.');
  lines.push('- This compares Chromium-based shells with isolated temporary profiles, so it is a clean reproducible baseline, not a measurement of your current personal Chrome profile with extensions and existing tabs.');
  lines.push('- If long-session switch and paging differences are small, a separate shell will not materially fix the bottleneck; optimize WebUI timeline rendering and sidebar invalidation first.');
  lines.push('- App mode or an isolated shell can improve stability and reduce profile noise, but it does not speed up Codex model latency, app-server work, or public tunnel transfers.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const discovered = buildCases();
  const selectedIds = new Set(options.cases.split(',').map((item) => item.trim()).filter(Boolean));
  const cases = selectedIds.size ? discovered.cases.filter((item) => selectedIds.has(item.id)) : discovered.cases;
  if (options.list) {
    console.log(JSON.stringify({ cases: discovered.cases.map(({ id, browser, mode, exe, notes }) => ({ id, browser, mode, exe, notes })), skipped: discovered.skipped }, null, 2));
    return;
  }
  if (!cases.length) throw new Error('No benchmark cases are available on this machine.');
  const runDir = path.resolve(options.output || path.join(ROOT, 'outputs', 'browser-shell-benchmark', stamp()));
  await mkdir(runDir, { recursive: true });
  const target = await ensureTarget(options.url, options.startServer);
  const results = [];
  try {
    for (const testCase of cases) {
      for (let run = 1; run <= options.runs; run += 1) {
        console.log(`[benchmark] ${testCase.id} run ${run}/${options.runs}`);
        results.push(await launchCase(testCase, run, options, runDir));
      }
    }
  } finally {
    if (target.started && target.child) {
      try { target.child.kill(); } catch {}
    }
  }
  const payload = {
    createdAt: new Date().toISOString(),
    url: options.url,
    runs: options.runs,
    sessionSwitches: options.workload ? options.sessionSwitches : 0,
    candidateProbes: options.workload ? options.candidateProbes : 0,
    switchTimeoutMs: options.workload ? options.switchTimeoutMs : 0,
    serverStartedByBenchmark: target.started,
    cases: cases.map(({ id, browser, mode, exe, notes }) => ({ id, browser, mode, exe, notes })),
    skipped: discovered.skipped,
    summary: summarize(results),
    results
  };
  await writeFile(path.join(runDir, 'results.json'), JSON.stringify(payload, null, 2));
  await writeFile(path.join(runDir, 'REPORT.md'), markdownReport(payload));
  console.log(`[benchmark] output ${runDir}`);
  console.log(JSON.stringify(payload.summary, null, 2));
}

main().catch((error) => {
  console.error(`[benchmark] ${error.stack || error.message || error}`);
  process.exit(1);
});
