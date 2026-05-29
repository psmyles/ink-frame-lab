// Calibrated colors — what the physical display actually renders.
// Used as the dithering palette so error diffusion works against realistic colours.
// Each entry's index corresponds to the same index in DEVICE_COLORS (pure RGB for firmware export).
// Populated at startup from palettes.json via loadPalettes().
// Each entry: { name, colors (calibrated RGB arrays), hexColors, deviceColors, deviceHexColors }
export const PALETTES = {};
export const DEVICE_COLORS = {};

function hexToRgbArr(hex) {
  const h = hex.length === 4
    ? '#' + hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3]
    : hex;
  return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
}

export async function loadPalettes(url = './palettes.json') {
  const data = await fetch(url).then(r => r.json());
  for (const p of data) {
    PALETTES[p.id] = {
      name: p.name,
      colors:    p.colors.map(c => hexToRgbArr(c.color)),
      hexColors: p.colors.map(c => c.color),
    };
    DEVICE_COLORS[p.id] = {
      name: p.name,
      colors:    p.colors.map(c => hexToRgbArr(c.deviceColor)),
      hexColors: p.colors.map(c => c.deviceColor),
    };
  }
  return data;
}

export function nearestPaletteColor(r, g, b, palette) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const dr = r - palette[i][0], dg = g - palette[i][1], db = b - palette[i][2];
    const d = dr*dr + dg*dg + db*db;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

export const ED_KERNELS = (() => {
  const raw = {
    floydSteinberg:   { div: 16, w: [[1,0,7],[-1,1,3],[0,1,5],[1,1,1]] },
    atkinson:         { div: 8,  w: [[1,0,1],[2,0,1],[-1,1,1],[0,1,1],[1,1,1],[0,2,1]] },
    falseFloydSteinberg: { div: 8, w: [[1,0,3],[0,1,3],[1,1,2]] },
    jarvis:   { div: 48, w: [[1,0,7],[2,0,5],[-2,1,3],[-1,1,5],[0,1,7],[1,1,5],[2,1,3],[-2,2,1],[-1,2,3],[0,2,5],[1,2,3],[2,2,1]] },
    stucki:   { div: 42, w: [[1,0,8],[2,0,4],[-2,1,2],[-1,1,4],[0,1,8],[1,1,4],[2,1,2],[-2,2,1],[-1,2,2],[0,2,4],[1,2,2],[2,2,1]] },
    burkes:   { div: 32, w: [[1,0,8],[2,0,4],[-2,1,2],[-1,1,4],[0,1,8],[1,1,4],[2,1,2]] },
    sierra3:  { div: 32, w: [[1,0,5],[2,0,3],[-2,1,2],[-1,1,4],[0,1,5],[1,1,4],[2,1,2],[-1,2,2],[0,2,3],[1,2,2]] },
    sierra2:  { div: 16, w: [[1,0,4],[2,0,3],[-2,1,1],[-1,1,2],[0,1,3],[1,1,2],[2,1,1]] },
    sierra2_4a: { div: 4, w: [[1,0,2],[-1,1,1],[0,1,1]] },
  };
  const out = {};
  for (const k in raw) out[k] = { divisor: raw[k].div, weights: raw[k].w };
  return out;
})();

export function applyErrorDiffusion(imageData, palette, kernelName, serpentine) {
  const { width, height, data } = imageData;
  const buf = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i*3] = data[i*4]; buf[i*3+1] = data[i*4+1]; buf[i*3+2] = data[i*4+2];
  }
  const { divisor, weights } = ED_KERNELS[kernelName] || ED_KERNELS.floydSteinberg;
  for (let y = 0; y < height; y++) {
    const ltr = !serpentine || (y % 2 === 0);
    const xStart = ltr ? 0 : width-1, xEnd = ltr ? width : -1, xStep = ltr ? 1 : -1;
    for (let x = xStart; x !== xEnd; x += xStep) {
      const idx = (y * width + x) * 3;
      const or = Math.max(0, Math.min(255, buf[idx]));
      const og = Math.max(0, Math.min(255, buf[idx+1]));
      const ob = Math.max(0, Math.min(255, buf[idx+2]));
      const ni = nearestPaletteColor(or, og, ob, palette);
      const [nr, ng, nb] = palette[ni];
      buf[idx] = nr; buf[idx+1] = ng; buf[idx+2] = nb;
      const er = or-nr, eg = og-ng, eb = ob-nb;
      for (const [dx, dy, w] of weights) {
        const nx = x + (ltr ? dx : -dx), ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const j = (ny * width + nx) * 3;
        buf[j] += er*w/divisor; buf[j+1] += eg*w/divisor; buf[j+2] += eb*w/divisor;
      }
    }
  }
  const out = new ImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const ni = nearestPaletteColor(
      Math.max(0,Math.min(255,buf[i*3])),
      Math.max(0,Math.min(255,buf[i*3+1])),
      Math.max(0,Math.min(255,buf[i*3+2])),
      palette
    );
    out.data[i*4] = palette[ni][0]; out.data[i*4+1] = palette[ni][1];
    out.data[i*4+2] = palette[ni][2]; out.data[i*4+3] = 255;
  }
  return out;
}

function generateBayerMatrix(size) {
  if (size === 1) return [[0]];
  const half = generateBayerMatrix(size / 2), n = half.length, m = n * 2;
  const mat = Array.from({length: m}, () => new Array(m));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = half[y][x];
    mat[y][x] = 4*v; mat[y][x+n] = 4*v+2; mat[y+n][x] = 4*v+3; mat[y+n][x+n] = 4*v+1;
  }
  return mat;
}

export function applyOrdered(imageData, palette, mw, mh) {
  const { width, height, data } = imageData;
  const po2 = Math.pow(2, Math.ceil(Math.log2(Math.max(mw, mh, 2))));
  const bayer = generateBayerMatrix(po2), maxVal = po2 * po2;
  const out = new ImageData(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const t = (bayer[y % po2][x % po2] / maxVal - 0.5) * (255 / palette.length) * 1.5;
    const ni = nearestPaletteColor(
      Math.max(0,Math.min(255, data[i]+t)),
      Math.max(0,Math.min(255, data[i+1]+t)),
      Math.max(0,Math.min(255, data[i+2]+t)),
      palette
    );
    out.data[i] = palette[ni][0]; out.data[i+1] = palette[ni][1];
    out.data[i+2] = palette[ni][2]; out.data[i+3] = 255;
  }
  return out;
}

export function applyRandom(imageData, palette, type) {
  const { width, height, data } = imageData;
  const out = new ImageData(width, height), sc = 40;
  for (let i = 0; i < width * height; i++) {
    const pi = i * 4;
    let r = data[pi], g = data[pi+1], b = data[pi+2];
    if (type === 'rgb') {
      r = Math.max(0,Math.min(255, r + (Math.random()-.5)*sc));
      g = Math.max(0,Math.min(255, g + (Math.random()-.5)*sc));
      b = Math.max(0,Math.min(255, b + (Math.random()-.5)*sc));
    } else {
      const n = (Math.random()-.5)*sc;
      r = Math.max(0,Math.min(255,r+n));
      g = Math.max(0,Math.min(255,g+n));
      b = Math.max(0,Math.min(255,b+n));
    }
    const ni = nearestPaletteColor(r, g, b, palette);
    out.data[pi] = palette[ni][0]; out.data[pi+1] = palette[ni][1];
    out.data[pi+2] = palette[ni][2]; out.data[pi+3] = 255;
  }
  return out;
}

export function applyQuantization(imageData, palette) {
  const { width, height, data } = imageData;
  const out = new ImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const pi = i * 4;
    const ni = nearestPaletteColor(data[pi], data[pi+1], data[pi+2], palette);
    out.data[pi] = palette[ni][0]; out.data[pi+1] = palette[ni][1];
    out.data[pi+2] = palette[ni][2]; out.data[pi+3] = 255;
  }
  return out;
}

export function replaceColors(imageData, srcPalette, devPalette) {
  const { width, height } = imageData;
  const out = new ImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const pi = i * 4;
    const ni = nearestPaletteColor(imageData.data[pi], imageData.data[pi+1], imageData.data[pi+2], srcPalette);
    const di = Math.min(ni, devPalette.length - 1);
    out.data[pi] = devPalette[di][0]; out.data[pi+1] = devPalette[di][1];
    out.data[pi+2] = devPalette[di][2]; out.data[pi+3] = 255;
  }
  return out;
}

export function processImage(sourceCanvas, options) {
  const { palette, deviceColors, ditheringType, edMatrix, serpentine, orderedW, orderedH, randomType } = options;
  const ctx = sourceCanvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  let dithered;
  switch (ditheringType) {
    case 'errorDiffusion':
      dithered = applyErrorDiffusion(imageData, palette.colors, edMatrix, serpentine); break;
    case 'ordered':
      dithered = applyOrdered(imageData, palette.colors, orderedW, orderedH); break;
    case 'random':
      dithered = applyRandom(imageData, palette.colors, randomType); break;
    default:
      dithered = applyQuantization(imageData, palette.colors);
  }
  const deviceResult = replaceColors(dithered, palette.colors, deviceColors.colors);
  return { dithered, deviceResult };
}
