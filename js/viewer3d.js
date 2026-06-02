import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { state, getSelected } from './state.js';
import { ensureProcessed, getCroppedCanvas } from './export.js';

// ─── ENVIRONMENT PRESETS ──────────────────────────────────────
// Background colour only — scene is lit entirely by IBL.
const ENV_PRESETS = {
  livingRoom: { bg: 0x6a6258 },
  gallery: { bg: 0x9a9690 },
  outdoor: { bg: 0x5888a8 },
  night: { bg: 0x08080f },
};

// ─── MODULE STATE ─────────────────────────────────────────────
let renderer, composer, gtaoPass, scene, camera, controls;
let frameGroup, displayMesh, matMesh, wallMesh;
let frameMat = null;
let currentFrameStyle = 'white';
let brushedMetalTex = null;

const FRAME_STYLES = {
  white: { color: 0xf0ece4, roughness: 0.72, metalness: 0.0, envMapIntensity: 0.6, metal: false },
  wood: { color: 0x8a6040, roughness: 0.85, metalness: 0.0, envMapIntensity: 0.5, metal: false },
  black: { color: 0x1e1e1e, roughness: 0.80, metalness: 0.0, envMapIntensity: 0.4, metal: false },
  bronze: { color: 0xBE8C58, roughness: 0.60, metalness: 0.9, envMapIntensity: 1.2, metal: true },
  silver: { color: 0xE8ECF8, roughness: 0.60, metalness: 0.9, envMapIntensity: 1.2, metal: true },
  gold: { color: 0xFFD468, roughness: 0.60, metalness: 0.9, envMapIntensity: 1.2, metal: true },
};
let displayTexture;
let rawDisplayCanvas = null;   // unmodified canvas; kept so adj changes can re-apply
let animating = false;
let currentEnv = 'livingRoom';
let pmremGenerator = null;

// Display adjustments — applied at canvas level before uploading as texture.
// Values calibrated against a real Spectra 6 display in indoor lighting.
const adj = {
  exposure: 0.89,
  contrast: .8,
  saturation: 1.5,
  temperature: 2,
  tint: 0,
  shadows: 0,
  midtones: 0,
  highlights: 0,
};

// ─── INIT ─────────────────────────────────────────────────────
export function initViewer3d(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  scene = new THREE.Scene();
  scene.environmentIntensity = 1.0;

  camera = new THREE.PerspectiveCamera(40, canvas.clientWidth / canvas.clientHeight, 0.01, 100);
  camera.position.set(0.15, 0.1, 2.2);
  camera.lookAt(0, 0, 0);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 0.4;
  controls.maxDistance = 8;
  controls.target.set(0, 0, 0);
  controls.saveState();

  // Keep PMREMGenerator alive for IBL reloads
  pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  // Default IBL: procedural RoomEnvironment
  const roomEnv = new RoomEnvironment(renderer);
  const envTexture = pmremGenerator.fromScene(roomEnv).texture;
  scene.environment = envTexture;
  roomEnv.dispose();

  buildScene();

  // Post-processing: GTAO ambient occlusion
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  gtaoPass = new GTAOPass(scene, camera, canvas.clientWidth, canvas.clientHeight);
  gtaoPass.output = GTAOPass.OUTPUT.Default;
  gtaoPass.blendIntensity = 1.0;
  gtaoPass.updateGtaoMaterial({
    radius: 0.12,
    distanceExponent: 1.0,
    thickness: 1.0,
    scale: 1.0,
    samples: 16,
    distanceFallOff: 1.0,
    screenSpaceRadius: false,
  });
  gtaoPass.updatePdMaterial({
    lumaPhi: 10.0,
    depthPhi: 2.0,
    normalPhi: 3.0,
    radius: 4.0,
    radiusExponent: 1.0,
    rings: 2.0,
    samples: 8,
  });
  composer.addPass(gtaoPass);
  composer.addPass(new OutputPass());

  // Auto-load the first IBL image (non-blocking)
  loadIBLByPath('./IBL/IBL_01.jpg');

  // Load brushed metal roughness map (non-blocking; applied once ready)
  new THREE.TextureLoader().loadAsync('./brushed_metal.jpg').then(tex => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(0.07, 0.07);
    brushedMetalTex = tex;
    if (frameMat && FRAME_STYLES[currentFrameStyle]?.metal) {
      frameMat.map = tex;
      frameMat.roughnessMap = tex;
      frameMat.needsUpdate = true;
    }
  });

  animating = true;
  animate();
}

// ─── SCENE GEOMETRY ──────────────────────────────────────────
function buildScene() {
  const asp = state.aspectRatio;
  const INCHES_PER_UNIT = 6.0;
  const diag = state.diagonal || 7.3;
  const W = (diag * asp / Math.sqrt(asp * asp + 1)) / INCHES_PER_UNIT;
  const H = W / asp;
  const border = 0.075;
  const depth = 0.082;
  const mat = 0.052;

  // Frame material — driven by currentFrameStyle
  const style = FRAME_STYLES[currentFrameStyle] || FRAME_STYLES.white;
  frameMat = new THREE.MeshStandardMaterial({
    color: style.color,
    roughness: style.roughness,
    metalness: style.metalness,
    envMapIntensity: style.envMapIntensity,
    map: style.metal && brushedMetalTex ? brushedMetalTex : null,
    roughnessMap: style.metal && brushedMetalTex ? brushedMetalTex : null,
  });

  frameGroup = new THREE.Group();
  const innerW = W + mat * 2;
  const innerH = H + mat * 2;
  const totalW = innerW + border * 2;
  const totalH = innerH + border * 2;

  const addBar = (gw, gh, px, py) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(gw, gh, depth), frameMat);
    mesh.position.set(px, py, 0);
    frameGroup.add(mesh);
  };
  addBar(totalW, border, 0, innerH / 2 + border / 2);
  addBar(totalW, border, 0, -innerH / 2 - border / 2);
  addBar(border, innerH, -innerW / 2 - border / 2, 0);
  addBar(border, innerH, innerW / 2 + border / 2, 0);

  const backMat = new THREE.MeshStandardMaterial({
    color: 0xd8d0c4, roughness: 0.9, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4,
  });
  const back = new THREE.Mesh(new THREE.BoxGeometry(totalW, totalH, 0.008), backMat);
  back.position.z = -depth / 2 + 0.004;
  frameGroup.add(back);
  scene.add(frameGroup);

  // White mat board
  const matMaterial = new THREE.MeshStandardMaterial({
    color: 0xf8f6f2, roughness: 0.98, metalness: 0.0, envMapIntensity: 0.2,
  });
  matMesh = new THREE.Mesh(new THREE.PlaneGeometry(innerW, innerH), matMaterial);
  matMesh.position.z = depth / 2 - 0.016;
  scene.add(matMesh);

  // E-ink display — MeshBasicMaterial renders the calibrated palette colours
  // exactly as measured, with no IBL or lighting math applied on top.
  // toneMapped:false bypasses the tone mapping curve so no further colour shift occurs.
  displayTexture = new THREE.CanvasTexture(makePlaceholder(state.resolution.w, state.resolution.h));
  displayTexture.colorSpace = THREE.SRGBColorSpace;
  const displayMat = new THREE.MeshBasicMaterial({
    map: displayTexture,
    toneMapped: false,
  });
  displayMesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), displayMat);
  displayMesh.position.z = depth / 2 - 0.013;
  scene.add(displayMesh);

  // Wall/surface behind frame
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xb8b4ac, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.4,
  });
  wallMesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 6), wallMat);
  wallMesh.position.z = -depth / 2 - 0.04;
  scene.add(wallMesh);
}

function makePlaceholder(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e8e4dc';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.font = `${Math.round(h * 0.07)}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('No image', w / 2, h / 2);
  return c;
}

// ─── TEXTURE UPDATE ───────────────────────────────────────────
export function updateDisplayTexture(canvas) {
  if (!displayTexture || !canvas) return;
  rawDisplayCanvas = canvas;
  displayTexture.image = applyDisplayAdjustments(canvas);
  displayTexture.needsUpdate = true;
}

// Re-apply adjustments without needing a new source canvas
function refreshDisplayTexture() {
  if (!displayTexture || !rawDisplayCanvas) return;
  displayTexture.image = applyDisplayAdjustments(rawDisplayCanvas);
  displayTexture.needsUpdate = true;
}

export function setDisplayAdjustment(key, value) {
  if (!(key in adj)) return;
  adj[key] = value;
  refreshDisplayTexture();
}

// ─── DISPLAY ADJUSTMENT PIPELINE ─────────────────────────────
// Runs on the CPU at canvas resolution. Fast enough for interactive sliders
// at 800×480 (~384k pixels). All ops in linear-ish 0–255 space.
function applyDisplayAdjustments(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);

  const id = ctx.getImageData(0, 0, c.width, c.height);
  const px = id.data;
  const { contrast, saturation, temperature, tint, shadows, midtones, highlights } = adj;
  // IBL intensity dims/brightens the display the same way it affects the room
  const iblIntensity = scene ? scene.environmentIntensity : 1.0;
  const effectiveExposure = adj.exposure * iblIntensity;

  for (let i = 0; i < px.length; i += 4) {
    let r = px[i], g = px[i + 1], b = px[i + 2];

    // 1. White balance — colour profile, applied before lighting
    r += temperature; b -= temperature; g += tint;

    // 2. Saturation — lerp towards luminance
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lum + saturation * (r - lum);
    g = lum + saturation * (g - lum);
    b = lum + saturation * (b - lum);

    // 3. Contrast — pivot at 128
    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;

    // 4. Exposure × IBL — lighting scale applied last so IBL=0 → black
    r *= effectiveExposure; g *= effectiveExposure; b *= effectiveExposure;

    // Shadows / midtones / highlights — smooth zone weights that sum to ~1
    // w_s peaks at 0, w_m peaks at 128, w_h peaks at 255
    const applyTones = (v) => {
      const n = v / 255;
      const ws = (1 - n) * (1 - n);          // shadow weight
      const wh = n * n;                        // highlight weight
      const wm = 4 * n * (1 - n);             // midtone weight (peaks at 0.5)
      return v + shadows * ws + midtones * wm + highlights * wh;
    };
    r = applyTones(r);
    g = applyTones(g);
    b = applyTones(b);

    px[i] = Math.max(0, Math.min(255, r));
    px[i + 1] = Math.max(0, Math.min(255, g));
    px[i + 2] = Math.max(0, Math.min(255, b));
  }

  ctx.putImageData(id, 0, 0);
  return c;
}

// ─── IBL FROM FILE PATH ───────────────────────────────────────
export async function loadIBLByPath(path) {
  try {
    const loader = new THREE.TextureLoader();
    const texture = await loader.loadAsync(path);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.mapping = THREE.EquirectangularReflectionMapping;
    const envTexture = pmremGenerator.fromEquirectangular(texture).texture;
    scene.environment = envTexture;
    scene.background = texture;
  } catch (err) {
    console.error('IBL load failed:', path, err);
  }
}

// ─── IBL FROM FILE (user-picked file, kept for future use) ────
export async function loadIBLFromFile(file) {
  const url = URL.createObjectURL(file);
  const ext = file.name.split('.').pop().toLowerCase();
  try {
    let texture;
    if (ext === 'hdr') {
      const loader = new RGBELoader();
      texture = await loader.loadAsync(url);
    } else {
      const loader = new THREE.TextureLoader();
      texture = await loader.loadAsync(url);
      texture.colorSpace = THREE.SRGBColorSpace;
    }
    texture.mapping = THREE.EquirectangularReflectionMapping;
    const envTexture = pmremGenerator.fromEquirectangular(texture).texture;
    scene.environment = envTexture;
    scene.background = texture;
    texture.dispose();
  } catch (err) {
    console.error('IBL load failed:', err);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─── IBL INTENSITY ────────────────────────────────────────────
export function setIBLIntensity(value) {
  if (scene) scene.environmentIntensity = value;
  const label = document.getElementById('iblLabel');
  if (label) label.textContent = `${value.toFixed(1)}×`;
  // Also re-render the display so it brightens/darkens with the room
  refreshDisplayTexture();
}


// ─── CAMERA CONTROLS ─────────────────────────────────────────
export function resetCamera() { controls.reset(); }

export function toggleZoom() {
  controls.enableZoom = !controls.enableZoom;
  document.getElementById('btnZoom')?.classList.toggle('active', controls.enableZoom);
}

export function toggleOrbit() {
  controls.enableRotate = !controls.enableRotate;
  document.getElementById('btnOrbit')?.classList.toggle('active', controls.enableRotate);
}

// ─── RESIZE ───────────────────────────────────────────────────
export function resizeViewer(width, height) {
  if (!renderer) return;
  renderer.setSize(width, height, false);
  if (composer) composer.setSize(width, height);
  if (gtaoPass) gtaoPass.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

// ─── TAB SWITCH ───────────────────────────────────────────────
export async function onEnter3dView() {
  const area = document.getElementById('viewArea');
  resizeViewer(area.clientWidth, area.clientHeight);

  const item = getSelected();
  if (!item) return;

  // Show calibrated (dithered) canvas — this is what the display physically looks like.
  // deviceCanvas holds pure RGB for firmware export and is intentionally not shown here.
  if (item.sourceCanvas && !item.ditheredCanvas) {
    updateDisplayTexture(getCroppedCanvas(item));
  } else if (item.ditheredCanvas) {
    updateDisplayTexture(item.ditheredCanvas);
  }

  if (item.status !== 'done' && item.status !== 'processing') {
    await ensureProcessed(item);
    if (item.ditheredCanvas) updateDisplayTexture(item.ditheredCanvas);
  }
}

// ─── FRAME REBUILD ────────────────────────────────────────────
export function rebuildFrame() {
  if (!scene) return;
  for (const obj of [frameGroup, displayMesh, matMesh, wallMesh]) {
    if (obj) scene.remove(obj);
  }
  buildScene();
  const item = getSelected();
  if (item?.ditheredCanvas) updateDisplayTexture(item.ditheredCanvas);
}

// ─── FRAME STYLE ──────────────────────────────────────────────
export function setFrameStyle(style) {
  currentFrameStyle = style;
  if (!frameMat) return;
  const s = FRAME_STYLES[style] || FRAME_STYLES.white;
  frameMat.color.setHex(s.color);
  frameMat.roughness = s.roughness;
  frameMat.metalness = s.metalness;
  frameMat.envMapIntensity = s.envMapIntensity;
  frameMat.map = s.metal && brushedMetalTex ? brushedMetalTex : null;
  frameMat.roughnessMap = s.metal && brushedMetalTex ? brushedMetalTex : null;
  frameMat.needsUpdate = true;
}

// ─── RENDER LOOP ─────────────────────────────────────────────
function animate() {
  if (!animating) return;
  requestAnimationFrame(animate);
  controls.update();
  composer.render();
}

export function startAnimation() { animating = true; animate(); }
export function stopAnimation() { animating = false; }
export function isReady() { return !!renderer; }
