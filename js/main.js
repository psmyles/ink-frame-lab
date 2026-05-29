import { state, createItem, getSelected } from './state.js';
import { initSidebar, updatePaletteSwatch } from './sidebar.js';
import {
  renderFilmstrip, refreshFilmItem, selectItem, showDropZone,
  updateUIState, updateStats, loadSourceImage,
  enterCropMode, cancelCrop, applyCrop, resetCrop, autoFitCrop,
  toast, isCropMode,
} from './ui.js';
import { downloadAll } from './export.js';
import {
  initViewer3d, applyEnvPreset,
  resetCamera, toggleZoom, toggleOrbit,
  resizeViewer, onEnter3dView, rebuildFrame, setGlassVisible, isReady,
  loadIBLFromFile, setIBLIntensity, setDisplayAdjustment,
} from './viewer3d.js';

// ─── QUEUE MANAGEMENT ────────────────────────────────────────
function addFiles(files) {
  let added = 0;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const item = createItem(file);
    state.queue.push(item);
    added++;
    loadSourceImage(item);
  }
  if (added === 0) return;
  renderFilmstrip();
  updateStats();
  updateUIState();
  if (!state.selectedId && state.queue.length > 0) {
    selectItem(state.queue[0].id);
  }
}

// ─── VIEW TAB SWITCHING ───────────────────────────────────────
async function switchTab(tab) {
  if (isCropMode()) cancelCrop();
  state.viewTab = tab;

  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  const canvas2d = document.getElementById('canvas2d');
  const canvas3d = document.getElementById('canvas3d');

  if (tab === 'image') {
    canvas2d.style.display = 'block';
    canvas3d.style.display = 'none';
    updateUIState();
    // Re-render 2D view
    const { renderPreview } = await import('./ui.js');
    renderPreview();
  } else {
    canvas2d.style.display = 'none';
    canvas3d.style.display = 'block';
    updateUIState();
    if (!isReady()) {
      initViewer3d(canvas3d);
    }
    await onEnter3dView();
  }
}

// ─── RESOLUTION CHANGE → REBUILD FRAME ───────────────────────
function onResolutionChange() {
  if (isReady() && state.viewTab === '3d') rebuildFrame();
}

// ─── DRAG & DROP ─────────────────────────────────────────────
function initDragDrop() {
  const body = document.body;
  body.addEventListener('dragover', e => {
    e.preventDefault();
    document.getElementById('dropBox').classList.add('dragover');
  });
  body.addEventListener('dragleave', e => {
    if (!e.relatedTarget) document.getElementById('dropBox').classList.remove('dragover');
  });
  body.addEventListener('drop', e => {
    e.preventDefault();
    document.getElementById('dropBox').classList.remove('dragover');
    addFiles(e.dataTransfer.files);
  });
}

// ─── RESIZE OBSERVER ─────────────────────────────────────────
function initResizeObserver() {
  const area = document.getElementById('viewArea');
  const ro = new ResizeObserver(() => {
    if (state.viewTab === '3d' && isReady()) {
      resizeViewer(area.clientWidth, area.clientHeight);
    }
    if (state.viewTab === 'image' && state.selectedId) {
      import('./ui.js').then(m => m.renderPreview());
    }
  });
  ro.observe(area);
}

// ─── INIT ─────────────────────────────────────────────────────
function init() {
  // Sidebar
  initSidebar();

  // Wire resolution changes to frame rebuild
  document.getElementById('resW').addEventListener('change', onResolutionChange);
  document.getElementById('resH').addEventListener('change', onResolutionChange);

  // View tabs
  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // File inputs
  const fileInput = document.getElementById('fileInput');
  const fileInputHidden = document.getElementById('fileInputHidden');
  fileInput.addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  fileInputHidden.addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });

  document.getElementById('filmAdd').addEventListener('click', () => fileInputHidden.click());
  document.getElementById('importBtn').addEventListener('click', () => fileInputHidden.click());
  document.getElementById('exportBtn').addEventListener('click', downloadAll);

  // Crop controls
  document.getElementById('btnCrop').addEventListener('click', enterCropMode);
  document.getElementById('btnAutoFit').addEventListener('click', () => autoFitCrop());
  document.getElementById('btnCancelCrop').addEventListener('click', cancelCrop);
  document.getElementById('btnApplyCrop').addEventListener('click', applyCrop);
  document.getElementById('resetCropBtn').addEventListener('click', resetCrop);

  // 3D controls
  document.getElementById('btnZoom').addEventListener('click', toggleZoom);
  document.getElementById('btnOrbit').addEventListener('click', toggleOrbit);
  document.getElementById('btnReset').addEventListener('click', resetCamera);

  // IBL intensity slider
  const iblSlider = document.getElementById('iblSlider');
  iblSlider.addEventListener('input', () => {
    if (isReady()) setIBLIntensity(parseFloat(iblSlider.value));
  });

  // Debug display adjustments
  const adjDefs = [
    { id: 'adjExposure',    key: 'exposure',    fmt: v => v.toFixed(2) },
    { id: 'adjContrast',    key: 'contrast',    fmt: v => v.toFixed(2) },
    { id: 'adjSaturation',  key: 'saturation',  fmt: v => v.toFixed(2) },
    { id: 'adjTemperature', key: 'temperature', fmt: v => (v >= 0 ? '+' : '') + v },
    { id: 'adjTint',        key: 'tint',        fmt: v => (v >= 0 ? '+' : '') + v },
    { id: 'adjShadows',     key: 'shadows',     fmt: v => (v >= 0 ? '+' : '') + v },
    { id: 'adjMidtones',    key: 'midtones',    fmt: v => (v >= 0 ? '+' : '') + v },
    { id: 'adjHighlights',  key: 'highlights',  fmt: v => (v >= 0 ? '+' : '') + v },
  ];
  for (const { id, key, fmt } of adjDefs) {
    const slider = document.getElementById(id);
    const valEl  = document.getElementById(id + 'Val');
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      valEl.textContent = fmt(v);
      if (isReady()) setDisplayAdjustment(key, v);
    });
  }
  document.getElementById('adjReset').addEventListener('click', () => {
    const defaults = { adjExposure: 0.89, adjContrast: 0.91, adjSaturation: 1.00, adjTemperature: 2, adjTint: 0, adjShadows: 0, adjMidtones: 0, adjHighlights: 0 };
    for (const { id, key, fmt } of adjDefs) {
      const slider = document.getElementById(id);
      slider.value = defaults[id];
      document.getElementById(id + 'Val').textContent = fmt(defaults[id]);
      if (isReady()) setDisplayAdjustment(key, defaults[id]);
    }
  });

  // IBL file loader
  const iblFileInput = document.getElementById('iblFileInput');
  document.querySelector('.env-ibl-btn').addEventListener('click', () => iblFileInput.click());
  iblFileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (file && isReady()) await loadIBLFromFile(file);
    e.target.value = '';
  });

  // Environment preset buttons
  document.querySelectorAll('.env-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isReady()) applyEnvPreset(btn.dataset.env);
    });
  });

  initDragDrop();
  initResizeObserver();
  showDropZone(true);
  updateUIState();
  updateStats();
}

document.addEventListener('DOMContentLoaded', init);
