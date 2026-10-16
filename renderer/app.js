const $ = (selector) => document.querySelector(selector);

const elements = {
  pathInput: $('#path-input'),
  fileLabel: $('#file-label'),
  browse: $('#browse-button'),
  load: $('#load-button'),
  pageMode: $('#page-mode'),
  customPage: $('#custom-page-settings'),
  pageSize: $('#page-size'),
  orientation: $('#orientation'),
  background: $('#print-background'),
  sectionPicker: $('#section-picker'),
  useSection: $('#use-section-button'),
  selector: $('#selector-input'),
  rulesList: $('#rules-list'),
  customCss: $('#custom-css'),
  status: $('#status-line'),
  reset: $('#reset-button'),
  export: $('#export-button'),
  previewEmpty: $('#preview-empty')
};

const ruleFields = {
  marginTop: $('#rule-margin-top'),
  marginBottom: $('#rule-margin-bottom'),
  marginLeft: $('#rule-margin-left'),
  marginRight: $('#rule-margin-right'),
  paddingTop: $('#rule-padding-top'),
  paddingBottom: $('#rule-padding-bottom'),
  fontScale: $('#rule-font-scale'),
  lineHeight: $('#rule-line-height'),
  color: $('#rule-color'),
  backgroundColor: $('#rule-background-color'),
  breakBefore: $('#rule-break-before'),
  breakAfter: $('#rule-break-after'),
  keepTogether: $('#rule-keep-together')
};

const marginFields = {
  top: $('#margin-top'),
  right: $('#margin-right'),
  bottom: $('#margin-bottom'),
  left: $('#margin-left')
};

let currentFile = '';
let settings = null;
let sections = [];
let debounceTimer = null;
let pendingSettingsUpdate = Promise.resolve();
let updateInProgress = false;

function setStatus(message, kind = '') {
  elements.status.textContent = message;
  elements.status.classList.toggle('is-error', kind === 'error');
  elements.status.classList.toggle('is-success', kind === 'success');
}

function setBusy(busy) {
  updateInProgress = busy;
  elements.browse.disabled = busy;
  elements.load.disabled = busy;
  elements.export.disabled = busy || !currentFile;
}

function currentRuleValues() {
  const result = { selector: elements.selector.value.trim() };
  for (const key of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'paddingTop', 'paddingBottom', 'fontScale', 'lineHeight']) {
    const value = ruleFields[key].value.trim();
    result[key] = value === '' ? '' : Number(value);
  }
  result.color = ruleFields.color.value.trim();
  result.backgroundColor = ruleFields.backgroundColor.value.trim();
  result.breakBefore = ruleFields.breakBefore.value;
  result.breakAfter = ruleFields.breakAfter.value;
  result.keepTogether = ruleFields.keepTogether.checked;
  const selected = sections.find((section) => section.selector === result.selector);
  result.label = selected?.label || result.selector;
  return result;
}

function fillRuleForm(rule = null) {
  elements.selector.value = rule?.selector || '';
  for (const key of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'paddingTop', 'paddingBottom', 'fontScale', 'lineHeight']) {
    ruleFields[key].value = rule?.[key] ?? '';
  }
  ruleFields.color.value = rule?.color || '';
  ruleFields.backgroundColor.value = rule?.backgroundColor || '';
  ruleFields.breakBefore.value = rule?.breakBefore || 'auto';
  ruleFields.breakAfter.value = rule?.breakAfter || 'auto';
  ruleFields.keepTogether.checked = Boolean(rule?.keepTogether);
}

function hydrateSettings(value) {
  settings = structuredClone(value);
  elements.pageMode.value = settings.pageMode || 'document';
  elements.pageSize.value = settings.pageSize || 'A4';
  elements.orientation.value = settings.orientation || 'portrait';
  elements.background.checked = settings.printBackground !== false;
  for (const [key, input] of Object.entries(marginFields)) input.value = settings.margins?.[key] ?? 12;
  elements.customCss.value = settings.customCss || '';
  elements.customPage.classList.toggle('is-hidden', elements.pageMode.value !== 'custom');
  renderSectionOptions();
  renderRules();
}

function renderSectionOptions() {
  elements.sectionPicker.replaceChildren();
  if (!sections.length) {
    const option = new Option(currentFile ? 'No sections detected' : 'Load an HTML file first', '');
    elements.sectionPicker.add(option);
    elements.sectionPicker.disabled = true;
    elements.useSection.disabled = true;
    return;
  }
  elements.sectionPicker.add(new Option('Choose a detected element...', ''));
  for (const section of sections) {
    elements.sectionPicker.add(new Option(`${section.label}  -  ${section.selector}`, section.selector));
  }
  elements.sectionPicker.disabled = false;
  elements.useSection.disabled = false;
}

function renderRules() {
  elements.rulesList.replaceChildren();
  const rules = settings?.sectionRules || [];
  if (!rules.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-rules';
    empty.textContent = 'No section adjustments yet.';
    elements.rulesList.append(empty);
    return;
  }
  for (const [index, rule] of rules.entries()) {
    const card = document.createElement('div');
    card.className = 'rule-card';
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'rule-card-main';
    main.style.cssText = 'min-width:0; flex:1; padding:0; text-align:left; background:none; border:0; cursor:pointer;';
    const title = document.createElement('div');
    title.className = 'rule-card-title';
    title.textContent = rule.label || rule.selector;
    const selector = document.createElement('div');
    selector.className = 'rule-card-selector';
    selector.textContent = rule.selector;
    const summary = document.createElement('div');
    summary.className = 'rule-card-summary';
    const details = [];
    for (const [key, label] of [['marginTop', 'top'], ['marginBottom', 'bottom'], ['marginLeft', 'left'], ['marginRight', 'right']]) {
      if (rule[key] !== '' && rule[key] !== null && rule[key] !== undefined) details.push(`${label} margin ${rule[key]} mm`);
    }
    if (rule.fontScale !== '' && rule.fontScale !== null && rule.fontScale !== undefined) details.push(`font ${rule.fontScale}%`);
    if (rule.color) details.push(`text ${rule.color}`);
    if (rule.backgroundColor) details.push(`background ${rule.backgroundColor}`);
    summary.textContent = details.join(' · ') || 'Section adjustment active';
    main.append(title, selector, summary);
    main.addEventListener('click', () => fillRuleForm(rule));

    const remove = document.createElement('button');
    remove.className = 'rule-delete';
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${rule.label || rule.selector}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      const [removed] = settings.sectionRules.splice(index, 1);
      if (elements.selector.value === removed?.selector) fillRuleForm({ selector: removed.selector });
      renderRules();
      queueSettingsUpdate();
    });
    card.append(main, remove);
    elements.rulesList.append(card);
  }
}

function readSettingsFromForm() {
  settings.pageMode = elements.pageMode.value;
  settings.pageSize = elements.pageSize.value;
  settings.orientation = elements.orientation.value;
  settings.printBackground = elements.background.checked;
  settings.margins = Object.fromEntries(Object.entries(marginFields).map(([key, input]) => [key, input.value === '' ? 12 : Number(input.value)]));
  settings.customCss = elements.customCss.value;
  return settings;
}

function ruleHasOverrides(rule) {
  return ['marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'paddingTop', 'paddingBottom', 'fontScale', 'lineHeight']
    .some((key) => rule[key] !== '' && rule[key] !== null && rule[key] !== undefined)
    || Boolean(rule.color || rule.backgroundColor)
    || rule.breakBefore !== 'auto'
    || rule.breakAfter !== 'auto'
    || rule.keepTogether;
}

async function syncRuleFormToSettings() {
  const rule = currentRuleValues();
  if (!rule.selector) return;
  const existingIndex = settings.sectionRules.findIndex((item) => item.selector === rule.selector);
  if (!ruleHasOverrides(rule)) {
    if (existingIndex >= 0) settings.sectionRules.splice(existingIndex, 1);
    renderRules();
    return;
  }

  if (rule.color && !CSS.supports('color', rule.color)) throw new Error('Enter a valid CSS text color, such as #1a3f7a or navy.');
  if (rule.backgroundColor && !CSS.supports('color', rule.backgroundColor)) throw new Error('Enter a valid CSS background color, such as #f3f6fa or white.');
  const validation = await window.studioApi.validateSelector(rule.selector);
  if (!validation.valid) throw new Error(`Invalid CSS selector: ${validation.message}`);
  if (existingIndex >= 0) settings.sectionRules[existingIndex] = rule;
  else settings.sectionRules.push(rule);
  renderRules();
}

async function applySettingsUpdate() {
  readSettingsFromForm();
  await syncRuleFormToSettings();
  setStatus('Saving adjustments and rendering PDF preview...');
  await window.studioApi.updateSettings(structuredClone(settings));
}

function queueSettingsUpdate(delay = 350) {
  if (!currentFile || !settings) return;
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(async () => {
    debounceTimer = null;
    try {
      pendingSettingsUpdate = applySettingsUpdate();
      await pendingSettingsUpdate;
    } catch (error) {
      setStatus(error.message || String(error), 'error');
    }
  }, delay);
}

async function flushSettingsUpdate() {
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
    pendingSettingsUpdate = applySettingsUpdate();
  }
  await pendingSettingsUpdate;
}

async function loadPath(filePath) {
  if (!filePath?.trim()) {
    setStatus('Enter an HTML file path or choose a file.', 'error');
    return;
  }
  setBusy(true);
  setStatus('Loading HTML...');
  try {
    const result = await window.studioApi.loadPath(filePath.trim());
    currentFile = result.filePath;
    elements.pathInput.value = currentFile;
    elements.fileLabel.textContent = result.fileName;
    elements.fileLabel.classList.remove('muted');
    sections = result.sections || [];
    hydrateSettings(result.settings);
    elements.reset.disabled = false;
    elements.export.disabled = false;
    elements.previewEmpty.classList.add('is-hidden');
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function openFilePicker() {
  try {
    const result = await window.studioApi.openFile();
    if (!result || result.canceled) return;
    currentFile = result.filePath;
    elements.pathInput.value = result.filePath;
    elements.fileLabel.textContent = result.fileName;
    elements.fileLabel.classList.remove('muted');
    sections = result.sections || [];
    hydrateSettings(result.settings);
    elements.reset.disabled = false;
    elements.export.disabled = false;
    elements.previewEmpty.classList.add('is-hidden');
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  }
}

function usePickedSection() {
  const selector = elements.sectionPicker.value;
  if (!selector) return;
  const existing = settings.sectionRules.find((rule) => rule.selector === selector);
  if (existing) {
    fillRuleForm(existing);
    return;
  }
  elements.selector.value = selector;
  fillRuleForm({ selector, label: sections.find((item) => item.selector === selector)?.label });
}

async function addOrUpdateRule() {
  const rule = currentRuleValues();
  if (!rule.selector) {
    setStatus('Choose a section or enter a CSS selector first.', 'error');
    return;
  }
  if (!ruleHasOverrides(rule)) {
    setStatus('Enter at least one section adjustment first.', 'error');
    return;
  }
  if (rule.color && !CSS.supports('color', rule.color)) {
    setStatus('Enter a valid CSS text color, such as #1a3f7a or navy.', 'error');
    return;
  }
  if (rule.backgroundColor && !CSS.supports('color', rule.backgroundColor)) {
    setStatus('Enter a valid CSS background color, such as #f3f6fa or white.', 'error');
    return;
  }
  const validation = await window.studioApi.validateSelector(rule.selector);
  if (!validation.valid) {
    setStatus(`Invalid CSS selector: ${validation.message}`, 'error');
    return;
  }
  queueSettingsUpdate(0);
}

async function exportPdf() {
  if (!currentFile || updateInProgress) return;
  setBusy(true);
  try {
    await flushSettingsUpdate();
    setStatus('Creating PDF...');
    const result = await window.studioApi.exportPdf();
    if (result?.outputPath) setStatus(`Saved ${result.outputPath}`, 'success');
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  } finally {
    setBusy(false);
  }
}

elements.browse.addEventListener('click', openFilePicker);
elements.load.addEventListener('click', () => loadPath(elements.pathInput.value));
elements.pathInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadPath(elements.pathInput.value); });
elements.useSection.addEventListener('click', usePickedSection);
elements.sectionPicker.addEventListener('change', usePickedSection);
elements.selector.addEventListener('input', () => queueSettingsUpdate(500));
elements.selector.addEventListener('change', () => queueSettingsUpdate(0));
$('#add-rule-button').addEventListener('click', addOrUpdateRule);
$('#clear-rule-form-button').addEventListener('click', () => fillRuleForm());
elements.pageMode.addEventListener('change', () => {
  elements.customPage.classList.toggle('is-hidden', elements.pageMode.value !== 'custom');
  queueSettingsUpdate(0);
});
for (const input of [elements.pageSize, elements.orientation, elements.background, ...Object.values(marginFields)]) {
  input.addEventListener('change', () => queueSettingsUpdate(0));
  input.addEventListener('input', () => queueSettingsUpdate(450));
}
for (const input of Object.values(ruleFields)) {
  input.addEventListener('input', () => queueSettingsUpdate(500));
  input.addEventListener('change', () => queueSettingsUpdate(0));
}
elements.customCss.addEventListener('input', () => queueSettingsUpdate(650));
elements.reset.addEventListener('click', async () => {
  if (!currentFile) return;
  setStatus('Resetting adjustments...');
  try { hydrateSettings(await window.studioApi.resetSettings()); }
  catch (error) { setStatus(error.message || String(error), 'error'); }
});
elements.export.addEventListener('click', exportPdf);

window.studioApi.onStatus((event) => {
  if (event.type === 'rendering') {
    updateInProgress = true;
    elements.export.disabled = true;
    setStatus('Rendering PDF preview...');
  }
  if (event.type === 'preview-ready') {
    setStatus('Preview ready. Changes are saved locally.');
    elements.export.disabled = false;
    updateInProgress = false;
  }
  if (event.type === 'document-loaded') {
    currentFile = event.filePath;
    elements.pathInput.value = event.filePath;
    elements.fileLabel.textContent = event.fileName;
    elements.fileLabel.classList.remove('muted');
    sections = event.sections || [];
    hydrateSettings(event.settings);
    elements.reset.disabled = false;
    elements.export.disabled = false;
    elements.previewEmpty.classList.add('is-hidden');
  }
  if (event.type === 'exported') setStatus(`Saved ${event.outputPath}`, 'success');
  if (event.type === 'settings-reset') hydrateSettings(event.settings);
  if (event.type === 'error') {
    setStatus(event.message || 'Something went wrong while creating the preview.', 'error');
    updateInProgress = false;
  }
});

window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  try { await loadPath(window.studioApi.getPathForFile(file)); }
  catch (error) { setStatus(error.message || String(error), 'error'); }
});
