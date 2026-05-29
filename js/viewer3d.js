import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { state, getSelected } from './state.js';
import { ensureProcessed, getCroppedCanvas } from './export.js';

// ─── ENVIRONMENT PRESETS ──────────────────────────────────────
// Background colour only — scene is lit entirely by IBL.
const ENV_PRESETS = {
  livingRoom: { bg: 0x6a6258 },
  gallery:    { bg: 0x9a9690 },
  outdoor:    { bg: 0x5888a8 },
  night:      { bg: 0x08080f },
};

// ─── MODULE STATE ─────────────────────────────────────────────
let renderer, scene, camera, controls;
let frameGroup, displayMesh, glassMesh, matMesh, wallMesh;
let displayTexture;
let rawDisplayCanvas = null;   // unmodified canvas; kept so adj changes can re-apply
let animating = false;
let currentEnv = 'livingRoom';
let pmremGenerator = null;

// Display adjustments — applied at canvas level before uploading as texture.
// Values calibrated against a real Spectra 6 display in indoor lighting.
const adj = {
  exposure:    0.89,
  contrast:    0.91,
  saturation:  1.00,
  temperature: 2,
  tint:        0,
  shadows:     0,
  midtones:    0,
  highlights:  0,
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
  applyEnvPreset('livingRoom');

  animating = true;
  animate();
}

// ─── SCENE GEOMETRY ──────────────────────────────────────────
function buildScene() {
  const asp    = state.aspectRatio;
  const W      = 1.0;
  const H      = W / asp;
  const border = 0.075;
  const depth  = 0.038;
  const mat    = 0.052;

  // Frame — white/cream painted wood
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0xf0ece4,
    roughness: 0.72,
    metalness: 0.0,
    envMapIntensity: 0.6,
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
  addBar(totalW, border, 0,                      innerH / 2 + border / 2);
  addBar(totalW, border, 0,                     -innerH / 2 - border / 2);
  addBar(border, innerH, -innerW / 2 - border / 2, 0);
  addBar(border, innerH,  innerW / 2 + border / 2, 0);

  const backMat = new THREE.MeshStandardMaterial({
    color: 0xd8d0c4, roughness: 0.9, metalness: 0.0,
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
  matMesh.position.z = depth / 2 - 0.003;
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
  displayMesh.position.z = depth / 2 - 0.001;
  scene.add(displayMesh);

  // Glass
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transmission: 0.90,
    roughness: 0.04,
    metalness: 0.0,
    thickness: 0.003,
    envMapIntensity: 2.0,
    transparent: true,
    opacity: 0.12,
    side: THREE.FrontSide,
  });
  glassMesh = new THREE.Mesh(new THREE.PlaneGeometry(W, H), glassMat);
  glassMesh.position.z = depth / 2 + 0.004;
  scene.add(glassMesh);

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

    // Exposure — scale all channels (includes IBL room brightness)
    r *= effectiveExposure; g *= effectiveExposure; b *= effectiveExposure;

    // White balance — temperature shifts red/blue, tint shifts green
    r += temperature; b -= temperature; g += tint;

    // Saturation — lerp towards luminance
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lum + saturation * (r - lum);
    g = lum + saturation * (g - lum);
    b = lum + saturation * (b - lum);

    // Contrast — pivot at 128
    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;

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

    px[i]     = Math.max(0, Math.min(255, r));
    px[i + 1] = Math.max(0, Math.min(255, g));
    px[i + 2] = Math.max(0, Math.min(255, b));
  }

  ctx.putImageData(id, 0, 0);
  return c;
}

// ─── IBL FROM FILE ────────────────────────────────────────────
export async function loadIBLFromFile(file) {
  const url = URL.createObjectURL(file);
  const ext = file.name.split('.').pop().toLowerCase();
  let texture;

  try {
    if (ext === 'hdr') {
      const loader = new RGBELoader();
      texture = await loader.loadAsync(url);
    } else {
      // Equirectangular JPEG / PNG
      const loader = new THREE.TextureLoader();
      texture = await loader.loadAsync(url);
      texture.colorSpace = THREE.SRGBColorSpace;
    }
    texture.mapping = THREE.EquirectangularReflectionMapping;

    // Replace environment map
    const envTexture = pmremGenerator.fromEquirectangular(texture).texture;
    scene.environment = envTexture;
    scene.background = texture;
    texture.dispose();

    // Update filename label
    const label = document.getElementById('iblFileName');
    if (label) label.textContent = file.name;
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

// ─── ENVIRONMENT PRESET ───────────────────────────────────────
export function applyEnvPreset(name) {
  currentEnv = name;
  const p = ENV_PRESETS[name] || ENV_PRESETS.livingRoom;
  scene.background = new THREE.Color(p.bg);

  document.querySelectorAll('.env-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.env === name);
  });
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
  for (const obj of [frameGroup, displayMesh, glassMesh, matMesh, wallMesh]) {
    if (obj) scene.remove(obj);
  }
  buildScene();
  const item = getSelected();
  if (item?.ditheredCanvas) updateDisplayTexture(item.ditheredCanvas);
}

// ─── GLASS TOGGLE ─────────────────────────────────────────────
export function setGlassVisible(visible) {
  if (glassMesh) glassMesh.visible = visible;
}

// ─── RENDER LOOP ─────────────────────────────────────────────
function animate() {
  if (!animating) return;
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

export function startAnimation() { animating = true; animate(); }
export function stopAnimation()  { animating = false; }
export function isReady()        { return !!renderer; }
