// ─── COLOR SPACE UTILITIES ───────────────────────────────────────────────────

function sRGBToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSRGB(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function rec709Lum(lr, lg, lb) {
  return 0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if      (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;
  return { h: h / 6 * 360, s, l };
}

function hslToRgb(h, s, l) {
  h /= 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h)       * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1/6) return p + (q - p) * 6 * t;
  if (t < 1/2) return q;
  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
  return p;
}

// ─── PROCESSING FUNCTIONS ────────────────────────────────────────────────────

export function compressDynamicRange(imageData, blackRgb, whiteRgb) {
  const black_Y = rec709Lum(
    sRGBToLinear(blackRgb[0] / 255),
    sRGBToLinear(blackRgb[1] / 255),
    sRGBToLinear(blackRgb[2] / 255),
  );
  const white_Y = rec709Lum(
    sRGBToLinear(whiteRgb[0] / 255),
    sRGBToLinear(whiteRgb[1] / 255),
    sRGBToLinear(whiteRgb[2] / 255),
  );
  const range = white_Y - black_Y;

  const src = imageData.data;
  const out = new ImageData(imageData.width, imageData.height);
  const dst = out.data;

  for (let i = 0; i < src.length; i += 4) {
    const lr = sRGBToLinear(src[i]     / 255);
    const lg = sRGBToLinear(src[i + 1] / 255);
    const lb = sRGBToLinear(src[i + 2] / 255);
    const Y  = rec709Lum(lr, lg, lb);

    if (Y < 1e-8) {
      dst[i] = dst[i + 1] = dst[i + 2] = 0;
    } else {
      // Map Y linearly from [0,1] → [black_Y, white_Y], then scale channels to match
      const targetY = black_Y + Y * range;
      const scale   = targetY / Y;
      dst[i]     = Math.round(linearToSRGB(Math.min(1, lr * scale)) * 255);
      dst[i + 1] = Math.round(linearToSRGB(Math.min(1, lg * scale)) * 255);
      dst[i + 2] = Math.round(linearToSRGB(Math.min(1, lb * scale)) * 255);
    }
    dst[i + 3] = src[i + 3];
  }
  return out;
}

export function applyToneMapping(imageData, opts) {
  const { toneMode, contrast, strength, shadowBoost, highlightCompress, midpoint } = opts;
  const src = imageData.data;
  const out = new ImageData(imageData.width, imageData.height);
  const dst = out.data;

  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = src[i + c];
      let result;
      if (toneMode === 'contrast') {
        result = Math.round((v - 128) * contrast + 128);
      } else {
        const t = v / 255;
        let curve;
        if (t < midpoint) {
          curve = t + shadowBoost * Math.pow(1 - t / midpoint, 2) * midpoint;
        } else {
          curve = midpoint + Math.pow((t - midpoint) / (1 - midpoint), highlightCompress) * (1 - midpoint);
        }
        result = Math.round((t * (1 - strength) + curve * strength) * 255);
      }
      dst[i + c] = Math.max(0, Math.min(255, result));
    }
    dst[i + 3] = src[i + 3];
  }
  return out;
}

export function applySaturation(imageData, saturation) {
  const src = imageData.data;
  const out = new ImageData(imageData.width, imageData.height);
  const dst = out.data;

  for (let i = 0; i < src.length; i += 4) {
    const { h, s, l } = rgbToHsl(src[i], src[i + 1], src[i + 2]);
    const [r, g, b]   = hslToRgb(h, Math.min(1, s * saturation), l);
    dst[i]     = r;
    dst[i + 1] = g;
    dst[i + 2] = b;
    dst[i + 3] = src[i + 3];
  }
  return out;
}

export function applyExposure(imageData, exposure) {
  const src = imageData.data;
  const out = new ImageData(imageData.width, imageData.height);
  const dst = out.data;

  for (let i = 0; i < src.length; i += 4) {
    dst[i]     = Math.min(255, Math.round(src[i]     * exposure));
    dst[i + 1] = Math.min(255, Math.round(src[i + 1] * exposure));
    dst[i + 2] = Math.min(255, Math.round(src[i + 2] * exposure));
    dst[i + 3] = src[i + 3];
  }
  return out;
}

export function applyPreprocessing(imageData, opts, blackRgb, whiteRgb) {
  let data = imageData;
  if (opts.compressDynamicRange)  data = compressDynamicRange(data, blackRgb, whiteRgb);
  if (opts.toneMode !== 'none')   data = applyToneMapping(data, opts);
  if (opts.saturation !== 1.0)    data = applySaturation(data, opts.saturation);
  if (opts.exposure !== 1.0)      data = applyExposure(data, opts.exposure);
  return data;
}
