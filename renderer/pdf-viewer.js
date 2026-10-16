import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;

const $ = (selector) => document.querySelector(selector);
const ui = {
  content: $('#pdf-viewer-content'),
  pageScroll: $('#pdf-page-scroll'),
  pages: $('#pdf-pages'),
  empty: $('#preview-empty'),
  loadingOverlay: $('#pdf-loading-overlay'),
  loadingLabel: $('#pdf-loading-label'),
  errorOverlay: $('#pdf-error-overlay'),
  errorMessage: $('#pdf-error-message'),
  thumbnailsToggle: $('#thumbnails-toggle'),
  thumbnailSidebar: $('#thumbnail-sidebar'),
  thumbnailList: $('#thumbnail-list'),
  thumbnailCount: $('#thumbnail-page-count'),
  pageInput: $('#pdf-page-number'),
  pageTotal: $('#pdf-page-total'),
  previousPage: $('#page-prev'),
  nextPage: $('#page-next'),
  zoomOut: $('#zoom-out'),
  zoomIn: $('#zoom-in'),
  zoomLevel: $('#zoom-level'),
  fitWidth: $('#fit-width'),
  searchInput: $('#pdf-search-input'),
  searchCount: $('#pdf-search-count'),
  searchPrevious: $('#search-prev'),
  searchNext: $('#search-next')
};

const MIN_SCALE = 0.35;
const MAX_SCALE = 3;
const SCALE_STEP = 0.1;
const OUTPUT_SCALE = Math.min(window.devicePixelRatio || 1, 2);
let pdfDocument = null;
let activeLoadingTask = null;
let pageViews = [];
let pageObserver = null;
let renderObserver = null;
let thumbnailObserver = null;
let currentPageNumber = 1;
let scale = 1;
let zoomMode = 'width';
let loadSequence = 0;
let sourceFilePath = '';
let searchTimer = null;
let searchSequence = 0;
let searchQuery = '';
let searchMatches = [];
let selectedMatchIndex = -1;
const visibleRatios = new Map();

function setControlsEnabled(enabled) {
  for (const button of [
    ui.thumbnailsToggle, ui.previousPage, ui.nextPage, ui.zoomOut, ui.zoomIn,
    ui.zoomLevel, ui.fitWidth, ui.pageInput, ui.searchInput
  ]) button.disabled = !enabled;
  updateNavigationControls();
}

function showLoading(message = 'Preparing PDF preview…') {
  ui.errorOverlay.hidden = true;
  ui.empty.classList.add('is-hidden');
  ui.loadingLabel.textContent = message;
  ui.loadingOverlay.hidden = false;
}

function showError(message) {
  ui.loadingOverlay.hidden = true;
  ui.errorMessage.textContent = message || 'The PDF preview could not be opened.';
  ui.errorOverlay.hidden = false;
  setControlsEnabled(Boolean(pdfDocument));
}

function updateNavigationControls() {
  const hasDocument = Boolean(pdfDocument);
  const pageCount = pdfDocument?.numPages || 0;
  ui.previousPage.disabled = !hasDocument || currentPageNumber <= 1;
  ui.nextPage.disabled = !hasDocument || currentPageNumber >= pageCount;
  ui.zoomOut.disabled = !hasDocument || scale <= MIN_SCALE;
  ui.zoomIn.disabled = !hasDocument || scale >= MAX_SCALE;
  ui.zoomLevel.disabled = !hasDocument;
  ui.fitWidth.disabled = !hasDocument;
  ui.thumbnailsToggle.disabled = !hasDocument;
  ui.pageInput.disabled = !hasDocument;
  ui.searchInput.disabled = !hasDocument;
  ui.searchPrevious.disabled = selectedMatchIndex < 0 || searchMatches.length < 2;
  ui.searchNext.disabled = selectedMatchIndex < 0 || searchMatches.length < 2;
}

function updatePageNumber(pageNumber) {
  if (!pdfDocument) return;
  const nextPage = Math.max(1, Math.min(pdfDocument.numPages, pageNumber));
  currentPageNumber = nextPage;
  ui.pageInput.value = String(nextPage);
  ui.pageTotal.textContent = String(pdfDocument.numPages);
  ui.thumbnailList.querySelectorAll('.thumbnail-card').forEach((button) => {
    const selected = Number(button.dataset.page) === nextPage;
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  updateNavigationControls();
}

function updateScaleLabel() {
  ui.zoomLevel.textContent = `${Math.round(scale * 100)}%`;
  ui.zoomLevel.title = zoomMode === 'width' ? 'Fit page width' : 'Reset zoom to 100%';
  ui.fitWidth.setAttribute('aria-pressed', String(zoomMode === 'width'));
  ui.fitWidth.title = zoomMode === 'width' ? 'Page width is fitted to the viewer' : 'Fit page width';
  updateNavigationControls();
}

function cancelPageRender(view) {
  view.renderSequence += 1;
  if (view.renderTask) {
    try { view.renderTask.cancel(); } catch {}
    view.renderTask = null;
  }
  if (view.textLayer) {
    try { view.textLayer.cancel(); } catch {}
    view.textLayer = null;
  }
}

function pageViewport(view) {
  return view.page.getViewport({ scale });
}

function applyPageDimensions(view) {
  const viewport = pageViewport(view);
  view.shell.style.width = `${Math.ceil(viewport.width)}px`;
  view.shell.style.height = `${Math.ceil(viewport.height)}px`;
  return viewport;
}

function makeHighlightFragment(text, ranges) {
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const start = Math.max(cursor, range.start);
    const end = Math.min(text.length, range.end);
    if (end <= start) continue;
    if (start > cursor) fragment.append(document.createTextNode(text.slice(cursor, start)));
    const mark = document.createElement('mark');
    if (range.current) mark.classList.add('current');
    mark.textContent = text.slice(start, end);
    fragment.append(mark);
    cursor = end;
  }
  if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
  return fragment;
}

function applySearchHighlights(view) {
  if (!view.textLayer) return;
  const textDivs = view.textLayer.textDivs;
  const textItems = view.textLayer.textContentItemsStr;
  const highlights = new Map();
  searchMatches.forEach((match, matchIndex) => {
    if (match.pageNumber !== view.pageNumber) return;
    for (const segment of match.segments) {
      if (!highlights.has(segment.itemIndex)) highlights.set(segment.itemIndex, []);
      highlights.get(segment.itemIndex).push({
        start: segment.start,
        end: segment.end,
        current: matchIndex === selectedMatchIndex
      });
    }
  });
  for (let index = 0; index < textDivs.length; index += 1) {
    const text = textItems[index] ?? textDivs[index].textContent ?? '';
    textDivs[index].replaceChildren(makeHighlightFragment(text, highlights.get(index) || []));
  }
}

async function renderPage(view) {
  if (view.rendering || !pdfDocument || view.document !== pdfDocument) return;
  view.rendering = true;
  const renderSequence = ++view.renderSequence;
  const viewport = applyPageDimensions(view);
  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-page-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.width = Math.max(1, Math.floor(viewport.width * OUTPUT_SCALE));
  canvas.height = Math.max(1, Math.floor(viewport.height * OUTPUT_SCALE));
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const textLayerContainer = document.createElement('div');
  textLayerContainer.className = 'pdf-text-layer';
  textLayerContainer.style.setProperty('--total-scale-factor', String(scale));
  view.shell.replaceChildren(canvas, textLayerContainer);

  try {
    const context = canvas.getContext('2d', { alpha: false });
    const renderTask = view.page.render({
      canvasContext: context,
      transform: OUTPUT_SCALE === 1 ? null : [OUTPUT_SCALE, 0, 0, OUTPUT_SCALE, 0, 0],
      viewport
    });
    view.renderTask = renderTask;
    const textContentPromise = view.textContentPromise || view.page.getTextContent();
    view.textContentPromise = textContentPromise;
    const [, textContent] = await Promise.all([renderTask.promise, textContentPromise]);
    if (renderSequence !== view.renderSequence || view.document !== pdfDocument) return;
    const textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayerContainer, viewport });
    view.textLayer = textLayer;
    await textLayer.render();
    if (renderSequence !== view.renderSequence || view.document !== pdfDocument) return;
    view.rendered = true;
    view.renderTask = null;
    view.textLayer = textLayer;
    applySearchHighlights(view);
  } catch (error) {
    if (error?.name !== 'RenderingCancelledException' && error?.name !== 'AbortException') {
      console.error(`Could not render PDF page ${view.pageNumber}:`, error);
    }
  } finally {
    if (renderSequence === view.renderSequence) {
      view.rendering = false;
      view.renderTask = null;
    }
  }
}

function renderThumbnail(view) {
  if (view.thumbnailRendered || view.thumbnailRendering) return;
  view.thumbnailRendering = true;
  const canvas = view.thumbnailCanvas;
  const maxWidth = 100;
  const maxHeight = 132;
  const thumbScale = Math.min(maxWidth / view.baseViewport.width, maxHeight / view.baseViewport.height);
  const viewport = view.page.getViewport({ scale: thumbScale });
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const renderTask = view.page.render({ canvas, viewport });
  renderTask.promise.then(() => {
    view.thumbnailRendered = true;
  }).catch((error) => {
    if (error?.name !== 'RenderingCancelledException') console.error(`Could not render page ${view.pageNumber} thumbnail:`, error);
  }).finally(() => {
    view.thumbnailRendering = false;
  });
}

function createObservers() {
  pageObserver?.disconnect();
  renderObserver?.disconnect();
  thumbnailObserver?.disconnect();
  visibleRatios.clear();

  pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) visibleRatios.set(entry.target, entry.intersectionRatio);
    const mostVisible = [...visibleRatios.entries()].sort((a, b) => b[1] - a[1])[0];
    if (mostVisible?.[1] > 0.12) {
      const view = pageViews.find((candidate) => candidate.shell === mostVisible[0]);
      if (view && view.pageNumber !== currentPageNumber) updatePageNumber(view.pageNumber);
    }
  }, { root: ui.pageScroll, threshold: [0.12, 0.35, 0.6, 0.85] });
  renderObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const view = pageViews.find((candidate) => candidate.shell === entry.target);
      if (view) renderPage(view);
    }
  }, { root: ui.pageScroll, rootMargin: '120% 0px', threshold: 0 });
  thumbnailObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const view = pageViews.find((candidate) => candidate.thumbnailCard === entry.target);
      if (view) renderThumbnail(view);
    }
  }, { root: ui.thumbnailList, rootMargin: '80% 0px', threshold: 0 });

  for (const view of pageViews) {
    pageObserver.observe(view.shell);
    renderObserver.observe(view.shell);
    thumbnailObserver.observe(view.thumbnailCard);
  }
}

async function createPageViews(documentProxy, sequence) {
  pageViews = [];
  ui.pages.replaceChildren();
  ui.thumbnailList.replaceChildren();
  visibleRatios.clear();
  ui.thumbnailCount.textContent = String(documentProxy.numPages);
  ui.pageTotal.textContent = String(documentProxy.numPages);
  ui.pageInput.max = String(documentProxy.numPages);

  for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
    if (sequence !== loadSequence) return;
    const page = await documentProxy.getPage(pageNumber);
    const view = {
      document: documentProxy,
      page,
      pageNumber,
      baseViewport: page.getViewport({ scale: 1 }),
      shell: document.createElement('article'),
      thumbnailCard: document.createElement('button'),
      thumbnailCanvas: document.createElement('canvas'),
      textContentPromise: null,
      textLayer: null,
      renderTask: null,
      renderSequence: 0,
      rendering: false,
      rendered: false,
      thumbnailRendered: false,
      thumbnailRendering: false
    };
    view.shell.className = 'pdf-page-shell';
    view.shell.dataset.page = String(pageNumber);
    view.shell.setAttribute('aria-label', `Page ${pageNumber}`);
    applyPageDimensions(view);
    ui.pages.append(view.shell);

    view.thumbnailCard.type = 'button';
    view.thumbnailCard.className = 'thumbnail-card';
    view.thumbnailCard.dataset.page = String(pageNumber);
    view.thumbnailCard.setAttribute('aria-label', `Go to page ${pageNumber}`);
    view.thumbnailCard.innerHTML = '<span class="thumbnail-paper"></span><span class="thumbnail-number"></span>';
    view.thumbnailCard.querySelector('.thumbnail-paper').append(view.thumbnailCanvas);
    view.thumbnailCard.querySelector('.thumbnail-number').textContent = String(pageNumber);
    view.thumbnailCard.addEventListener('click', () => goToPage(pageNumber));
    ui.thumbnailList.append(view.thumbnailCard);
    pageViews.push(view);
  }
  createObservers();
}

function scaleTo(nextScale, mode = 'manual') {
  if (!pdfDocument) return;
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
  zoomMode = mode;
  for (const view of pageViews) {
    cancelPageRender(view);
    view.rendering = false;
    view.rendered = false;
    view.shell.replaceChildren();
    applyPageDimensions(view);
  }
  updateScaleLabel();
  renderVisiblePages();
}

function renderVisiblePages() {
  const bounds = ui.pageScroll.getBoundingClientRect();
  for (const view of pageViews) {
    const pageBounds = view.shell.getBoundingClientRect();
    if (pageBounds.bottom >= bounds.top - bounds.height && pageBounds.top <= bounds.bottom + bounds.height) renderPage(view);
  }
}

function fitPageWidth() {
  if (!pdfDocument || pageViews.length === 0) return;
  const view = pageViews[Math.max(0, currentPageNumber - 1)] || pageViews[0];
  const availableWidth = Math.max(160, ui.pageScroll.clientWidth - 72);
  scaleTo(availableWidth / view.baseViewport.width, 'width');
}

function goToPage(pageNumber, behavior = 'smooth') {
  if (!pdfDocument || pageViews.length === 0) return;
  const nextPage = Math.max(1, Math.min(pdfDocument.numPages, Number(pageNumber) || 1));
  updatePageNumber(nextPage);
  pageViews[nextPage - 1].shell.scrollIntoView({ behavior, block: 'start' });
  renderPage(pageViews[nextPage - 1]);
}

function setThumbnailSidebar(open) {
  ui.thumbnailSidebar.hidden = !open;
  ui.content.classList.toggle('has-thumbnails', open);
  ui.thumbnailsToggle.setAttribute('aria-pressed', String(open));
  ui.thumbnailsToggle.setAttribute('aria-label', open ? 'Hide page thumbnails' : 'Show page thumbnails');
  ui.thumbnailsToggle.title = open ? 'Hide page thumbnails (T)' : 'Show page thumbnails (T)';
  if (zoomMode === 'width') requestAnimationFrame(fitPageWidth);
}

function buildPageSearchMatches(pageNumber, textItems, query) {
  const pieces = [];
  let text = '';
  for (let itemIndex = 0; itemIndex < textItems.length; itemIndex += 1) {
    const itemText = String(textItems[itemIndex] || '');
    if (itemIndex > 0) text += ' ';
    const start = text.length;
    text += itemText;
    pieces.push({ itemIndex, start, end: text.length });
  }
  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  const matches = [];
  let searchFrom = 0;
  while (lowerQuery && searchFrom <= lowerText.length - lowerQuery.length) {
    const index = lowerText.indexOf(lowerQuery, searchFrom);
    if (index < 0) break;
    const end = index + lowerQuery.length;
    const segments = [];
    for (const piece of pieces) {
      const overlapStart = Math.max(index, piece.start);
      const overlapEnd = Math.min(end, piece.end);
      if (overlapEnd > overlapStart) {
        segments.push({ itemIndex: piece.itemIndex, start: overlapStart - piece.start, end: overlapEnd - piece.start });
      }
    }
    if (segments.length) matches.push({ pageNumber, segments });
    searchFrom = index + Math.max(1, lowerQuery.length);
  }
  return matches;
}

async function searchDocument(query, sequence) {
  if (!pdfDocument || !query.trim()) {
    searchMatches = [];
    selectedMatchIndex = -1;
    ui.searchCount.textContent = '';
    pageViews.forEach(applySearchHighlights);
    updateNavigationControls();
    return;
  }
  const matches = [];
  for (const view of pageViews) {
    if (sequence !== searchSequence || !pdfDocument) return;
    try {
      const content = await (view.textContentPromise || view.page.getTextContent());
      view.textContentPromise = Promise.resolve(content);
      const items = content.items.filter((item) => typeof item.str === 'string').map((item) => item.str);
      matches.push(...buildPageSearchMatches(view.pageNumber, items, query));
    } catch (error) {
      console.warn(`Could not search page ${view.pageNumber}:`, error);
    }
  }
  if (sequence !== searchSequence) return;
  searchMatches = matches;
  selectedMatchIndex = matches.length ? 0 : -1;
  ui.searchCount.textContent = matches.length ? `1/${matches.length}` : 'No matches';
  pageViews.forEach(applySearchHighlights);
  updateNavigationControls();
  if (matches.length) goToMatch(0);
}

function goToMatch(index) {
  if (!searchMatches.length) return;
  selectedMatchIndex = (index + searchMatches.length) % searchMatches.length;
  const match = searchMatches[selectedMatchIndex];
  ui.searchCount.textContent = `${selectedMatchIndex + 1}/${searchMatches.length}`;
  pageViews.forEach(applySearchHighlights);
  goToPage(match.pageNumber);
  const view = pageViews[match.pageNumber - 1];
  renderPage(view).then(() => {
    requestAnimationFrame(() => view.shell.querySelector('mark.current')?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }));
  });
  updateNavigationControls();
}

async function loadPreview() {
  const sequence = ++loadSequence;
  if (activeLoadingTask) {
    activeLoadingTask.destroy().catch(() => {});
    activeLoadingTask = null;
  }
  showLoading('Updating PDF preview…');
  setControlsEnabled(Boolean(pdfDocument));
  try {
    const data = await window.studioApi.readPreview();
    if (sequence !== loadSequence) return;
    const task = pdfjsLib.getDocument({ data, isEvalSupported: false });
    activeLoadingTask = task;
    const nextDocument = await task.promise;
    if (sequence !== loadSequence) {
      await nextDocument.destroy();
      return;
    }
    activeLoadingTask = null;
    const oldDocument = pdfDocument;
    pdfDocument = nextDocument;
    searchSequence += 1;
    window.clearTimeout(searchTimer);
    pageViews.forEach(cancelPageRender);
    pageViews = [];
    await createPageViews(pdfDocument, sequence);
    if (sequence !== loadSequence) return;
    searchMatches = [];
    selectedMatchIndex = -1;
    searchQuery = '';
    ui.searchInput.value = '';
    ui.searchCount.textContent = '';
    currentPageNumber = Math.max(1, Math.min(pdfDocument.numPages, currentPageNumber));
    updatePageNumber(currentPageNumber);
    if (zoomMode === 'width') fitPageWidth();
    else scaleTo(scale, zoomMode);
    goToPage(currentPageNumber, 'auto');
    ui.loadingOverlay.hidden = true;
    ui.errorOverlay.hidden = true;
    setControlsEnabled(true);
    if (oldDocument && oldDocument !== nextDocument) oldDocument.destroy().catch(() => {});
  } catch (error) {
    if (sequence !== loadSequence) return;
    console.error('Could not load PDF preview:', error);
    showError(error.message || 'The PDF preview could not be opened.');
  }
}

ui.thumbnailsToggle.addEventListener('click', () => setThumbnailSidebar(ui.thumbnailSidebar.hidden));
ui.previousPage.addEventListener('click', () => goToPage(currentPageNumber - 1));
ui.nextPage.addEventListener('click', () => goToPage(currentPageNumber + 1));
ui.pageInput.addEventListener('change', () => goToPage(ui.pageInput.value));
ui.pageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    goToPage(ui.pageInput.value);
    ui.pageInput.blur();
  }
});
ui.zoomOut.addEventListener('click', () => scaleTo(scale - SCALE_STEP));
ui.zoomIn.addEventListener('click', () => scaleTo(scale + SCALE_STEP));
ui.zoomLevel.addEventListener('click', () => scaleTo(1));
ui.fitWidth.addEventListener('click', fitPageWidth);
ui.searchInput.addEventListener('input', () => {
  searchQuery = ui.searchInput.value.trim();
  window.clearTimeout(searchTimer);
  const sequence = ++searchSequence;
  searchMatches = [];
  selectedMatchIndex = -1;
  pageViews.forEach(applySearchHighlights);
  updateNavigationControls();
  if (!searchQuery) {
    searchDocument('', sequence);
    return;
  }
  ui.searchCount.textContent = '…';
  searchTimer = window.setTimeout(() => searchDocument(searchQuery, sequence), 180);
});
ui.searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    goToMatch(selectedMatchIndex + (event.shiftKey ? -1 : 1));
  } else if (event.key === 'Escape') {
    ui.searchInput.value = '';
    ui.searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
ui.searchPrevious.addEventListener('click', () => goToMatch(selectedMatchIndex - 1));
ui.searchNext.addEventListener('click', () => goToMatch(selectedMatchIndex + 1));
window.addEventListener('resize', () => {
  if (zoomMode === 'width' && pdfDocument) requestAnimationFrame(fitPageWidth);
});
window.addEventListener('pdf-viewer:find', () => {
  if (!pdfDocument) return;
  ui.searchInput.focus();
  ui.searchInput.select();
});
window.addEventListener('keydown', (event) => {
  const target = event.target;
  const editing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key.toLowerCase() === 't' && pdfDocument) {
    event.preventDefault();
    setThumbnailSidebar(ui.thumbnailSidebar.hidden);
  } else if (event.key === 'PageUp' && pdfDocument) {
    event.preventDefault();
    goToPage(currentPageNumber - 1);
  } else if (event.key === 'PageDown' && pdfDocument) {
    event.preventDefault();
    goToPage(currentPageNumber + 1);
  } else if ((event.key === '+' || event.key === '=') && pdfDocument) {
    event.preventDefault();
    scaleTo(scale + SCALE_STEP);
  } else if (event.key === '-' && pdfDocument) {
    event.preventDefault();
    scaleTo(scale - SCALE_STEP);
  }
});

window.studioApi.onStatus((event) => {
  if (event.type === 'document-loaded') {
    const nextSource = event.filePath || '';
    if (nextSource !== sourceFilePath) {
      sourceFilePath = nextSource;
      currentPageNumber = 1;
      showLoading('Creating PDF preview…');
    }
  }
  if (event.type === 'preview-ready') {
    sourceFilePath = event.filePath || sourceFilePath;
    loadPreview();
  }
  if (event.type === 'error' && !pdfDocument) showError(event.message);
});

setControlsEnabled(false);
