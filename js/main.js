import { state, createItem, getSelected } from './state.js';
import { loadPresets } from './dithering.js';
import { initSidebar, buildPaletteSelect } from './sidebar.js';
import {
  renderFilmstrip, selectItem, showDropZone,
  updateUIState, updateStats, loadSourceImage,
  startCropEdit, applyAndExitCropEdit, cancelCropEdit, doAutoFit, doResetCrop,
  renderPreview, renderFirmwareView, toast, setOnSelectCallback,
} from './ui.js';
import { downloadFiles, downloadZip, downloadCurrent, ensureProcessed } from './export.js';
import {
  initViewer3d,
  resetCamera, toggleZoom, toggleOrbit,
  resizeViewer, onEnter3dView, rebuildFrame, isReady,
  loadIBLByPath, setIBLIntensity, setFrameStyle,
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
  if (!state.selectedId && state.queue.length > 0) selectItem(state.queue[0].id);
}

// ─── VIEW TAB SWITCHING ───────────────────────────────────────
async function switchTab(tab) {
  state.viewTab = tab;

  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  const canvas2d       = document.getElementById('canvas2d');
  const canvasFirmware = document.getElementById('canvasFirmware');
  const canvas3d       = document.getElementById('canvas3d');

  canvas2d.style.display       = tab === 'image'    ? 'block' : 'none';
  canvasFirmware.style.display = tab === 'firmware' ? 'block' : 'none';
  canvas3d.style.display       = tab === '3d'       ? 'block' : 'none';

  updateUIState();

  if (tab === 'image') {
    renderPreview();
  } else if (tab === 'firmware') {
    const item = getSelected();
    if (item && item.status !== 'done') await ensureProcessed(item);
    renderFirmwareView();
  } else {
    if (!isReady()) initViewer3d(canvas3d);
    await onEnter3dView();
  }
}

// ─── RESOLUTION CHANGE ───────────────────────────────────────
async function onResolutionChange() {
  doResetCrop();   // recompute auto-fit crop to new aspect ratio; marks item pending
  updateUIState(); // refreshes cropRatioLabel and toolbar state

  const item = getSelected();
  if (state.viewTab === 'firmware') {
    if (item && item.status !== 'processing') {
      await ensureProcessed(item);
      renderFirmwareView();
    }
  } else if (state.viewTab === '3d' && isReady()) {
    rebuildFrame();
    await onEnter3dView();
  }
  // Image view: doResetCrop() already called renderPreview()
}

// ─── DRAG & DROP ─────────────────────────────────────────────
function initDragDrop() {
  document.body.addEventListener('dragover', e => {
    e.preventDefault();
    document.getElementById('dropBox').classList.add('dragover');
  });
  document.body.addEventListener('dragleave', e => {
    if (!e.relatedTarget) document.getElementById('dropBox').classList.remove('dragover');
  });
  document.body.addEventListener('drop', e => {
    e.preventDefault();
    document.getElementById('dropBox').classList.remove('dragover');
    addFiles(e.dataTransfer.files);
  });
}

// ─── RESIZE OBSERVER ─────────────────────────────────────────
function initResizeObserver() {
  const area = document.getElementById('viewArea');
  new ResizeObserver(() => {
    if (state.viewTab === '3d' && isReady()) resizeViewer(area.clientWidth, area.clientHeight);
    if (state.viewTab === 'image' && state.selectedId) renderPreview();
    if (state.viewTab === 'firmware' && state.selectedId) renderFirmwareView();
  }).observe(area);
}

// ─── IBL PICKER ──────────────────────────────────────────────
function initIBLPicker() {
  const btn      = document.getElementById('iblPickerBtn');
  const dropdown = document.getElementById('iblPickerDropdown');
  const picker   = document.getElementById('iblPicker');

  btn.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
    picker.classList.toggle('open');
  });

  document.addEventListener('click', () => {
    dropdown.classList.add('hidden');
    picker.classList.remove('open');
  });

  document.querySelectorAll('.ibl-option').forEach(opt => {
    opt.addEventListener('click', async () => {
      const path  = opt.dataset.path;
      const label = opt.dataset.label;
      if (isReady()) await loadIBLByPath(path);
      document.getElementById('iblPickerThumb').src = path;
      document.getElementById('iblPickerLabel').textContent = label;
      document.querySelectorAll('.ibl-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      dropdown.classList.add('hidden');
      picker.classList.remove('open');
    });
  });

  // IBL intensity slider
  const iblSlider = document.getElementById('iblSlider');
  iblSlider.addEventListener('input', () => {
    if (isReady()) setIBLIntensity(parseFloat(iblSlider.value));
  });

  // Frame style
  document.getElementById('frameStyle').addEventListener('change', e => {
    if (isReady()) setFrameStyle(e.target.value);
  });
}

// ─── SETTINGS CHANGE → RE-PROCESS ACTIVE VIEW ────────────────
async function onSettingsChange() {
  const item = getSelected();
  if (!item || item.status === 'processing') return;
  // Invalidate so re-processing uses new settings
  item.status = 'pending';
  item.ditheredCanvas = null;
  item.deviceCanvas = null;
  const { refreshFilmItem, updateStats } = await import('./ui.js');
  refreshFilmItem(item);
  updateStats();

  if (state.viewTab === 'firmware') {
    await ensureProcessed(item);
    renderFirmwareView();
  } else if (state.viewTab === '3d' && isReady()) {
    await ensureProcessed(item);
    onEnter3dView();
  }
}

// ─── INIT ─────────────────────────────────────────────────────
function init() {
  document.getElementById('resW').addEventListener('change', onResolutionChange);
  document.getElementById('resH').addEventListener('change', onResolutionChange);

  // View tabs
  document.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // File inputs
  const fileInput       = document.getElementById('fileInput');
  const fileInputHidden = document.getElementById('fileInputHidden');
  fileInput.addEventListener('change',       e => { addFiles(e.target.files); e.target.value = ''; });
  fileInputHidden.addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  document.getElementById('filmAdd').addEventListener('click',     () => fileInputHidden.click());
  document.getElementById('importBtn').addEventListener('click',    () => fileInputHidden.click());
  document.getElementById('exportFilesBtn').addEventListener('click',   downloadFiles);
  document.getElementById('exportZipBtn').addEventListener('click',     downloadZip);
  document.getElementById('exportCurrentBtn').addEventListener('click', downloadCurrent);

  // Crop toolbar
  document.getElementById('btnEditCrop').addEventListener('click',  startCropEdit);
  document.getElementById('btnApplyCrop').addEventListener('click', applyAndExitCropEdit);
  document.getElementById('btnCancelCrop').addEventListener('click', cancelCropEdit);
  document.getElementById('btnAutoFit').addEventListener('click',   doAutoFit);
  document.getElementById('btnResetCrop').addEventListener('click', doResetCrop);

  // 3D controls
  document.getElementById('btnZoom').addEventListener('click',  toggleZoom);
  document.getElementById('btnOrbit').addEventListener('click', toggleOrbit);
  document.getElementById('btnReset').addEventListener('click', resetCamera);

  // Keep active view in sync when filmstrip selection changes
  setOnSelectCallback(async (id) => {
    if (state.viewTab === 'firmware') {
      const item = state.queue.find(q => q.id === id);
      if (item && item.status !== 'done') await ensureProcessed(item);
      renderFirmwareView();
    } else if (state.viewTab === '3d' && isReady()) {
      await onEnter3dView();
    }
  });

  // Re-process active view when palette or dithering settings change
  const settingsIds = ['palette','ditheringType','edMatrix','serpentine',
                       'orderedW','orderedH','randomType','customPalette'];
  for (const id of settingsIds) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', onSettingsChange);
  }

  initIBLPicker();
  initDragDrop();
  initResizeObserver();
  showDropZone(true);
  updateUIState();
  updateStats();
}

document.addEventListener('DOMContentLoaded', async () => {
  const { devices, palettes } = await loadPresets();
  buildPaletteSelect(palettes);
  initSidebar(devices);
  init();
});
