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

  let cr = item.cropRect;
  if (!cr) {
    // Defensive fallback: auto-fit to preserve source aspect ratio
    const iw = item.sourceCanvas.width, ih = item.sourceCanvas.height;
    const ratio = state.aspectRatio;
    let w, h;
    if (iw / ih >= ratio) { h = ih; w = h * ratio; }
    else { w = iw; h = w / ratio; }
    cr = { x: (iw - w) / 2, y: (ih - h) / 2, w, h };
  }

  ctx.drawImage(item.sourceCanvas, cr.x, cr.y, cr.w, cr.h, 0, 0, c.width, c.height);
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
    // Per-image adjustments override the global UI values for this item
    if (item.adjustments) {
      opts.preprocessing = { enabled: true, ...item.adjustments };
    }
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

  const btns = ['exportFilesBtn','exportZipBtn'].map(id => document.getElementById(id));
  btns.forEach(b => { b.disabled = true; b.textContent = '⏳ Processing…'; });

  let doneCount = 0;
  for (const item of state.queue) {
    if (await processItem(item)) doneCount++;
    await tick();
  }

  state.isProcessing = false;
  btns[0].textContent = 'Export Files';
  btns[1].textContent = 'Export ZIP';
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
function getStartNumber() {
  return parseInt(document.getElementById('exportStartNum')?.value) || 1;
}

// ─── EXPORT FILES (folder picker or individual downloads) ────
export async function downloadFiles() {
  const done = await processAndGetDone();
  if (!done) return;
  const startNum = getStartNumber();

  if ('showDirectoryPicker' in window) {
    // Chrome / Edge — single folder picker
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      if (e.name !== 'AbortError') toast('Could not open folder: ' + e.message, 'error');
      return;
    }
    let saved = 0;
    try {
      for (let i = 0; i < done.length; i++) {
        const blob  = await canvasToBlob(done[i].deviceCanvas || done[i].ditheredCanvas);
        const fname = `${startNum + i}.png`;
        const fh    = await dir.getFileHandle(fname, { create: true });
        const w     = await fh.createWritable();
        await w.write(blob);
        await w.close();
        saved++;
      }
      toast(`✓ Saved ${saved} file${saved !== 1 ? 's' : ''} to folder.`, 'success');
    } catch (e) {
      toast(`Export failed after ${saved} file${saved !== 1 ? 's' : ''}: ${e.message}`, 'error');
    }
  } else {
    // Firefox / Safari — individual automatic downloads
    for (let i = 0; i < done.length; i++) {
      const blob  = await canvasToBlob(done[i].deviceCanvas || done[i].ditheredCanvas);
      const fname = `${startNum + i}.png`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      a.click();
      URL.revokeObjectURL(a.href);
      await new Promise(res => setTimeout(res, 150)); // small delay between triggers
    }
    toast(`✓ Downloaded ${done.length} file${done.length !== 1 ? 's' : ''}.`, 'success');
  }
}

// ─── EXPORT ZIP (all browsers) ───────────────────────────────
export async function downloadZip() {
  const done = await processAndGetDone();
  if (!done) return;

  toast('Preparing ZIP…');
  try {
    const { default: JSZip } = await import('https://esm.sh/jszip@3.10.1');
    const zip      = new JSZip();
    const startNum = getStartNumber();

    for (let i = 0; i < done.length; i++) {
      const blob = await canvasToBlob(done[i].deviceCanvas || done[i].ditheredCanvas);
      zip.file(`${startNum + i}.png`, blob);
    }

    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zipBlob);
    a.download = 'epd-export.zip';
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`✓ Downloaded ${done.length} image${done.length !== 1 ? 's' : ''} as epd-export.zip`, 'success');
  } catch (e) {
    toast('ZIP export failed: ' + e.message, 'error');
  }
}

// ─── EXPORT CURRENT IMAGE ────────────────────────────────────
export async function downloadCurrent() {
  const item = getSelected();
  if (!item) { toast('No image selected.', 'error'); return; }

  if (item.status !== 'done') await ensureProcessed(item);
  if (!item.deviceCanvas && !item.ditheredCanvas) { toast('Processing failed.', 'error'); return; }

  const canvas   = item.deviceCanvas || item.ditheredCanvas;
  const baseName = item.name.replace(/\.[^.]+$/, '');
  const blob     = await canvasToBlob(canvas);
  const a        = document.createElement('a');
  a.href         = URL.createObjectURL(blob);
  a.download     = baseName + '.png';
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`✓ Exported ${baseName}.png`, 'success');
}

// ─── SHARED HELPERS ──────────────────────────────────────────
async function processAndGetDone() {
  const unprocessed = state.queue.filter(q => q.status !== 'done' && q.status !== 'error');
  if (unprocessed.length > 0) await processAll();
  const done = state.queue.filter(q => q.status === 'done');
  if (done.length === 0) { toast('No processed images to save.', 'error'); return null; }
  return done;
}

// ─── HELPERS ─────────────────────────────────────────────────
function tick() { return new Promise(res => setTimeout(res, 0)); }

function waitForSource(item, timeout = 5000) {
  return new Promise(res => {
    const t = setInterval(() => { if (item.sourceCanvas) { clearInterval(t); res(); } }, 50);
    setTimeout(() => { clearInterval(t); res(); }, timeout);
  });
}

function canvasToBlob(canvas) {
  return new Promise(res => canvas.toBlob(res, 'image/png'));
}
