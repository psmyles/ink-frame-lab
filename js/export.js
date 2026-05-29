import { processImage } from './dithering.js';
import { state, getSelected } from './state.js';
import { getOptions } from './sidebar.js';
import { refreshFilmItem, updateStats, updateUIState, toast } from './ui.js';

// ─── CROP + RESIZE ───────────────────────────────────────────
export function getCroppedCanvas(item) {
  const c = document.createElement('canvas');
  c.width = state.resolution.w;
  c.height = state.resolution.h;
  const ctx = c.getContext('2d');
  if (item.cropRect) {
    const { x, y, w, h } = item.cropRect;
    ctx.drawImage(item.sourceCanvas, x, y, w, h, 0, 0, c.width, c.height);
  } else {
    // No crop — scale the full source to the target resolution
    ctx.drawImage(item.sourceCanvas, 0, 0, c.width, c.height);
  }
  return c;
}

// ─── PROCESS SINGLE ITEM ─────────────────────────────────────
export async function processItem(item) {
  if (!item.sourceCanvas) {
    await waitForSource(item);
    if (!item.sourceCanvas) return false;
  }

  item.status = 'processing';
  refreshFilmItem(item);
  updateStats();
  await tick();

  try {
    const opts = getOptions();
    const inputCanvas = getCroppedCanvas(item);
    const { dithered, deviceResult } = processImage(inputCanvas, opts);

    const dCanvas = document.createElement('canvas');
    dCanvas.width = inputCanvas.width; dCanvas.height = inputCanvas.height;
    dCanvas.getContext('2d').putImageData(dithered, 0, 0);
    item.ditheredCanvas = dCanvas;

    const devCanvas = document.createElement('canvas');
    devCanvas.width = inputCanvas.width; devCanvas.height = inputCanvas.height;
    devCanvas.getContext('2d').putImageData(deviceResult, 0, 0);
    item.deviceCanvas = devCanvas;

    item.status = 'done';
    return true;
  } catch (err) {
    item.status = 'error';
    console.error('Processing error:', err);
    return false;
  } finally {
    refreshFilmItem(item);
    updateStats();
  }
}

// ─── PROCESS ALL ─────────────────────────────────────────────
export async function processAll() {
  if (state.isProcessing) return;
  state.isProcessing = true;
  updateUIState();

  const exportBtn = document.getElementById('exportBtn');
  const orig = exportBtn.textContent;
  exportBtn.textContent = '⏳ Processing…';
  exportBtn.disabled = true;

  let doneCount = 0;
  for (const item of state.queue) {
    if (await processItem(item)) doneCount++;
    await tick();
  }

  state.isProcessing = false;
  exportBtn.textContent = orig;
  updateUIState();
  toast(`✓ ${doneCount} image${doneCount !== 1 ? 's' : ''} processed.`, 'success');
  return doneCount;
}

// ─── ENSURE SINGLE ITEM PROCESSED ────────────────────────────
// Used by 3D view when switching tabs
export async function ensureProcessed(item) {
  if (!item || item.status === 'done') return;
  await processItem(item);
}

// ─── DOWNLOAD ────────────────────────────────────────────────
export function downloadItem(item) {
  if (!item || !item.ditheredCanvas) return;
  const opts = getOptions();
  const base = item.name.replace(/\.[^.]+$/, '');
  saveCanvas(item.deviceCanvas || item.ditheredCanvas, base + opts.suffix + '.png');
}

export async function downloadAll() {
  // Process any unprocessed items first
  const unprocessed = state.queue.filter(q => q.status !== 'done' && q.status !== 'error');
  if (unprocessed.length > 0) {
    await processAll();
  }

  const done = state.queue.filter(q => q.status === 'done');
  if (done.length === 0) { toast('No processed images to save.', 'error'); return; }

  const opts = getOptions();

  if ('showDirectoryPicker' in window) {
    try {
      const dir = await window.showDirectoryPicker();
      let saved = 0;
      for (const item of done) {
        const base = item.name.replace(/\.[^.]+$/, '');
        const canvas = item.deviceCanvas || item.ditheredCanvas;
        const fname = base + opts.suffix + '.png';
        const blob = await canvasToBlob(canvas);
        const fh = await dir.getFileHandle(fname, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
        saved++;
      }
      toast(`✓ Saved ${saved} file${saved !== 1 ? 's' : ''} to folder.`, 'success');
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('showDirectoryPicker failed, falling back:', e);
    }
  }

  // Fallback: trigger individual downloads
  toast(`Downloading ${done.length} file${done.length !== 1 ? 's' : ''}…`);
  for (let i = 0; i < done.length; i++) {
    await new Promise(res => setTimeout(res, i * 150));
    downloadItem(done[i]);
  }
}

// ─── HELPERS ─────────────────────────────────────────────────
function tick() { return new Promise(res => setTimeout(res, 0)); }

function waitForSource(item, timeout = 5000) {
  return new Promise(res => {
    const t = setInterval(() => { if (item.sourceCanvas) { clearInterval(t); res(); } }, 50);
    setTimeout(() => { clearInterval(t); res(); }, timeout);
  });
}

function saveCanvas(canvas, filename) {
  canvas.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }, 'image/png');
}

function canvasToBlob(canvas) {
  return new Promise(res => canvas.toBlob(res, 'image/png'));
}
