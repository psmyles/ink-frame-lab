import { PALETTES, DEVICE_COLORS } from './dithering.js';
import { state } from './state.js';

const PRESETS = [
  { label: 'Waveshare 7.5"',     w: 800, h: 480 },
  { label: 'Waveshare 5.83"',    w: 648, h: 480 },
  { label: 'Pimoroni Inky 7.3"', w: 800, h: 480 },
  { label: 'Pimoroni Inky 5.7"', w: 600, h: 448 },
  { label: 'Pimoroni Inky 4"',   w: 640, h: 400 },
];

let activePanel = null;

export function getOptions() {
  const paletteKey = document.getElementById('palette').value;
  let palette      = PALETTES[paletteKey] || Object.values(PALETTES)[0];
  let deviceColors = DEVICE_COLORS[paletteKey] || Object.values(DEVICE_COLORS)[0];

  if (paletteKey === 'custom') {
    const hexes = document.getElementById('customPalette').value
      .split(',').map(s => s.trim()).filter(s => /^#[0-9a-fA-F]{3,6}$/.test(s));
    if (hexes.length > 0) {
      palette      = { name: 'Custom', colors: hexes.map(hexToRgb), hexColors: hexes };
      deviceColors = palette; // custom: no firmware remapping
    }
  }

  return {
    palette,
    deviceColors,
    ditheringType: document.getElementById('ditheringType').value,
    edMatrix:      document.getElementById('edMatrix').value,
    serpentine:    document.getElementById('serpentine').value === 'true',
    orderedW:      parseInt(document.getElementById('orderedW').value) || 4,
    orderedH:      parseInt(document.getElementById('orderedH').value) || 4,
    randomType:    document.getElementById('randomType').value,
  };
}

export function updatePaletteSwatch() {
  const key  = document.getElementById('palette').value;
  const pal  = PALETTES[key];
  const el   = document.getElementById('paletteSwatch');
  el.innerHTML = '';
  if (!pal) return;
  for (const hex of pal.hexColors) {
    const s = document.createElement('div');
    s.className = 'swatch'; s.style.background = hex; s.title = hex;
    el.appendChild(s);
  }
}

// Called once after loadPalettes() resolves. Builds the <select> options from
// the loaded palette data so the HTML doesn't need to be edited when palettes change.
export function buildPaletteSelect(paletteData) {
  const sel = document.getElementById('palette');
  sel.innerHTML = '';
  for (const p of paletteData) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === 'spectra6') opt.selected = true;
    sel.appendChild(opt);
  }
  // Always keep Custom as the last option
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = 'Custom…';
  sel.appendChild(custom);
}

export function initSidebar() {
  buildPresetDropdown();

  const presetBtn      = document.getElementById('presetBtn');
  const presetDropdown = document.getElementById('presetDropdown');
  presetBtn.addEventListener('click', e => {
    e.stopPropagation();
    presetDropdown.classList.toggle('hidden');
  });
  document.addEventListener('click', () => presetDropdown.classList.add('hidden'));

  document.getElementById('resW').addEventListener('input', syncAspectFromResolution);
  document.getElementById('resH').addEventListener('input', syncAspectFromResolution);

  document.getElementById('palette').addEventListener('change', e => {
    document.getElementById('customPaletteWrap').classList.toggle('hidden', e.target.value !== 'custom');
    updatePaletteSwatch();
  });

  document.getElementById('ditheringType').addEventListener('change', e => {
    const v = e.target.value;
    document.getElementById('edSection').classList.toggle('hidden',      v !== 'errorDiffusion');
    document.getElementById('orderedSection').classList.toggle('hidden', v !== 'ordered');
    document.getElementById('randomSection').classList.toggle('hidden',  v !== 'random');
  });

  document.getElementById('togglePalette').addEventListener('click', () => {
    setActivePanel(activePanel === 'palette' ? null : 'palette');
  });
  document.getElementById('toggleDithering').addEventListener('click', () => {
    setActivePanel(activePanel === 'dithering' ? null : 'dithering');
  });

  updatePaletteSwatch();
  syncAspectFromResolution();
}

function buildPresetDropdown() {
  const dropdown = document.getElementById('presetDropdown');
  dropdown.innerHTML = '';
  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'preset-option';
    btn.textContent = `${p.label}  ·  ${p.w}×${p.h}`;
    btn.addEventListener('click', () => applyPreset(p.w, p.h));
    dropdown.appendChild(btn);
  }
  const customBtn = document.createElement('button');
  customBtn.className = 'preset-option';
  customBtn.textContent = 'Custom…';
  customBtn.addEventListener('click', () => {
    document.getElementById('resW').focus();
    document.getElementById('presetDropdown').classList.add('hidden');
  });
  dropdown.appendChild(customBtn);
}

function applyPreset(w, h) {
  document.getElementById('resW').value = w;
  document.getElementById('resH').value = h;
  document.getElementById('presetDropdown').classList.add('hidden');
  state.resolution = { w, h };
  state.aspectRatio = w / h;
  syncAspectFromResolution();
}

function syncAspectFromResolution() {
  const w = parseFloat(document.getElementById('resW').value);
  const h = parseFloat(document.getElementById('resH').value);
  if (!w || !h || w <= 0 || h <= 0) return;
  state.resolution = { w: Math.round(w), h: Math.round(h) };
  state.aspectRatio = w / h;
  const d = gcd(Math.round(w), Math.round(h));
  document.getElementById('aspW').value = Math.round(w / d);
  document.getElementById('aspH').value = Math.round(h / d);
}

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

function setActivePanel(panel) {
  activePanel = panel;
  document.getElementById('togglePalette').classList.toggle('active',   panel === 'palette');
  document.getElementById('toggleDithering').classList.toggle('active', panel === 'dithering');
  document.getElementById('palettePanel').classList.toggle('hidden',    panel !== 'palette');
  document.getElementById('ditheringPanel').classList.toggle('hidden',  panel !== 'dithering');
}

function hexToRgb(hex) {
  const full = hex.length === 4
    ? '#' + hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3]
    : hex;
  return [parseInt(full.slice(1,3),16), parseInt(full.slice(3,5),16), parseInt(full.slice(5,7),16)];
}
