import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

function cdpClient(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const nextId = ++id;
    pending.set(nextId, { resolve, reject });
    ws.send(JSON.stringify({ id: nextId, method, params }));
  });
}

async function main() {
  const selected = await (async () => {
    for (const candidate of chromeCandidates) {
      if (await fileExists(candidate)) return candidate;
    }
    return null;
  })();
  if (!selected) throw new Error('No Chrome or Edge executable found');

  const profile = await mkdtemp(join(tmpdir(), 'codex-webui-command-hidden-'));
  const browser = spawn(selected, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  try {
    const activePort = join(profile, 'DevToolsActivePort');
    await waitForFile(activePort);
    const [port] = String(await readFile(activePort, 'utf8')).split(/\r?\n/);
    const newTargetUrl = `http://127.0.0.1:${port}/json/new?http://127.0.0.1:5055/?debug_no_events`;
    const page = await fetch(newTargetUrl, { method: 'PUT' }).then((res) => res.json());
    if (!page) throw new Error('WebUI page target not found');

    const ws = await connect(page.webSocketDebuggerUrl);
    const call = cdpClient(ws);
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Page.navigate', { url: 'http://127.0.0.1:5055/?debug_no_events' });
    const evaluate = async (params) => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await call('Runtime.evaluate', params);
        } catch (error) {
          lastError = error;
          if (!String(error?.message || error).includes('Execution context was destroyed')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      }
      throw lastError;
    };

    const readyExpression = `new Promise((resolve) => {
      const done = () => resolve(Boolean(document.readyState === 'complete' && window.__codexWebuiDebug && window.__codexWebuiDebug().debugNoEvents));
      if (document.readyState === 'complete') done();
      else window.addEventListener('load', done, { once: true });
      setTimeout(done, 6000);
    })`;
    const ready = await evaluate({ expression: readyExpression, awaitPromise: true, returnByValue: true });
    if (!ready.result.value) {
      const diag = await evaluate({
        expression: `(() => ({
          readyState: document.readyState,
          href: location.href,
          debugType: typeof window.__codexWebuiDebug,
          bodyText: document.body ? document.body.innerText.slice(0, 200) : '',
          scripts: Array.from(document.scripts).map((script) => script.src || script.textContent.slice(0, 40))
        }))()`,
        returnByValue: true
      }).catch((error) => ({ result: { value: { error: String(error?.message || error) } } }));
      throw new Error(`WebUI debug page did not become ready: ${JSON.stringify(diag.result.value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 700));

    const draftMarker = `codex-draft-protect-${Date.now()}`;
    const storedDraft = await evaluate({
      expression: `(() => {
        localStorage.removeItem('plusComposerDraft');
        const input = document.getElementById('text');
        input.value = ${JSON.stringify(draftMarker)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return JSON.parse(localStorage.getItem('plusComposerDraft') || '{}').text || '';
      })()`,
      returnByValue: true
    });
    await call('Page.reload', { ignoreCache: true });
    const reloaded = await evaluate({ expression: readyExpression, awaitPromise: true, returnByValue: true });
    if (!reloaded.result.value) throw new Error('WebUI debug page did not become ready after reload');
    await new Promise((resolve) => setTimeout(resolve, 700));
    const draft = await evaluate({
      expression: `(() => {
        const input = document.getElementById('text');
        const stored = JSON.parse(localStorage.getItem('plusComposerDraft') || '{}');
        const restoredValue = input?.value || '';
        localStorage.removeItem('plusComposerDraft');
        if (input) {
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return {
          marker: ${JSON.stringify(draftMarker)},
          storedBeforeReload: ${JSON.stringify(storedDraft.result.value || '')},
          storedAfterReload: stored.text || '',
          restoredValue,
          storageCleared: localStorage.getItem('plusComposerDraft') === null
        };
      })()`,
      returnByValue: true
    });

    const controls = await evaluate({
      expression: `(async () => {
        const waitFor = async (predicate, timeoutMs = 10000) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (predicate()) return true;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return false;
        };
        document.getElementById('attachmentBtn')?.click();
        const menu = document.getElementById('composerMoreMenu');
        const plusMenu = {
          open: Boolean(menu && !menu.hidden),
          speedOptions: document.querySelectorAll('[data-service-tier]').length,
          planInsideMenu: Boolean(document.getElementById('composerPlanMenuBtn')),
          fullPermissionOption: Boolean(document.querySelector('[data-permission-level="full"]'))
        };
        document.getElementById('permissionBtn')?.click();
        const permissionMenu = {
          opensComposerMenu: Boolean(menu && !menu.hidden),
          settingsStillClosed: !document.getElementById('settingsModal')?.classList.contains('open')
        };
        window.closeComposerMoreMenu?.();
        document.getElementById('openAccountBtn')?.click();
        await waitFor(() => {
          const line = document.getElementById('accountStatusLine')?.textContent || '';
          return line && !line.includes('正在读取');
        });
        const accountModal = document.getElementById('accountModal');
        const actionButtons = Array.from(document.querySelectorAll('#accountLoginBtn, #accountLogoutBtn'))
          .filter((button) => !button.hidden).length;
        return {
          plusMenu,
          permissionMenu,
          accountOpen: Boolean(accountModal?.classList.contains('open')),
          accountIdentityVisible: Boolean((document.getElementById('accountIdentity')?.textContent || '').trim()),
          accountLimitCards: document.querySelectorAll('.account-limit-card').length,
          accountUsageItems: document.querySelectorAll('.account-usage-item').length,
          accountActionButtons: actionButtons,
          debug: window.__codexWebuiDebug ? window.__codexWebuiDebug() : null
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const result = await evaluate({
      expression: `(() => {
        const beforeCards = document.querySelectorAll('.timeline-card, .tool-card').length;
        const commandTimeline = window.addTimelineItem({ role: 'tool', kind: 'commandExecution', title: 'Command', text: 'cmd', detail: 'cmd output', status: 'completed' });
        const commandTool = window.addTool('Command', 'cmd output');
        const fileTimeline = window.addTimelineItem({ role: 'tool', kind: 'fileChange', title: 'File change', text: 'file', detail: 'file changed', status: 'completed' });
        const fileDetails = fileTimeline?.querySelector('details.timeline-card-disclosure');
        return {
          addTimelineItemType: typeof window.addTimelineItem,
          addToolType: typeof window.addTool,
          commandTimelineHidden: commandTimeline === null,
          commandToolHidden: commandTool === null,
          commandCards: Array.from(document.querySelectorAll('.timeline-card, .tool-card')).filter((el) => /\\bCommand\\b/.test(el.textContent || '')).length,
          fileChangeCards: document.querySelectorAll('.timeline-card-fileChange').length,
          fileChangeHasDisclosure: Boolean(fileDetails),
          fileChangeDefaultCollapsed: Boolean(fileDetails && fileDetails.open === false),
          beforeCards,
          afterCards: document.querySelectorAll('.timeline-card, .tool-card').length
        };
      })()`,
      returnByValue: true
    });
    ws.close();
    const value = result.result.value;
    const draftValue = draft.result.value;
    if (
      value.addTimelineItemType !== 'function'
      || value.addToolType !== 'function'
      || !value.commandTimelineHidden
      || !value.commandToolHidden
      || value.commandCards !== 0
      || value.fileChangeCards < 1
      || !value.fileChangeHasDisclosure
      || !value.fileChangeDefaultCollapsed
    ) {
      throw new Error(`DOM verification failed: ${JSON.stringify(value)}`);
    }
    if (
      draftValue.storedBeforeReload !== draftValue.marker
      || draftValue.storedAfterReload !== draftValue.marker
      || draftValue.restoredValue !== draftValue.marker
      || !draftValue.storageCleared
    ) {
      throw new Error(`Draft verification failed: ${JSON.stringify(draftValue)}`);
    }
    const controlsValue = controls.result.value;
    if (
      !controlsValue.plusMenu.open
      || controlsValue.plusMenu.speedOptions < 2
      || !controlsValue.plusMenu.planInsideMenu
      || !controlsValue.plusMenu.fullPermissionOption
      || !controlsValue.permissionMenu.opensComposerMenu
      || !controlsValue.permissionMenu.settingsStillClosed
      || !controlsValue.accountOpen
      || !controlsValue.accountIdentityVisible
      || controlsValue.accountLimitCards < 1
      || controlsValue.accountUsageItems < 1
      || controlsValue.accountActionButtons < 1
    ) {
      throw new Error(`Plus controls verification failed: ${JSON.stringify(controlsValue)}`);
    }
    console.log(JSON.stringify({ command: value, draft: draftValue, controls: controlsValue }));
  } finally {
    browser.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1200);
      browser.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
