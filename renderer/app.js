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
  previewEmpty: $('#preview-empty'),
  previewFileName: $('#preview-file-name'),
  previewState: $('#preview-state'),
  previewStateLabel: $('#preview-state-label'),
  themeToggle: $('#theme-toggle'),
  themeToggleLabel: $('#theme-toggle-label'),
  emptyBrowse: $('#empty-browse-button'),
  selectorValidation: $('#selector-validation'),
  adjustmentValidation: $('#adjustment-validation'),
  pageValidation: $('#page-validation'),
  undo: $('#undo-button'),
  redo: $('#redo-button'),
  menuExport: $('[data-menu-command="export"]'),
  menuUndo: $('[data-menu-command="undo"]'),
  menuRedo: $('[data-menu-command="redo"]'),
  menuReset: $('[data-menu-command="reset"]'),
  menuThemeLabel: $('#menu-theme-label'),
  shortcutsDialog: $('#shortcuts-dialog'),
  windowControls: $('#window-controls'),
  fullscreenControl: $('#fullscreen-control')
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
  colorPicker: $('#rule-color-picker'),
  backgroundColor: $('#rule-background-color'),
  backgroundColorPicker: $('#rule-background-color-picker'),
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
let selectorValidationTimer = null;
let selectorValidationSequence = 0;
let pendingSettingsUpdate = Promise.resolve();
let updateInProgress = false;
let committedSettings = null;
let undoStack = [];
let redoStack = [];
const HISTORY_LIMIT = 60;
const isMacPlatform = window.studioApi.platform === 'darwin';

if (isMacPlatform) elements.windowControls.hidden = false;
document.querySelectorAll('[data-window-action]').forEach((button) => {
  button.addEventListener('click', () => {
    window.studioApi.controlWindow(button.dataset.windowAction).catch((error) => {
      setStatus(error.message || 'Could not control the window.', 'error');
    });
  });
});

function setFullscreenControl(fullScreen) {
  const label = fullScreen ? 'Exit full screen' : 'Enter full screen';
  elements.fullscreenControl.title = label;
  elements.fullscreenControl.setAttribute('aria-label', label);
  elements.fullscreenControl.dataset.fullscreen = String(fullScreen);
}

function setStatus(message, kind = '') {
  elements.status.textContent = message;
  elements.status.classList.toggle('is-error', kind === 'error');
  elements.status.classList.toggle('is-success', kind === 'success');
  elements.previewState.classList.toggle('is-error', kind === 'error');
}

function setBusy(busy) {
  updateInProgress = busy;
  elements.browse.disabled = busy;
  elements.load.disabled = busy;
  elements.export.disabled = busy || !currentFile;
  updateMenuAvailability();
  elements.previewState.classList.toggle('is-busy', busy);
}

function renderHistoryButtons() {
  elements.undo.disabled = undoStack.length === 0 || !currentFile;
  elements.redo.disabled = redoStack.length === 0 || !currentFile;
  updateMenuAvailability();
}

function updateMenuAvailability() {
  elements.menuExport.disabled = !currentFile || updateInProgress;
  elements.menuUndo.disabled = undoStack.length === 0 || !currentFile;
  elements.menuRedo.disabled = redoStack.length === 0 || !currentFile;
  elements.menuReset.disabled = !currentFile;
}

function showValidation(element, message, kind = 'empty') {
  element.textContent = message;
  element.className = `validation-line is-${kind}`;
}

function isSupportedCssColor(value) {
  const color = value.trim();
  if (!color) return true;
  if (!CSS.supports('color', color)) return false;
  if (/^#[\da-f]{3,4}(?:[\da-f]{2}){0,2}$/i.test(color)) return true;
  if (/^[a-z]{1,24}$/i.test(color) && !/^(?:inherit|initial|unset|revert|revert-layer)$/i.test(color)) return true;
  return /^(?:rgb|rgba|hsl|hsla)\(\s*[\d.%\s,+\-/]+\s*\)$/i.test(color);
}

function validateFieldValues() {
  const numericFields = [
    ruleFields.marginTop, ruleFields.marginBottom, ruleFields.marginLeft, ruleFields.marginRight,
    ruleFields.paddingTop, ruleFields.paddingBottom, ruleFields.fontScale, ruleFields.lineHeight
  ];
  const validateNumbers = (inputs) => {
    let message = '';
    for (const input of inputs) {
      const invalid = (!input.validity.valid && input.value !== '') || input.validity.badInput;
      input.classList.toggle('is-invalid', invalid);
      input.setAttribute('aria-invalid', String(invalid));
      if (invalid && !message) {
        const label = input.closest('.field')?.querySelector('span')?.textContent || input.id.replaceAll('-', ' ');
        message = `${label}: ${input.validationMessage || 'Enter a value within the allowed range.'}`;
      }
    }
    return message;
  };
  const pageMessage = validateNumbers(elements.pageMode.value === 'custom' ? Object.values(marginFields) : []);
  const ruleMessage = validateNumbers(numericFields);
  showValidation(elements.pageValidation, pageMessage, pageMessage ? 'error' : 'empty');
  let firstMessage = ruleMessage;
  for (const input of [ruleFields.color, ruleFields.backgroundColor]) {
    const invalid = !isSupportedCssColor(input.value);
    input.classList.toggle('is-invalid', invalid);
    input.setAttribute('aria-invalid', String(invalid));
    if (invalid && !firstMessage) firstMessage = 'Use a supported CSS color name, hex, rgb(), or hsl() value.';
  }
  showValidation(elements.adjustmentValidation, firstMessage, firstMessage ? 'error' : 'empty');
  return !pageMessage && !firstMessage;
}

function currentValidationMessage() {
  return elements.adjustmentValidation.textContent || elements.pageValidation.textContent || 'Fix the highlighted values before applying changes.';
}

async function validateSelectorValue() {
  const selector = elements.selector.value.trim();
  const sequence = ++selectorValidationSequence;
  if (!selector || !currentFile) {
    elements.selector.classList.remove('is-invalid');
    elements.selector.setAttribute('aria-invalid', 'false');
    showValidation(elements.selectorValidation, 'Use a CSS selector such as .experience or #education.', 'help');
    return null;
  }
  try {
    const validation = await window.studioApi.validateSelector(selector);
    if (sequence !== selectorValidationSequence || selector !== elements.selector.value.trim()) return null;
    if (!validation.valid) {
      elements.selector.classList.add('is-invalid');
      elements.selector.setAttribute('aria-invalid', 'true');
      showValidation(elements.selectorValidation, `Invalid CSS selector: ${validation.message}`, 'error');
      return validation;
    }
    elements.selector.classList.remove('is-invalid');
    elements.selector.setAttribute('aria-invalid', 'false');
    if (validation.matches === 0) {
      showValidation(elements.selectorValidation, 'Valid selector, but it does not match any elements in this document.', 'warning');
    } else {
      showValidation(elements.selectorValidation, `Selector matches ${validation.matches} ${validation.matches === 1 ? 'element' : 'elements'}.`, 'valid');
    }
    return validation;
  } catch (error) {
    if (sequence === selectorValidationSequence) showValidation(elements.selectorValidation, error.message || String(error), 'error');
    return null;
  }
}

function scheduleSelectorValidation(delay = 250) {
  window.clearTimeout(selectorValidationTimer);
  selectorValidationTimer = window.setTimeout(() => {
    selectorValidationTimer = null;
    validateSelectorValue();
  }, delay);
}

function setPreviewDocument(fileName = '') {
  elements.previewFileName.textContent = fileName || 'No document loaded';
  elements.previewEmpty.classList.toggle('is-hidden', Boolean(fileName));
}

function setTheme(theme) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selected;
  const nextTheme = selected === 'dark' ? 'light' : 'dark';
  elements.themeToggleLabel.textContent = selected === 'dark' ? 'Light theme' : 'Dark theme';
  elements.menuThemeLabel.textContent = selected === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  elements.themeToggle.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
  elements.themeToggle.title = `Switch to ${nextTheme} theme`;
  try { localStorage.setItem('html-pdf-studio-theme', selected); } catch {}
  window.studioApi.setPreviewTheme(selected).catch(() => {});
}

const menuGroups = [...document.querySelectorAll('.app-menu-group')];
let openMenuGroup = null;

function closeMenus({ restoreFocus = false } = {}) {
  if (!openMenuGroup) return;
  const group = openMenuGroup;
  group.querySelector('.app-menu-trigger').setAttribute('aria-expanded', 'false');
  group.querySelector('.app-menu-popover').hidden = true;
  openMenuGroup = null;
  if (restoreFocus) group.querySelector('.app-menu-trigger').focus();
}

function openMenu(group, { focusFirst = false } = {}) {
  closeMenus();
  const trigger = group.querySelector('.app-menu-trigger');
  const popover = group.querySelector('.app-menu-popover');
  popover.hidden = false;
  const width = popover.getBoundingClientRect().width;
  const triggerLeft = trigger.getBoundingClientRect().left;
  const sidebarEdge = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || 390;
  const left = Math.max(8, Math.min(triggerLeft, sidebarEdge - width - 8));
  popover.style.left = `${left}px`;
  trigger.setAttribute('aria-expanded', 'true');
  openMenuGroup = group;
  if (focusFirst) popover.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
}

function cycleMenuFocus(popover, direction) {
  const items = [...popover.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);
  const nextIndex = index < 0 ? 0 : (index + direction + items.length) % items.length;
  items[nextIndex].focus();
}

function runMenuCommand(command) {
  closeMenus({ restoreFocus: true });
  if (command === 'open') openFilePicker();
  else if (command === 'export') exportPdf();
  else if (command === 'undo') undoSettings();
  else if (command === 'redo') redoSettings();
  else if (command === 'reset') elements.reset.click();
  else if (command === 'theme') setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  else if (command === 'shortcuts') elements.shortcutsDialog.showModal();
}

menuGroups.forEach((group, index) => {
  const trigger = group.querySelector('.app-menu-trigger');
  const popover = group.querySelector('.app-menu-popover');
  trigger.addEventListener('click', () => {
    if (openMenuGroup === group) closeMenus();
    else openMenu(group);
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu(group, { focusFirst: true });
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      menuGroups[(index + offset + menuGroups.length) % menuGroups.length].querySelector('.app-menu-trigger').focus();
    }
  });
  popover.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenus({ restoreFocus: true });
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      cycleMenuFocus(popover, event.key === 'ArrowDown' ? 1 : -1);
    }
  });
  popover.querySelectorAll('[data-menu-command]').forEach((item) => {
    item.addEventListener('click', () => runMenuCommand(item.dataset.menuCommand));
  });
});

window.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.app-menu-bar')) closeMenus();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openMenuGroup) {
    event.preventDefault();
    closeMenus({ restoreFocus: true });
  }
});

const shortcutModifier = isMacPlatform ? '⌘' : 'Ctrl';
const shortcutLabels = {
  open: `${shortcutModifier} O`,
  export: `${shortcutModifier} E`,
  undo: `${shortcutModifier} Z`,
  redo: isMacPlatform ? '⇧ ⌘ Z' : 'Ctrl Shift Z',
  redoAlternate: `${shortcutModifier} Y`
};
document.querySelectorAll('[data-shortcut]').forEach((key) => {
  key.textContent = shortcutLabels[key.dataset.shortcut];
});
const shortcutPlatformNote = $('#shortcut-platform-note');
if (isMacPlatform) shortcutPlatformNote.classList.add('is-hidden');
else shortcutPlatformNote.textContent = 'On macOS, use ⌘ instead of Ctrl.';
$('.dialog-close').addEventListener('click', () => elements.shortcutsDialog.close());
elements.shortcutsDialog.addEventListener('click', (event) => {
  if (event.target === elements.shortcutsDialog) elements.shortcutsDialog.close();
});

function colorToHex(value) {
  if (!value || !CSS.supports('color', value)) return null;
  const context = document.createElement('canvas').getContext('2d');
  context.fillStyle = '#000000';
  context.fillStyle = value;
  if (/^#[\da-f]{6}$/i.test(context.fillStyle)) return context.fillStyle;
  const probe = document.createElement('span');
  probe.style.color = value;
  document.body.append(probe);
  const normalized = getComputedStyle(probe).color;
  probe.remove();
  const channels = normalized.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!channels) return null;
  return `#${channels.slice(1, 4).map((channel) => Number(channel).toString(16).padStart(2, '0')).join('')}`;
}

function syncColorPicker(textInput, picker) {
  const hex = colorToHex(textInput.value.trim());
  if (hex) picker.value = hex;
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
  syncColorPicker(ruleFields.color, ruleFields.colorPicker);
  syncColorPicker(ruleFields.backgroundColor, ruleFields.backgroundColorPicker);
  ruleFields.breakBefore.value = rule?.breakBefore || 'auto';
  ruleFields.breakAfter.value = rule?.breakAfter || 'auto';
  ruleFields.keepTogether.checked = Boolean(rule?.keepTogether);
  validateFieldValues();
  scheduleSelectorValidation(0);
}

function hydrateSettings(value, { resetHistory = true, resetRuleForm = resetHistory } = {}) {
  settings = structuredClone(value);
  if (resetHistory) {
    committedSettings = structuredClone(settings);
    undoStack = [];
    redoStack = [];
  }
  elements.pageMode.value = settings.pageMode || 'document';
  elements.pageSize.value = settings.pageSize || 'A4';
  elements.orientation.value = settings.orientation || 'portrait';
  elements.background.checked = settings.printBackground !== false;
  for (const [key, input] of Object.entries(marginFields)) input.value = settings.margins?.[key] ?? 12;
  elements.customCss.value = settings.customCss || '';
  elements.customPage.classList.toggle('is-hidden', elements.pageMode.value !== 'custom');
  if (resetRuleForm) fillRuleForm();
  renderSectionOptions();
  renderRules();
  renderHistoryButtons();
  validateFieldValues();
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
    const title = document.createElement('div');
    title.className = 'rule-card-title';
    title.textContent = rule.label || rule.selector;
    const selector = document.createElement('div');
    selector.className = 'rule-card-selector';
    selector.textContent = rule.selector;
    const summary = document.createElement('div');
    summary.className = 'rule-card-summary';
    const addChip = (label, color = '') => {
      const chip = document.createElement('span');
      chip.className = 'rule-card-chip';
      if (color) {
        const swatch = document.createElement('span');
        swatch.className = 'rule-color-swatch';
        swatch.style.backgroundColor = color;
        chip.append(swatch);
      }
      chip.append(document.createTextNode(label));
      summary.append(chip);
    };
    for (const [key, label] of [['marginTop', 'Top margin'], ['marginBottom', 'Bottom margin'], ['marginLeft', 'Left margin'], ['marginRight', 'Right margin']]) {
      if (rule[key] !== '' && rule[key] !== null && rule[key] !== undefined) addChip(`${label} ${rule[key]} mm`);
    }
    for (const [key, label] of [['paddingTop', 'Top padding'], ['paddingBottom', 'Bottom padding']]) {
      if (rule[key] !== '' && rule[key] !== null && rule[key] !== undefined) addChip(`${label} ${rule[key]} mm`);
    }
    if (rule.fontScale !== '' && rule.fontScale !== null && rule.fontScale !== undefined) addChip(`Font ${rule.fontScale}%`);
    if (rule.lineHeight !== '' && rule.lineHeight !== null && rule.lineHeight !== undefined) addChip(`Line height ${rule.lineHeight}`);
    if (rule.color) addChip(`Text ${rule.color}`, rule.color);
    if (rule.backgroundColor) addChip(`Background ${rule.backgroundColor}`, rule.backgroundColor);
    if (rule.breakBefore && rule.breakBefore !== 'auto') addChip(`Break before: ${rule.breakBefore}`);
    if (rule.breakAfter && rule.breakAfter !== 'auto') addChip(`Break after: ${rule.breakAfter}`);
    if (rule.keepTogether) addChip('Keep together');
    if (!summary.childElementCount) summary.textContent = 'No active overrides';
    main.append(title, selector, summary);
    main.addEventListener('click', () => {
      fillRuleForm(rule);
      scheduleSelectorValidation(0);
    });

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

  if (rule.color && !isSupportedCssColor(rule.color)) throw new Error('Enter a supported CSS text color, such as #1a3f7a or navy.');
  if (rule.backgroundColor && !isSupportedCssColor(rule.backgroundColor)) throw new Error('Enter a supported CSS background color, such as #f3f6fa or white.');
  const validation = await window.studioApi.validateSelector(rule.selector);
  if (!validation.valid) {
    elements.selector.classList.add('is-invalid');
    elements.selector.setAttribute('aria-invalid', 'true');
    showValidation(elements.selectorValidation, `Invalid CSS selector: ${validation.message}`, 'error');
    throw new Error(`Invalid CSS selector: ${validation.message}`);
  }
  elements.selector.classList.remove('is-invalid');
  elements.selector.setAttribute('aria-invalid', 'false');
  if (validation.matches === 0) showValidation(elements.selectorValidation, 'Valid selector, but it does not match any elements in this document.', 'warning');
  else showValidation(elements.selectorValidation, `Selector matches ${validation.matches} ${validation.matches === 1 ? 'element' : 'elements'}.`, 'valid');
  if (existingIndex >= 0) settings.sectionRules[existingIndex] = rule;
  else settings.sectionRules.push(rule);
  renderRules();
}

async function applySettingsUpdate() {
  const earlierUpdate = pendingSettingsUpdate;
  try { await earlierUpdate; } catch {}
  if (!validateFieldValues()) throw new Error(currentValidationMessage());
  const before = structuredClone(committedSettings || settings);
  readSettingsFromForm();
  await syncRuleFormToSettings();
  const next = structuredClone(settings);
  if (JSON.stringify(next) === JSON.stringify(before)) return;
  setStatus('Saving adjustments and rendering PDF preview...');
  await window.studioApi.updateSettings(next);
  undoStack.push(before);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  committedSettings = next;
  renderHistoryButtons();
}

function queueSettingsUpdate(delay = 350) {
  if (!currentFile || !settings) return;
  window.clearTimeout(debounceTimer);
  if (!validateFieldValues()) {
    setStatus(currentValidationMessage(), 'error');
    return;
  }
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
  if (!validateFieldValues()) throw new Error(currentValidationMessage());
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
    pendingSettingsUpdate = applySettingsUpdate();
  }
  await pendingSettingsUpdate;
}

async function moveHistory(direction) {
  if (!currentFile || !settings) return;
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
    try {
      pendingSettingsUpdate = applySettingsUpdate();
      await pendingSettingsUpdate;
    } catch {}
  }
  try { await pendingSettingsUpdate; } catch {}
  const source = direction === 'undo' ? undoStack : redoStack;
  const destination = direction === 'undo' ? redoStack : undoStack;
  if (!source.length) return;

  const current = structuredClone(committedSettings || settings);
  const target = source.pop();
  destination.push(current);
  const selectedSelector = elements.selector.value.trim();
  hydrateSettings(target, { resetHistory: false, resetRuleForm: false });
  const restoredRule = target.sectionRules.find((rule) => rule.selector === selectedSelector);
  fillRuleForm(restoredRule || (selectedSelector ? { selector: selectedSelector } : null));
  validateFieldValues();
  renderHistoryButtons();
  setStatus(direction === 'undo' ? 'Undoing last adjustment...' : 'Redoing adjustment...');
  try {
    await window.studioApi.updateSettings(structuredClone(target));
    committedSettings = structuredClone(target);
    renderHistoryButtons();
  } catch (error) {
    destination.pop();
    source.push(target);
    hydrateSettings(current, { resetHistory: false, resetRuleForm: false });
    const restoredCurrent = current.sectionRules.find((rule) => rule.selector === selectedSelector);
    fillRuleForm(restoredCurrent || (selectedSelector ? { selector: selectedSelector } : null));
    renderHistoryButtons();
    throw error;
  }
}

function undoSettings() {
  return moveHistory('undo').catch((error) => setStatus(error.message || String(error), 'error'));
}

function redoSettings() {
  return moveHistory('redo').catch((error) => setStatus(error.message || String(error), 'error'));
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
    setPreviewDocument(result.fileName);
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
    setPreviewDocument(result.fileName);
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
    scheduleSelectorValidation(0);
    return;
  }
  elements.selector.value = selector;
  fillRuleForm({ selector, label: sections.find((item) => item.selector === selector)?.label });
  scheduleSelectorValidation(0);
}

function applyPreset(name) {
  if (!currentFile) {
    setStatus('Load an HTML file before applying a preset.', 'error');
    return;
  }
  if (!elements.selector.value.trim()) {
    setStatus('Choose a detected section or enter a CSS selector first.', 'error');
    return;
  }
  if (name === 'tighter') {
    ruleFields.marginBottom.value = '2.5';
    ruleFields.lineHeight.value = '1.2';
  } else if (name === 'smaller') {
    ruleFields.fontScale.value = '90';
  } else if (name === 'more-top') {
    ruleFields.marginTop.value = '10';
  }
  setStatus('Applying preset and refreshing preview...');
  queueSettingsUpdate(0);
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
  if (!validateFieldValues()) {
    setStatus('Fix the highlighted values before applying changes.', 'error');
    return;
  }
  const validation = await window.studioApi.validateSelector(rule.selector);
  if (!validation.valid) {
    elements.selector.classList.add('is-invalid');
    elements.selector.setAttribute('aria-invalid', 'true');
    showValidation(elements.selectorValidation, `Invalid CSS selector: ${validation.message}`, 'error');
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
    else if (result?.canceled) setStatus('Export canceled.');
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  } finally {
    setBusy(false);
  }
}

elements.browse.addEventListener('click', openFilePicker);
elements.emptyBrowse.addEventListener('click', openFilePicker);
elements.load.addEventListener('click', () => loadPath(elements.pathInput.value));
elements.pathInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadPath(elements.pathInput.value); });
elements.useSection.addEventListener('click', usePickedSection);
elements.sectionPicker.addEventListener('change', usePickedSection);
elements.selector.addEventListener('input', () => {
  scheduleSelectorValidation();
  queueSettingsUpdate(500);
});
elements.selector.addEventListener('change', () => {
  scheduleSelectorValidation(0);
  queueSettingsUpdate(0);
});
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
  input.addEventListener('input', () => {
    validateFieldValues();
    queueSettingsUpdate(500);
  });
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
elements.undo.addEventListener('click', undoSettings);
elements.redo.addEventListener('click', redoSettings);
elements.themeToggle.addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});
window.addEventListener('keydown', (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (!modifier || event.altKey || event.repeat) return;
  const key = event.key.toLowerCase();
  const target = event.target;
  const textEditing = target instanceof HTMLElement && (
    target.isContentEditable
    || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLInputElement && ['text', 'search', 'url', 'email', 'password'].includes(target.type))
  );
  if (textEditing) return;
  if (key === 'z') {
    event.preventDefault();
    if (event.shiftKey) redoSettings();
    else undoSettings();
  } else if (key === 'y') {
    event.preventDefault();
    redoSettings();
  }
});
document.querySelectorAll('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => applyPreset(button.dataset.preset));
});
for (const [textInput, picker] of [[ruleFields.color, ruleFields.colorPicker], [ruleFields.backgroundColor, ruleFields.backgroundColorPicker]]) {
  textInput.addEventListener('input', () => syncColorPicker(textInput, picker));
  picker.addEventListener('input', () => {
    textInput.value = picker.value;
    textInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

try { setTheme(localStorage.getItem('html-pdf-studio-theme') || 'light'); }
catch { setTheme('light'); }
setPreviewDocument();

window.studioApi.onStatus((event) => {
  if (event.type === 'window-fullscreen') {
    setFullscreenControl(Boolean(event.fullScreen));
    return;
  }
  if (event.type === 'dismiss-app-menu') {
    closeMenus();
    return;
  }
  if (event.type === 'shortcut') {
    closeMenus();
    if (event.action === 'open') openFilePicker();
    else if (event.action === 'export') exportPdf();
    else if (event.action === 'undo') undoSettings();
    else if (event.action === 'redo') redoSettings();
    return;
  }
  if (event.type === 'rendering') {
    updateInProgress = true;
    elements.export.disabled = true;
    updateMenuAvailability();
    elements.previewState.classList.add('is-busy');
    setStatus('Rendering PDF preview...');
    elements.previewStateLabel.textContent = 'Updating preview';
  }
  if (event.type === 'preview-ready') {
    setStatus('Preview ready. Changes are saved locally.');
    elements.previewStateLabel.textContent = 'Preview ready';
    elements.export.disabled = false;
    updateInProgress = false;
    updateMenuAvailability();
    elements.previewState.classList.remove('is-busy');
  }
  if (event.type === 'document-loaded') {
    currentFile = event.filePath;
    elements.pathInput.value = event.filePath;
    elements.fileLabel.textContent = event.fileName;
    elements.fileLabel.classList.remove('muted');
    setPreviewDocument(event.fileName);
    sections = event.sections || [];
    hydrateSettings(event.settings);
    elements.reset.disabled = false;
    elements.export.disabled = false;
    elements.previewStateLabel.textContent = 'Rendering preview';
  }
  if (event.type === 'exported') setStatus(`Saved ${event.outputPath}`, 'success');
  if (event.type === 'settings-reset') hydrateSettings(event.settings);
  if (event.type === 'error') {
    setStatus(event.message || 'Something went wrong while creating the preview.', 'error');
    elements.previewStateLabel.textContent = 'Preview issue';
    updateInProgress = false;
    updateMenuAvailability();
    elements.previewState.classList.remove('is-busy');
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
