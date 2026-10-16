const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');

const APP_NAME = 'HTML to PDF Studio';
const APP_ROOT = __dirname;
const RENDERER_FILE = path.join(APP_ROOT, 'renderer', 'index.html');
const DEFAULTS = {
  printBackground: true,
  pageMode: 'document',
  pageSize: 'A4',
  orientation: 'portrait',
  margins: { top: 12, right: 12, bottom: 12, left: 12 },
  sectionRules: [],
  customCss: ''
};

let mainWindow;
let renderWindow;
let currentFile = '';
let currentSettings = structuredClone(DEFAULTS);
let lastOutputDirectory = '';
let sections = [];
let lastPreviewPath = '';
let previewSequence = 0;
let previewQueue = Promise.resolve();

app.setName(APP_NAME);
Menu.setApplicationMenu(null);

function sendStatus(type, details = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('studio:status', { type, ...details });
  }
}

function installKeyboardShortcuts(webContents) {
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const modifier = input.meta || input.control;
    if (!modifier || input.alt) return;
    const key = input.key.toLowerCase();
    if (process.platform === 'darwin') {
      if (key === 'q' && !input.shift) {
        event.preventDefault();
        app.quit();
        return;
      }
      if (key === 'w' && !input.shift) {
        event.preventDefault();
        mainWindow?.close();
        return;
      }
      if (key === 'm' && !input.shift) {
        event.preventDefault();
        mainWindow?.minimize();
        return;
      }
    }
    let action = '';
    if (key === 'o' && !input.shift) action = 'open';
    else if (key === 'e' && !input.shift) action = 'export';
    else if (key === 'f' && !input.shift) action = 'find';
    if (!action) return;
    event.preventDefault();
    sendStatus('shortcut', { action });
  });
}

function settingsFile(filePath) {
  const key = crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex');
  return path.join(app.getPath('userData'), 'settings', `${key}.json`);
}

async function readSettings(filePath) {
  try {
    const raw = await fs.readFile(settingsFile(filePath), 'utf8');
    const saved = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULTS),
      ...saved,
      margins: { ...DEFAULTS.margins, ...(saved.margins || {}) },
      sectionRules: Array.isArray(saved.sectionRules) ? saved.sectionRules : []
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

async function persistSettings() {
  if (!currentFile) return;
  const filePath = settingsFile(currentFile);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(currentSettings, null, 2), 'utf8');
}

async function loadPreferences() {
  try {
    const filePath = path.join(app.getPath('userData'), 'preferences.json');
    const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
    const directory = typeof saved.lastOutputDirectory === 'string' ? saved.lastOutputDirectory : '';
    const stat = directory ? await fs.stat(directory).catch(() => null) : null;
    lastOutputDirectory = stat?.isDirectory() ? directory : '';
  } catch {
    lastOutputDirectory = '';
  }
}

async function persistPreferences() {
  const filePath = path.join(app.getPath('userData'), 'preferences.json');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ lastOutputDirectory }, null, 2), 'utf8');
}

function uniqueSelectorScript() {
  return `(() => {
    const selectors = [
      '.section', 'section', 'article', '.job', '.project-item', '.edu-header',
      '.header', 'header', '.footer', 'footer', '.card', '[data-section]'
    ];
    const seen = new Set();
    const result = [];
    const cssEscape = (value) => {
      if (window.CSS && CSS.escape) return CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    };
    const selectorFor = (element) => {
      if (element.id) return '#' + cssEscape(element.id);
      const pieces = [];
      let node = element;
      while (node && node.nodeType === 1 && node !== document.documentElement) {
        const tag = node.tagName.toLowerCase();
        const classes = Array.from(node.classList || []).slice(0, 3).map((name) => '.' + cssEscape(name)).join('');
        let piece = tag + classes;
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length > 1) piece += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        pieces.unshift(piece);
        const selector = pieces.join(' > ');
        try { if (document.querySelectorAll(selector).length === 1) return selector; } catch {}
        node = parent;
      }
      return pieces.join(' > ');
    };
    const labelFor = (element) => {
      const heading = element.querySelector('.section-title, .job-company, h1, h2, h3, h4, h5, h6, [aria-label]');
      const text = (heading?.getAttribute('aria-label') || heading?.innerText || element.innerText || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
      return text.slice(0, 72) || element.tagName.toLowerCase();
    };
    for (const selector of selectors) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(selector)); } catch {}
      for (const element of nodes) {
        if (seen.has(element) || element.getBoundingClientRect().height === 0) continue;
        seen.add(element);
        result.push({ label: labelFor(element), selector: selectorFor(element) });
        if (result.length >= 100) return result;
      }
    }
    return result;
  })()`;
}

function cleanCssNumber(value, min = -200, max = 500) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, number));
}

function cleanCssColor(value) {
  if (typeof value !== 'string') return null;
  const color = value.trim();
  if (!color || color.length > 48) return null;
  if (/^#[\da-f]{3,4}(?:[\da-f]{2}){0,2}$/i.test(color)) return color;
  if (/^[a-z]{1,24}$/i.test(color) && !/^(?:inherit|initial|unset|revert|revert-layer)$/i.test(color)) return color;
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[\d.%\s,+\-/]+\s*\)$/i.test(color)) return color;
  return null;
}

function buildInjectedCss(settings) {
  const blocks = [];
  if (settings.pageMode === 'custom') {
    const margins = settings.margins || DEFAULTS.margins;
    const value = (key) => `${cleanCssNumber(margins[key], 0, 80) ?? 12}mm`;
    const size = ['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid'].includes(settings.pageSize) ? settings.pageSize : 'A4';
    const orientation = settings.orientation === 'landscape' ? 'landscape' : 'portrait';
    blocks.push(`@page { size: ${size} ${orientation}; margin: ${value('top')} ${value('right')} ${value('bottom')} ${value('left')}; }`);
  }

  for (const rule of settings.sectionRules || []) {
    const selector = String(rule.selector || '').trim();
    if (!selector || selector.length > 500) continue;
    const declarations = [];
    for (const key of ['marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'paddingTop', 'paddingBottom']) {
      const value = cleanCssNumber(rule[key]);
      if (value !== null) {
        const cssName = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        declarations.push(`${cssName}: ${value}mm !important`);
      }
    }
    const fontScale = cleanCssNumber(rule.fontScale, 60, 160);
    if (fontScale !== null) declarations.push(`zoom: ${fontScale / 100} !important`);
    const lineHeight = cleanCssNumber(rule.lineHeight, 0.7, 3);
    if (lineHeight !== null) declarations.push(`line-height: ${lineHeight} !important`);
    const color = cleanCssColor(rule.color);
    if (color) declarations.push(`color: ${color} !important`);
    const backgroundColor = cleanCssColor(rule.backgroundColor);
    if (backgroundColor) declarations.push(`background-color: ${backgroundColor} !important`);
    if (['auto', 'page', 'left', 'right', 'recto', 'verso'].includes(rule.breakBefore)) declarations.push(`break-before: ${rule.breakBefore} !important`);
    if (['auto', 'page', 'left', 'right', 'recto', 'verso'].includes(rule.breakAfter)) declarations.push(`break-after: ${rule.breakAfter} !important`);
    if (rule.keepTogether) declarations.push('break-inside: avoid-page !important');
    if (declarations.length) blocks.push(`${selector} { ${declarations.join('; ')}; }`);
  }

  if (typeof settings.customCss === 'string' && settings.customCss.trim()) blocks.push(settings.customCss);
  return blocks.join('\n\n');
}

async function waitForResources(webContents) {
  await webContents.executeJavaScript(`(async () => {
    const wait = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
    try { if (document.fonts?.ready) await wait(document.fonts.ready, 6000); } catch {}
    try {
      await wait(Promise.all(Array.from(document.images).map((img) => img.complete ? Promise.resolve() : new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }))), 6000);
    } catch {}
    return true;
  })()`);
}

async function injectCurrentOverrides() {
  if (!renderWindow || renderWindow.isDestroyed()) return;
  const css = buildInjectedCss(currentSettings);
  await renderWindow.webContents.executeJavaScript(`(() => {
    let style = document.getElementById('html-pdf-studio-overrides');
    if (!style) {
      style = document.createElement('style');
      style.id = 'html-pdf-studio-overrides';
      document.head.appendChild(style);
    }
    style.textContent = ${JSON.stringify(css)};
  })()`);
  await waitForResources(renderWindow.webContents);
}

async function makePdfBuffer() {
  if (!renderWindow || renderWindow.isDestroyed()) throw new Error('Load an HTML file first.');
  await injectCurrentOverrides();
  return renderWindow.webContents.printToPDF({
    printBackground: Boolean(currentSettings.printBackground),
    preferCSSPageSize: true,
    displayHeaderFooter: false
  });
}

async function removeOldPreview(oldPath) {
  if (!oldPath || oldPath === lastPreviewPath) return;
  try { await fs.unlink(oldPath); } catch {}
}

async function renderPreview() {
  if (!currentFile || !renderWindow || renderWindow.isDestroyed()) return;
  sendStatus('rendering');
  const output = await makePdfBuffer();
  const previewDirectory = path.join(app.getPath('userData'), 'preview');
  await fs.mkdir(previewDirectory, { recursive: true });
  const oldPath = lastPreviewPath;
  const outputPath = path.join(previewDirectory, `preview-${Date.now()}-${++previewSequence}.pdf`);
  await fs.writeFile(outputPath, output);
  lastPreviewPath = outputPath;
  await removeOldPreview(oldPath);
  sendStatus('preview-ready', { filePath: currentFile, size: output.length });
}

function schedulePreview() {
  const job = previewQueue.then(() => renderPreview());
  previewQueue = job.catch((error) => {
    sendStatus('error', { message: error.message || String(error) });
  });
  return job;
}

async function getSectionTargets() {
  if (!renderWindow || renderWindow.isDestroyed()) return [];
  return renderWindow.webContents.executeJavaScript(uniqueSelectorScript());
}

async function loadDocument(filePath) {
  const resolved = path.resolve(String(filePath || '').trim());
  if (!resolved) throw new Error('Enter an HTML file path or choose a file.');
  if (!['.html', '.htm'].includes(path.extname(resolved).toLowerCase())) throw new Error('Choose an .html or .htm file.');
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw new Error('That HTML file could not be found.');

  if (renderWindow && !renderWindow.isDestroyed()) renderWindow.destroy();
  renderWindow = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1200,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false
    }
  });
  renderWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  renderWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (!url.startsWith('file:') || path.resolve(fileURLToPath(url).split('#')[0]) !== resolved) event.preventDefault();
    } catch { event.preventDefault(); }
  });
  await renderWindow.loadURL(pathToFileURL(resolved).toString());
  currentFile = resolved;
  currentSettings = await readSettings(resolved);
  sections = await getSectionTargets();
  await persistSettings();
  sendStatus('document-loaded', {
    filePath: currentFile,
    fileName: path.basename(currentFile),
    settings: currentSettings,
    sections
  });
  await schedulePreview();
  return { filePath: currentFile, fileName: path.basename(currentFile), settings: currentSettings, sections };
}

async function exportPdf() {
  if (!currentFile) throw new Error('Load an HTML file first.');
  const suggestedName = `${path.basename(currentFile, path.extname(currentFile))}.pdf`;
  let defaultPath = path.join(lastOutputDirectory || path.dirname(currentFile), suggestedName);
  while (true) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: `Export ${suggestedName}`,
      defaultPath,
      buttonLabel: 'Export PDF',
      message: 'Choose where to save the generated PDF.',
      properties: [],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const outputPath = result.filePath.toLowerCase().endsWith('.pdf') ? result.filePath : `${result.filePath}.pdf`;
    let exists = false;
    try { await fs.access(outputPath); exists = true; } catch {}
    if (exists) {
      const response = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Replace existing PDF?',
        buttons: ['Replace PDF', 'Choose another…', 'Cancel'],
        defaultId: 2,
        cancelId: 2,
        message: `${path.basename(outputPath)} already exists.`,
        detail: `${outputPath}\n\nReplace it with a PDF generated from ${path.basename(currentFile)}?`
      });
      if (response.response === 1) {
        defaultPath = outputPath;
        continue;
      }
      if (response.response !== 0) return { canceled: true };
    }
    const pdf = await makePdfBuffer();
    await fs.writeFile(outputPath, pdf);
    lastOutputDirectory = path.dirname(outputPath);
    await persistPreferences().catch((error) => console.warn('Could not remember the export folder:', error.message));
    sendStatus('exported', { outputPath });
    return { outputPath };
  }
}

async function openFileDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose an HTML file',
    properties: ['openFile'],
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return loadDocument(result.filePaths[0]);
}

function registerIpc() {
  ipcMain.handle('studio:open-file', async () => {
    return openFileDialog();
  });
  ipcMain.handle('studio:load-path', (_event, filePath) => loadDocument(filePath));
  ipcMain.handle('studio:update-settings', async (_event, settings) => {
    if (!currentFile) throw new Error('Load an HTML file first.');
    currentSettings = {
      ...structuredClone(DEFAULTS),
      ...settings,
      margins: { ...DEFAULTS.margins, ...(settings.margins || {}) },
      sectionRules: Array.isArray(settings.sectionRules) ? settings.sectionRules : []
    };
    await persistSettings();
    await schedulePreview();
    return { ok: true };
  });
  ipcMain.handle('studio:validate-selector', async (_event, selector) => {
    if (!renderWindow || renderWindow.isDestroyed()) return { valid: false, message: 'Load an HTML file first.' };
    return renderWindow.webContents.executeJavaScript(`(() => {
      try { return { valid: true, matches: document.querySelectorAll(${JSON.stringify(String(selector || ''))}).length }; }
      catch (error) { return { valid: false, message: error.message }; }
    })()`);
  });
  ipcMain.handle('studio:export', () => exportPdf());
  ipcMain.handle('studio:reset-settings', async () => {
    currentSettings = structuredClone(DEFAULTS);
    await persistSettings();
    sendStatus('settings-reset', { settings: currentSettings });
    await schedulePreview();
    return currentSettings;
  });
  ipcMain.handle('studio:read-preview', async (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) throw new Error('Only the app window can access the PDF preview.');
    if (!lastPreviewPath) throw new Error('The PDF preview is not ready yet.');
    const bytes = await fs.readFile(lastPreviewPath);
    return new Uint8Array(bytes);
  });
  ipcMain.handle('studio:window-control', (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window !== mainWindow || window.isDestroyed()) return { ok: false };
    if (action === 'close') window.close();
    else if (action === 'minimize') window.minimize();
    else if (action === 'fullscreen') window.setFullScreen(!window.isFullScreen());
    else return { ok: false };
    return { ok: true };
  });
  ipcMain.handle('studio:open-output-folder', async (_event, filePath) => {
    if (filePath) await shell.showItemInFolder(filePath);
  });
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 960,
    minWidth: 1040,
    minHeight: 700,
    title: APP_NAME,
    frame: process.platform !== 'darwin',
    roundedCorners: true,
    backgroundColor: '#edf1f6',
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await mainWindow.loadFile(RENDERER_FILE);
  mainWindow.on('enter-full-screen', () => sendStatus('window-fullscreen', { fullScreen: true }));
  mainWindow.on('leave-full-screen', () => sendStatus('window-fullscreen', { fullScreen: false }));
  mainWindow.webContents.on('blur', () => sendStatus('dismiss-app-menu'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  installKeyboardShortcuts(mainWindow.webContents);
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function parseCli() {
  const convertIndex = process.argv.indexOf('--convert');
  if (convertIndex < 0) return null;
  const args = process.argv.slice(convertIndex + 1);
  const input = args.find((arg) => !arg.startsWith('--'));
  const outputIndex = args.indexOf('--output');
  return { input, output: outputIndex >= 0 ? args[outputIndex + 1] : undefined };
}

function parseStartupFile() {
  const openIndex = process.argv.indexOf('--open');
  return openIndex >= 0 ? process.argv[openIndex + 1] : undefined;
}

async function runCliConversion(cli) {
  try {
    if (!cli.input) throw new Error('Usage: npm run convert -- "/path/to/file.html" [--output "/path/to/file.pdf"]');
    const filePath = path.resolve(cli.input);
    currentSettings = await readSettings(filePath);
    await loadDocument(filePath);
    const outputPath = path.resolve(cli.output || path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.pdf`));
    const pdf = await makePdfBuffer();
    await fs.writeFile(outputPath, pdf);
    console.log(`Created ${outputPath}`);
    app.quit();
  } catch (error) {
    console.error(error.message || error);
    app.exit(1);
  }
}

app.whenReady().then(async () => {
  registerIpc();
  await loadPreferences();
  const cli = parseCli();
  if (cli) return runCliConversion(cli);
  const startupFile = parseStartupFile();
  await createMainWindow();
  if (startupFile) {
    try { await loadDocument(startupFile); }
    catch (error) { sendStatus('error', { message: error.message || String(error) }); }
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
