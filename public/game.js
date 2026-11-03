'use strict';
/* Saltello: corri, scatta e salta in un mondo 3D. Three.js r128 (vendor/), nessun build. */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerpK = (rate, dt) => 1 - Math.exp(-rate * dt); // fattore di inseguimento indipendente dagli fps

// ---------- Strategie iOS: niente zoom, niente menu, niente scorrimento ----------
['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('contextmenu', (e) => e.preventDefault());
// Doppio tap rapido: su alcune versioni di iOS zooma anche con user-scalable=no
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTouchEnd < 300 && !e.target.closest('#ov-btn, #btn-restart')) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('saltello.' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('saltello.' + k, JSON.stringify(v)); } catch { /* privato */ } },
};

// ---------- Aggiornamento automatico (come Palestrina) ----------
// A ogni pubblicazione GitHub scrive la versione nel meta app-version e in version.json: se non coincidono si ricarica.
const APP_VERSION = (document.querySelector('meta[name="app-version"]') || {}).content || 'dev';
async function checkUpdate() {
  if (APP_VERSION === 'dev') return;
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const { v } = await res.json();
    if (!v || v === APP_VERSION || state === 'play') return; // mai a partita in corso
    // Se dopo la ricarica la pagina è ancora vecchia (CDN non ancora aggiornata) non si riprova subito
    const last = store.get('reloadFor');
    if (last && last.v === v && Date.now() - last.at < 120000) return;
    store.set('reloadFor', { v, at: Date.now() });
    location.reload();
  } catch { /* offline: si riprova alla prossima apertura */ }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- Audio (piccoli suoni sintetizzati, nessun file) ----------
let actx = null;
function unlockAudio() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch { actx = null; }
}
function beep(f1, f2, dur, type = 'square', vol = 0.06) {
  if (!actx) return;
  const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(f1, t); o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
}
const sfx = {
  jump: () => beep(320, 640, 0.14),
  jump2: () => beep(480, 960, 0.16),
  dash: () => beep(900, 180, 0.18, 'sawtooth', 0.04),
  gem: () => { beep(1200, 1800, 0.08, 'triangle', 0.08); setTimeout(() => beep(1800, 2400, 0.1, 'triangle', 0.07), 60); },
  land: () => beep(160, 80, 0.07, 'triangle', 0.08),
  spring: () => beep(200, 1200, 0.3, 'triangle', 0.08),
  fall: () => beep(600, 90, 0.5, 'sawtooth', 0.05),
  check: () => [660, 880, 1100].forEach((f, i) => setTimeout(() => beep(f, f, 0.12, 'triangle', 0.07), i * 90)),
  win: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, f * 1.01, 0.2, 'triangle', 0.08), i * 130)),
};

// ---------- Scena ----------
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 400);

// Cielo a gradiente + nebbia del colore dell'orizzonte
(function sky() {
  const c = document.createElement('canvas'); c.width = 2; c.height = 256;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#3d8fe0'); gr.addColorStop(0.55, '#8fd0ff'); gr.addColorStop(1, '#ffe6b8');
  g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
  scene.background = new THREE.CanvasTexture(c);
  scene.fog = new THREE.Fog(0xcde9ff, 60, 170);
})();
scene.add(new THREE.HemisphereLight(0xdff1ff, 0x5a4a30, 0.85));
const sun = new THREE.DirectionalLight(0xfff2d6, 0.75);
sun.position.set(-0.6, 1, -0.4);
scene.add(sun);

function radialTexture(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, inner); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ---------- Materiali ----------
const M = {
  grass: new THREE.MeshLambertMaterial({ color: 0x6fd14a }),
  grassDark: new THREE.MeshLambertMaterial({ color: 0x4fb03a }),
  dirt: new THREE.MeshLambertMaterial({ color: 0xa8743f }),
  stone: new THREE.MeshLambertMaterial({ color: 0xb8b3a8 }),
  stoneTop: new THREE.MeshLambertMaterial({ color: 0xd9d4c7 }),
  crate: new THREE.MeshLambertMaterial({ color: 0xd08a3a }),
  crateEdge: new THREE.MeshLambertMaterial({ color: 0x8a5420 }),
  wood: new THREE.MeshLambertMaterial({ color: 0x7a4a22 }),
  plank: new THREE.MeshLambertMaterial({ color: 0xc89058 }),
  moving: new THREE.MeshLambertMaterial({ color: 0x5ec8ff }),
  movingTop: new THREE.MeshLambertMaterial({ color: 0xbaf0ff }),
  spring: new THREE.MeshLambertMaterial({ color: 0xff4f7a }),
  leaf: new THREE.MeshLambertMaterial({ color: 0x2f9e44 }),
  leaf2: new THREE.MeshLambertMaterial({ color: 0x48b84f }),
  trunk: new THREE.MeshLambertMaterial({ color: 0x7b5232 }),
  water: new THREE.MeshLambertMaterial({ color: 0x2aa6e0, transparent: true, opacity: 0.88 }),
  sand: new THREE.MeshLambertMaterial({ color: 0xf1d79a }),
  cloud: new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x666666 }),
  mountain: new THREE.MeshLambertMaterial({ color: 0x7aa3c7 }),
  snow: new THREE.MeshLambertMaterial({ color: 0xf4f8ff }),
  gem: new THREE.MeshLambertMaterial({ color: 0x4fd6ff, emissive: 0x1a6aa0 }),
  flagOff: new THREE.MeshLambertMaterial({ color: 0xbbbbbb }),
  flagOn: new THREE.MeshLambertMaterial({ color: 0xffc83a, emissive: 0x664400 }),
  pole: new THREE.MeshLambertMaterial({ color: 0xeeeeee }),
  arch: new THREE.MeshLambertMaterial({ color: 0xff7a3a }),
  checker: null,
};
{ // Striscione a scacchi del traguardo
  const c = document.createElement('canvas'); c.width = 64; c.height = 16;
  const g = c.getContext('2d');
  for (let i = 0; i < 16; i++) for (let j = 0; j < 4; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#fff'; g.fillRect(i * 4, j * 4, 4, 4); }
  const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter;
  M.checker = new THREE.MeshLambertMaterial({ map: t });
}
const boxGeo = new THREE.BoxGeometry(1, 1, 1);

// ---------- Livello ----------
// Un solido è un parallelepipedo: { minX,maxX,minY,maxY,minZ,maxZ, mesh, kind, move? }
const solids = [];
const gems = [];
const checkpoints = [];
const movers = [];
let finishZ = 0;

function solid(x, z, w, d, top, h, mats, kind = 'ground') {
  const mesh = new THREE.Mesh(boxGeo, mats);
  mesh.scale.set(w, h, d);
  mesh.position.set(x, top - h / 2, z);
  scene.add(mesh);
  const s = { minX: x - w / 2, maxX: x + w / 2, minY: top - h, maxY: top, minZ: z - d / 2, maxZ: z + d / 2, mesh, kind, w, h, d };
  solids.push(s);
  return s;
}
// Facce del cubo: +x, -x, +y, -y, +z, -z
const grassBox = [M.dirt, M.dirt, M.grass, M.dirt, M.dirt, M.dirt];
const stoneBox = [M.stone, M.stone, M.stoneTop, M.stone, M.stone, M.stone];
const movingBox = [M.moving, M.moving, M.movingTop, M.moving, M.moving, M.moving];
const plankBox = [M.wood, M.wood, M.plank, M.wood, M.wood, M.wood];

function ground(x, z, w, d, top, h = 3) {
  const s = solid(x, z, w, d, top, h, grassBox);
  // Bordo d'erba più scuro, per leggere meglio i margini
  const rim = new THREE.Mesh(boxGeo, M.grassDark);
  rim.scale.set(w + 0.12, 0.25, d + 0.12); rim.position.set(x, top - 0.12, z);
  scene.add(rim);
  return s;
}
function stone(x, z, w, d, top, h = 1.2) { return solid(x, z, w, d, top, h, stoneBox); }
function crate(x, z, top, size = 1) {
  const s = solid(x, z, size, size, top + size, size, M.crate, 'crate');
  const e = new THREE.Mesh(boxGeo, M.crateEdge);
  e.scale.set(size * 1.02, size * 0.18, size * 1.02); e.position.set(x, top + size / 2, z);
  scene.add(e);
  const e2 = e.clone(); e2.scale.set(size * 0.18, size * 1.02, size * 1.02); scene.add(e2);
  return s;
}
function mover(x, z, w, d, top, ax, amp, speed, phase = 0) {
  const s = solid(x, z, w, d, top, 0.6, movingBox, 'moving');
  s.move = { x0: x, y0: top, z0: z, ax, amp, speed, phase, dx: 0, dy: 0, dz: 0 };
  movers.push(s);
  return s;
}
function spring(x, z, top) {
  // Bassa (sotto l'altezza di un gradino): ci si sale correndo, senza saltare
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.85, 0.2, 16), M.wood);
  base.position.set(x, top + 0.1, z); scene.add(base);
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.12, 16), M.spring);
  pad.position.set(x, top + 0.25, z); scene.add(pad);
  const s = { minX: x - 0.8, maxX: x + 0.8, minY: top, maxY: top + 0.3, minZ: z - 0.8, maxZ: z + 0.8, mesh: pad, kind: 'spring', squash: 0 };
  solids.push(s);
  return s;
}
const gemGeo = new THREE.OctahedronGeometry(0.32, 0);
function gem(x, y, z) {
  const m = new THREE.Mesh(gemGeo, M.gem);
  m.scale.y = 1.35; m.position.set(x, y, z); scene.add(m);
  gems.push({ mesh: m, x, y, z, taken: false, t: Math.random() * 6 });
}
function gemLine(x1, z1, x2, z2, y, n) {
  for (let i = 0; i < n; i++) { const k = n === 1 ? 0 : i / (n - 1); gem(x1 + (x2 - x1) * k, y, z1 + (z2 - z1) * k); }
}
function checkpoint(x, z, top) {
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 8), M.pole);
  pole.position.set(x, top + 1.2, z); scene.add(pole);
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.05), M.flagOff);
  flag.position.set(x + 0.48, top + 2.1, z); scene.add(flag);
  checkpoints.push({ x: 0, y: top, z, flag, on: false, flagX: x });
}
function tree(x, z, top, s = 1) {
  const t = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * s, 0.25 * s, 1.4 * s, 6), M.trunk);
  t.position.set(x, top + 0.7 * s, z); scene.add(t);
  const l1 = new THREE.Mesh(new THREE.ConeGeometry(1.1 * s, 1.8 * s, 7), M.leaf);
  l1.position.set(x, top + 2.0 * s, z); scene.add(l1);
  const l2 = new THREE.Mesh(new THREE.ConeGeometry(0.8 * s, 1.4 * s, 7), M.leaf2);
  l2.position.set(x, top + 2.8 * s, z); scene.add(l2);
}
function island(x, z, r, top) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.15, top + 4, 10), M.sand);
  m.position.set(x, (top - 4) / 2, z); scene.add(m);
  const g = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r * 0.9, 0.3, 10), M.grass);
  g.position.set(x, top + 0.1, z); scene.add(g);
  tree(x, z, top + 0.2, 1 + (r % 1));
}
function cloud(x, y, z, s) {
  const g = new THREE.Group();
  [[0, 0, 0, 1.6], [1.5, -0.2, 0.2, 1.2], [-1.5, -0.3, 0, 1.1], [0.6, 0.6, -0.2, 1.1]].forEach(([a, b, c, r]) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), M.cloud); m.position.set(a, b, c); g.add(m);
  });
  g.position.set(x, y, z); g.scale.setScalar(s); scene.add(g);
  return g;
}
function mountain(x, z, h, r) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), M.mountain);
  m.position.set(x, h / 2 - 4, z); scene.add(m);
  const s = new THREE.Mesh(new THREE.ConeGeometry(r * 0.32, h * 0.32, 7), M.snow);
  s.position.set(x, h - 4 - h * 0.16 + 0.02, z); scene.add(s);
}

const START = { x: 0, y: 0, z: 0 };
const clouds = [];

function buildLevel() {
  // Acqua tutto intorno: cadere qui riporta all'ultima bandierina
  const water = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), M.water);
  water.rotation.x = -Math.PI / 2; water.position.set(0, -2.5, 100); scene.add(water);

  // 1. Prato di partenza
  ground(0, 10, 8, 28, 0);
  gemLine(0, 5, 0, 9, 1, 3); gemLine(-1.5, 12, 1.5, 18, 1, 4);
  tree(-3.2, -2, 0); tree(3.3, 2, 0, 1.2); tree(-3.3, 8, 0, 0.9); tree(3.2, 16, 0);
  checkpoint(-3, 0.5, 0); checkpoints[0].on = true; checkpoints[0].flag.material = M.flagOn;

  // 2. Primo salto + casse
  ground(0, 36, 7, 16, 0);
  gemLine(0, 25, 0, 27, 1.8, 2);
  crate(-1, 34, 0); crate(1.5, 37, 0); crate(1.5, 37, 1); crate(-1.5, 41, 0);
  gem(-1, 1.8, 34); gem(1.5, 2.8, 37); gem(-1.5, 1.8, 41);
  tree(3, 30, 0, 0.8); tree(-3, 43, 0, 1.1);

  // 3. Scalinata
  ground(0, 47, 6, 6, 1.0); ground(0, 53, 6, 6, 2.0); ground(0, 60, 6, 8, 3.0);
  gem(0, 2, 47); gem(0, 3, 53); gem(0, 4, 59);
  checkpoint(-2.2, 61, 3);

  // 4. Pietre sospese
  stone(-2, 69, 2.6, 2.6, 3); stone(2, 74, 2.6, 2.6, 3.5); stone(-1.5, 79, 2.6, 2.6, 4);
  gem(-2, 4.2, 69); gem(2, 4.7, 74); gem(-1.5, 5.2, 79);

  // 5. Pianoro e piattaforme mobili
  ground(0, 90, 7, 16, 4);
  gemLine(-2, 85, 2, 95, 5, 5);
  tree(-2.8, 87, 4, 0.9); tree(2.8, 96, 4, 0.8);
  mover(0, 103, 3, 3, 4, 'x', 2.6, 1.4, 0);
  mover(0, 109, 3, 3, 4, 'x', 2.6, 1.4, 0.5);
  mover(0, 114.5, 3, 3, 4, 'y', 1.2, 1.6, 0);
  gem(0, 5.4, 103); gem(0, 5.4, 109); gem(0, 6.4, 114.5);

  // 6. Molla verso l'altopiano
  ground(0, 125, 8, 12, 4);
  checkpoint(-3, 121, 4);
  spring(0, 129.5, 4);
  gemLine(0, 131, 0, 133, 9, 2);
  ground(0, 140, 6, 12, 9, 6);
  gem(-1.5, 10, 140); gem(1.5, 10, 140);

  // 7. Grande salto (doppio salto o scatto) + ponte stretto
  ground(0, 156.5, 6, 7, 8, 5);
  gemLine(0, 147.5, 0, 151.5, 10.6, 4);
  solid(0, 170.5, 1.6, 21, 8, 0.5, plankBox, 'bridge');
  gemLine(0, 162, 0, 178, 9, 6);
  checkpoint(-2.4, 156, 8);

  // 8. Arrivo
  ground(0, 190, 10, 18, 8, 5);
  tree(-4, 196, 8); tree(4, 195, 8, 1.2); tree(-4.2, 186, 8, 0.8);
  finishZ = 194;
  const archL = new THREE.Mesh(boxGeo, M.arch); archL.scale.set(0.6, 4, 0.6); archL.position.set(-3, 10, finishZ); scene.add(archL);
  const archR = archL.clone(); archR.position.x = 3; scene.add(archR);
  const banner = new THREE.Mesh(boxGeo, [M.arch, M.arch, M.arch, M.arch, M.checker, M.checker]);
  banner.scale.set(6.6, 1, 0.4); banner.position.set(0, 12.2, finishZ); scene.add(banner);

  // Scenario
  [[-14, 20, 3, 1], [13, 45, 4, 2], [-16, 75, 3.5, 1.5], [15, 100, 3, 0.5], [-13, 130, 4, 2.5], [14, 160, 3.5, 3], [-15, 185, 3, 4]]
    .forEach(([x, z, r, t]) => island(x, z, r, t));
  [[-70, 120, 50, 26], [60, 160, 60, 30], [-40, 230, 45, 22], [40, 240, 55, 28], [0, 270, 70, 34], [-80, 40, 40, 22], [85, 70, 46, 24]]
    .forEach(([x, z, h, r]) => mountain(x, z, h, r));
  for (let i = 0; i < 14; i++) clouds.push(cloud((i % 2 ? 1 : -1) * (10 + Math.random() * 30), 16 + Math.random() * 10, i * 18 + Math.random() * 8, 1 + Math.random()));
}
buildLevel();
$('gem-total').textContent = '/' + gems.length;

// ---------- Personaggio (originale: una pallina-volpe con la sciarpa) ----------
const hero = new THREE.Group();
const rig = new THREE.Group(); // ruota/schiaccia il corpo senza toccare la posizione
hero.add(rig);
const HM = {
  fur: new THREE.MeshLambertMaterial({ color: 0xff8a2a }),
  belly: new THREE.MeshLambertMaterial({ color: 0xfff0d8 }),
  dark: new THREE.MeshLambertMaterial({ color: 0x2b1a12 }),
  eye: new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x444444 }),
  scarf: new THREE.MeshLambertMaterial({ color: 0x2f7bff }),
  shoe: new THREE.MeshLambertMaterial({ color: 0xe8364a }),
};
const sph = (r, mat, x, y, z, sx = 1, sy = 1, sz = 1) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat);
  m.position.set(x, y, z); m.scale.set(sx, sy, sz); return m;
};
const body = sph(0.48, HM.fur, 0, 0.78, 0, 1, 1.05, 0.95); rig.add(body);
rig.add(sph(0.33, HM.belly, 0, 0.72, 0.22, 1, 1.05, 0.7));
const eyeL = sph(0.12, HM.eye, -0.17, 0.95, 0.38, 1, 1.25, 0.6); rig.add(eyeL);
const eyeR = sph(0.12, HM.eye, 0.17, 0.95, 0.38, 1, 1.25, 0.6); rig.add(eyeR);
rig.add(sph(0.06, HM.dark, -0.16, 0.95, 0.46, 1, 1.4, 0.6));
rig.add(sph(0.06, HM.dark, 0.16, 0.95, 0.46, 1, 1.4, 0.6));
rig.add(sph(0.05, HM.dark, 0, 0.84, 0.47));
[-1, 1].forEach((s) => {
  const ear = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.34, 8), HM.fur);
  ear.position.set(0.25 * s, 1.3, -0.02); ear.rotation.z = -0.35 * s; rig.add(ear);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.12, 8), HM.dark);
  tip.position.set(0.31 * s, 1.44, -0.02); tip.rotation.z = -0.35 * s; rig.add(tip);
});
const tail = sph(0.2, HM.fur, 0, 0.55, -0.5, 0.8, 0.8, 1.5); rig.add(tail);
rig.add(sph(0.1, HM.belly, 0, 0.6, -0.78, 1, 1, 1));
const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.08, 8, 20), HM.scarf);
scarf.rotation.x = Math.PI / 2; scarf.position.y = 0.6; rig.add(scarf);
const scarfTail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.5), HM.scarf);
scarfTail.geometry.translate(0, 0, -0.25);
scarfTail.position.set(0.15, 0.62, -0.32); rig.add(scarfTail);
const handL = sph(0.11, HM.fur, -0.5, 0.65, 0.05); rig.add(handL);
const handR = sph(0.11, HM.fur, 0.5, 0.65, 0.05); rig.add(handR);
const footL = sph(0.14, HM.shoe, -0.2, 0.13, 0, 1, 0.75, 1.4); hero.add(footL);
const footR = sph(0.14, HM.shoe, 0.2, 0.13, 0, 1, 0.75, 1.4); hero.add(footR);
// Il corpo ruota attorno al suo centro (capriola del doppio salto), non attorno ai piedi
const RIG_Y = 0.75;
rig.children.forEach((c) => { c.position.y -= RIG_Y; });
rig.position.y = RIG_Y;
scene.add(hero);

// Ombra a disco sotto il personaggio (aiuta a capire dove si atterra)
const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
  map: radialTexture('rgba(0,0,0,0.55)', 'rgba(0,0,0,0)'), transparent: true, depthWrite: false,
}));
shadow.rotation.x = -Math.PI / 2; scene.add(shadow);

// Particelle (polvere, scatto): un piccolo pool riusato
const parts = [];
{
  const g = new THREE.BoxGeometry(0.16, 0.16, 0.16);
  const dust = new THREE.MeshLambertMaterial({ color: 0xfff4e0 });
  const spark = new THREE.MeshBasicMaterial({ color: 0x9fe3ff });
  const gold = new THREE.MeshBasicMaterial({ color: 0xffe27a });
  for (let i = 0; i < 60; i++) {
    const m = new THREE.Mesh(g, dust); m.visible = false; scene.add(m);
    parts.push({ m, life: 0, max: 1, vx: 0, vy: 0, vz: 0, mats: { dust, spark, gold } });
  }
}
let partIdx = 0;
function puff(x, y, z, n, kind = 'dust', speed = 2.5, up = 1.5) {
  for (let i = 0; i < n; i++) {
    const p = parts[partIdx++ % parts.length];
    p.m.material = p.mats[kind]; p.m.visible = true;
    p.m.position.set(x + (Math.random() - 0.5) * 0.4, y + Math.random() * 0.3, z + (Math.random() - 0.5) * 0.4);
    const a = Math.random() * Math.PI * 2;
    p.vx = Math.cos(a) * speed * (0.4 + Math.random()); p.vz = Math.sin(a) * speed * (0.4 + Math.random());
    p.vy = up * (0.5 + Math.random());
    p.life = p.max = 0.35 + Math.random() * 0.3;
  }
}

// ---------- Fisica del giocatore ----------
const P = {
  RADIUS: 0.42, HEIGHT: 1.45, STEP: 0.32,
  RUN: 8.2, ACC_GROUND: 60, ACC_AIR: 28, GRAV: 30, MAX_FALL: 30,
  JUMP: 11.2, JUMP2: 9.8, SPRING: 19,
  DASH_SPEED: 23, DASH_TIME: 0.17, DASH_CD: 0.9,
  COYOTE: 0.1, BUFFER: 0.13,
};
const pl = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, face: 0,
  grounded: true, ground: null, coyote: 0, jumps: 0, airDash: true,
  dash: 0, dashCd: 0, dashX: 0, dashZ: 1, jumpBuf: 0, jumpHeld: false, cut: false,
  squash: 0, flip: 0, runPhase: 0, lastGroundY: 0, cp: 0,
};
function respawn() {
  const c = checkpoints[pl.cp];
  Object.assign(pl, { x: c.flagX + 2.4 * (c.flagX < 0 ? 1 : -1), y: c.y + 0.01, z: c.z, vx: 0, vy: 0, vz: 0, face: 0, dash: 0, jumps: 0, grounded: true, ground: null, lastGroundY: c.y });
  if (pl.cp === 0) Object.assign(pl, { x: START.x, z: START.z });
  camSnap = true;
}

function hitsXZ(px, pz, r, s) {
  const cx = clamp(px, s.minX, s.maxX), cz = clamp(pz, s.minZ, s.maxZ);
  const dx = px - cx, dz = pz - cz;
  return dx * dx + dz * dz < r * r;
}

function stepPlayer(dt) {
  // Piattaforme mobili: si portano dietro chi ci sta sopra
  for (const s of movers) {
    const m = s.move, w = m.amp * Math.sin(time * m.speed + m.phase);
    const nx = m.x0 + (m.ax === 'x' ? w : 0), ny = m.y0 + (m.ax === 'y' ? w : 0), nz = m.z0 + (m.ax === 'z' ? w : 0);
    const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2;
    m.dx = nx - cx; m.dy = ny - s.maxY; m.dz = nz - cz;
    s.minX += m.dx; s.maxX += m.dx; s.minY += m.dy; s.maxY += m.dy; s.minZ += m.dz; s.maxZ += m.dz;
    s.mesh.position.set(nx, ny - s.h / 2, nz);
    if (pl.grounded && pl.ground === s) { pl.x += m.dx; pl.y += m.dy; pl.z += m.dz; }
  }

  // Comandi -> velocità desiderata (la telecamera guarda sempre verso +z: avanti = +z, destra = -x)
  const ix = input.x, iy = input.y;
  const mag = Math.min(1, Math.hypot(ix, iy));
  const tx = -ix * P.RUN, tz = iy * P.RUN;

  pl.dashCd = Math.max(0, pl.dashCd - dt);
  if (input.dash) {
    input.dash = false;
    if (pl.dashCd <= 0 && (pl.grounded || pl.airDash)) {
      let dx = -ix, dz = iy;
      if (mag < 0.2) { dx = Math.sin(pl.face); dz = Math.cos(pl.face); }
      const l = Math.hypot(dx, dz) || 1;
      pl.dashX = dx / l; pl.dashZ = dz / l; pl.dash = P.DASH_TIME; pl.dashCd = P.DASH_CD;
      if (!pl.grounded) pl.airDash = false;
      pl.vy = Math.max(pl.vy, 0);
      pl.face = Math.atan2(pl.dashX, pl.dashZ);
      puff(pl.x, pl.y + 0.3, pl.z, 10, 'spark', 3, 0.8);
      sfx.dash(); haptic();
    }
  }

  if (pl.dash > 0) {
    pl.dash -= dt;
    pl.vx = pl.dashX * P.DASH_SPEED; pl.vz = pl.dashZ * P.DASH_SPEED; pl.vy = 0;
    if (pl.dash <= 0) { pl.vx *= 0.42; pl.vz *= 0.42; }
    if (Math.random() < 0.7) puff(pl.x, pl.y + 0.5, pl.z, 1, 'spark', 0.5, 0.3);
  } else {
    const acc = (pl.grounded ? P.ACC_GROUND : P.ACC_AIR) * dt;
    const dvx = tx - pl.vx, dvz = tz - pl.vz, dl = Math.hypot(dvx, dvz);
    if (dl <= acc) { pl.vx = tx; pl.vz = tz; } else { pl.vx += dvx / dl * acc; pl.vz += dvz / dl * acc; }
    pl.vy = Math.max(pl.vy - P.GRAV * dt, -P.MAX_FALL);
  }

  // Salto: buffer (premuto poco prima di atterrare) + coyote time (poco dopo il bordo) + doppio salto
  pl.jumpBuf = Math.max(0, pl.jumpBuf - dt);
  pl.coyote = pl.grounded ? P.COYOTE : Math.max(0, pl.coyote - dt);
  if (pl.jumpBuf > 0) {
    if (pl.grounded || pl.coyote > 0) {
      pl.vy = P.JUMP; pl.jumps = 1; pl.grounded = false; pl.coyote = 0; pl.jumpBuf = 0; pl.cut = false; pl.dash = 0;
      pl.squash = -0.25; puff(pl.x, pl.y, pl.z, 6); sfx.jump(); haptic();
    } else if (pl.jumps < 2) {
      pl.vy = P.JUMP2; pl.jumps = 2; pl.jumpBuf = 0; pl.cut = true; pl.dash = 0; pl.flip = 1;
      puff(pl.x, pl.y, pl.z, 8, 'spark', 2, 0.2); sfx.jump2(); haptic();
    }
  }
  // Rilasciando presto il tasto il salto è più basso
  if (!pl.jumpHeld && !pl.cut && pl.vy > 0 && pl.jumps === 1) { pl.vy *= 0.5; pl.cut = true; }

  // Movimento orizzontale con collisioni contro i lati dei blocchi
  pl.x += pl.vx * dt; pl.z += pl.vz * dt;
  const r = P.RADIUS;
  for (const s of solids) {
    if (pl.y + P.HEIGHT <= s.minY || pl.y >= s.maxY - P.STEP) continue;
    if (!hitsXZ(pl.x, pl.z, r, s)) continue;
    const cx = clamp(pl.x, s.minX, s.maxX), cz = clamp(pl.z, s.minZ, s.maxZ);
    let dx = pl.x - cx, dz = pl.z - cz, d = Math.hypot(dx, dz);
    if (d < 1e-5) { // centro dentro il blocco: esce dal lato più vicino
      const o = [pl.x - s.minX, s.maxX - pl.x, pl.z - s.minZ, s.maxZ - pl.z], i = o.indexOf(Math.min(...o));
      if (i === 0) pl.x = s.minX - r; else if (i === 1) pl.x = s.maxX + r; else if (i === 2) pl.z = s.minZ - r; else pl.z = s.maxZ + r;
      continue;
    }
    dx /= d; dz /= d;
    pl.x = cx + dx * r; pl.z = cz + dz * r;
    const vn = pl.vx * dx + pl.vz * dz;
    if (vn < 0) { pl.vx -= vn * dx; pl.vz -= vn * dz; }
  }

  // Movimento verticale: atterraggio, gradini, soffitti
  const prevY = pl.y, wasGrounded = pl.grounded;
  pl.y += pl.vy * dt;
  let land = null, landY = -Infinity;
  if (pl.vy <= 0) {
    const lo = pl.y - (wasGrounded ? 0.3 : 0), hi = prevY + (wasGrounded ? P.STEP : 0.05);
    for (const s of solids) {
      if (s.maxY < lo || s.maxY > hi || s.maxY <= landY) continue;
      if (hitsXZ(pl.x, pl.z, r * 0.75, s)) { land = s; landY = s.maxY; }
    }
  } else {
    for (const s of solids) {
      if (prevY + P.HEIGHT <= s.minY + 0.05 && pl.y + P.HEIGHT > s.minY && hitsXZ(pl.x, pl.z, r * 0.75, s)) {
        pl.y = s.minY - P.HEIGHT; pl.vy = 0;
      }
    }
  }
  if (land) {
    if (!wasGrounded) {
      const impact = -pl.vy;
      if (impact > 8) { pl.squash = Math.min(0.35, impact / 60); puff(pl.x, landY, pl.z, 6); sfx.land(); }
    }
    pl.y = landY; pl.vy = 0; pl.grounded = true; pl.ground = land; pl.jumps = 0; pl.airDash = true; pl.lastGroundY = landY;
    if (land.kind === 'spring') {
      pl.vy = P.SPRING; pl.grounded = false; pl.jumps = 1; pl.cut = true; land.squash = 1; pl.flip = 1;
      puff(pl.x, landY, pl.z, 10, 'gold', 3, 2); sfx.spring(); haptic(30);
    }
  } else {
    pl.grounded = false; pl.ground = null;
  }

  // Direzione del corpo: segue il movimento
  const sp = Math.hypot(pl.vx, pl.vz);
  if (sp > 0.6 && pl.dash <= 0 && mag > 0.1) {
    const want = Math.atan2(pl.vx, pl.vz);
    let d = want - pl.face; d = Math.atan2(Math.sin(d), Math.cos(d));
    pl.face += d * lerpK(14, dt);
  }

  // Caduta in acqua
  if (pl.y < -2.2) {
    puff(pl.x, -2.4, pl.z, 14, 'spark', 3, 3); sfx.fall(); haptic(40);
    flash('Splash!'); respawn();
  }
}

// ---------- Animazione del personaggio ----------
function animateHero(dt) {
  hero.position.set(pl.x, pl.y, pl.z);
  hero.rotation.y = pl.face;
  const sp = Math.hypot(pl.vx, pl.vz);
  const k = Math.min(1, sp / P.RUN);
  if (pl.grounded) pl.runPhase += dt * (6 + sp * 1.5);
  const s = Math.sin(pl.runPhase), c = Math.cos(pl.runPhase);
  if (pl.grounded) {
    footL.position.set(-0.2, 0.13 + Math.max(0, s) * 0.22 * k, s * 0.32 * k);
    footR.position.set(0.2, 0.13 + Math.max(0, -s) * 0.22 * k, -s * 0.32 * k);
    rig.position.y = RIG_Y + Math.abs(c) * 0.08 * k;
    handL.position.z = 0.05 - s * 0.25 * k; handR.position.z = 0.05 + s * 0.25 * k;
  } else {
    footL.position.set(-0.2, 0.22, 0.12); footR.position.set(0.2, 0.18, -0.12);
    rig.position.y = RIG_Y + 0.04;
    handL.position.set(-0.52, 0.1, 0.05); handR.position.set(0.52, 0.1, 0.05);
  }
  if (pl.grounded) { handL.position.y = handR.position.y = -0.1; handL.position.x = -0.5; handR.position.x = 0.5; }
  // Inclinazione in corsa, capriola nel doppio salto, schiacciamento all'atterraggio, allungamento nello scatto
  pl.squash += (0 - pl.squash) * lerpK(12, dt);
  if (pl.flip > 0) pl.flip = Math.max(0, pl.flip - dt * 2.6);
  rig.rotation.x = (pl.dash > 0 ? 0.5 : 0.18 * k) + (1 - pl.flip) * (pl.flip > 0 ? Math.PI * 2 : 0);
  const st = pl.dash > 0 ? 0.25 : 0;
  rig.scale.set(1 + pl.squash * 0.6 - st * 0.3, 1 - pl.squash - st * 0.2, 1 + pl.squash * 0.4 + st);
  scarfTail.rotation.x = -0.2 + (pl.grounded ? 0.15 * s : 0.6) + (pl.dash > 0 ? 0.6 : 0) + k * 0.4;
  scarfTail.rotation.y = Math.sin(time * 9) * 0.25 * (0.3 + k);
  tail.rotation.y = Math.sin(time * 5 + pl.runPhase * 0.5) * 0.35;
  // Ammiccare ogni tanto
  const blink = (time % 3.4) < 0.12 ? 0.15 : 1.25;
  eyeL.scale.y = eyeR.scale.y = blink;

  // Ombra: sul blocco più alto sotto i piedi
  let gy = -2.45;
  for (const sld of solids) if (sld.maxY <= pl.y + 0.05 && sld.maxY > gy && pl.x >= sld.minX && pl.x <= sld.maxX && pl.z >= sld.minZ && pl.z <= sld.maxZ) gy = sld.maxY;
  const h = pl.y - gy, sc = clamp(1.25 - h * 0.08, 0.45, 1.25);
  shadow.position.set(pl.x, gy + 0.02, pl.z); shadow.scale.set(sc, sc, 1);
  shadow.material.opacity = clamp(1 - h * 0.08, 0.3, 1);
}

// ---------- Telecamera alle spalle (stile platform anni '90: guarda sempre in avanti) ----------
let camSnap = true;
const cam = { x: 0, y: 4, z: -8, fov: 60 };
function updateCamera(dt) {
  const portrait = innerHeight > innerWidth;
  // Quota: segue l'ultimo terreno toccato (niente sobbalzi a ogni salto), ma scende se il personaggio cade
  let refY = pl.lastGroundY;
  if (pl.y < refY - 0.5) refY = pl.y + 0.5;
  if (pl.y > refY + 3.2) refY = pl.y - 3.2;
  const dist = portrait ? 8.6 : 7.2, height = portrait ? 4.4 : 3.6;
  const tx = pl.x * 0.85, ty = refY + height, tz = pl.z - dist;
  if (camSnap) { cam.x = tx; cam.y = ty; cam.z = tz; camSnap = false; }
  cam.x += (tx - cam.x) * lerpK(5, dt);
  cam.y += (ty - cam.y) * lerpK(4, dt);
  cam.z += (tz - cam.z) * lerpK(9, dt);
  camera.position.set(cam.x, cam.y, cam.z);
  camera.lookAt(cam.x + (pl.x - cam.x) * 0.5, cam.y - height + 1.1, cam.z + dist + 4.5);
  const baseFov = portrait ? 78 : 60;
  const tf = baseFov + (pl.dash > 0 ? 9 : 0) + Math.min(1, Math.hypot(pl.vx, pl.vz) / P.RUN) * 2;
  cam.fov += (tf - cam.fov) * lerpK(8, dt);
  if (Math.abs(camera.fov - cam.fov) > 0.01) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
}

// ---------- Mondo vivo: gemme, bandierine, molle, nuvole, particelle ----------
let gemCount = 0;
function updateWorld(dt) {
  for (const g of gems) {
    if (g.taken) {
      if (g.mesh.visible) { g.mesh.scale.multiplyScalar(1 + dt * 8); g.mesh.position.y += dt * 4; if (g.mesh.scale.x > 2.2) g.mesh.visible = false; }
      continue;
    }
    g.t += dt;
    g.mesh.rotation.y = g.t * 2.2;
    g.mesh.position.y = g.y + Math.sin(g.t * 3) * 0.12;
    if (state === 'play') {
      const dx = g.x - pl.x, dy = g.y - (pl.y + 0.7), dz = g.z - pl.z;
      if (dx * dx + dy * dy + dz * dz < 1.05) {
        g.taken = true; gemCount++;
        $('gem-count').textContent = gemCount;
        const el = $('gems'); el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
        puff(g.x, g.y, g.z, 6, 'spark', 2, 1.5); sfx.gem();
      }
    }
  }
  checkpoints.forEach((c, i) => {
    if (!c.on && state === 'play' && Math.abs(pl.z - c.z) < 2.5 && Math.abs(pl.y - c.y) < 1.5) {
      c.on = true; c.flag.material = M.flagOn; pl.cp = i;
      puff(c.flagX, c.y + 2, c.z, 12, 'gold', 3, 3); sfx.check(); flash('Checkpoint!');
    }
    if (c.on) c.flag.rotation.y = Math.sin(time * 4 + i) * 0.25;
  });
  for (const s of solids) if (s.kind === 'spring') {
    s.squash = Math.max(0, (s.squash || 0) - dt * 5);
    s.mesh.scale.y = 1 + Math.sin(s.squash * Math.PI) * 2;
  }
  for (const c of clouds) { c.position.x += dt * 0.6; if (c.position.x > 45) c.position.x = -45; }
  for (const p of parts) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.m.visible = false; continue; }
    p.vy -= 9 * dt;
    p.m.position.x += p.vx * dt; p.m.position.y += p.vy * dt; p.m.position.z += p.vz * dt;
    p.m.scale.setScalar(p.life / p.max);
    p.m.rotation.x += dt * 6; p.m.rotation.y += dt * 5;
  }
  // Traguardo
  if (state === 'play' && pl.z >= finishZ && pl.y > 7) win();
  // Suggerimento prima del grande salto
  if (state === 'play' && !hinted && pl.z > 141 && pl.z < 145 && pl.y > 8.5) { hinted = true; flash('Doppio salto o scatto!'); }
}
let hinted = false;

// ---------- Comandi touch: joystick a sinistra, tasti a destra ----------
const input = { x: 0, y: 0, dash: false };
const stickEl = $('stick'), knobEl = $('stick-knob'), ringEl = $('stick-ring');
const STICK_R = 62;
let stickId = null, stickOX = 0, stickOY = 0;
function stickRest() {
  const sal = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sal')) || 0;
  const portrait = innerHeight > innerWidth;
  const sab = 0;
  stickOX = Math.max(110, 95 + sal);
  stickOY = innerHeight - (portrait ? 150 : 110) - sab;
  stickEl.style.setProperty('--px', stickOX + 'px');
  stickEl.style.setProperty('--py', stickOY + 'px');
  knobEl.style.setProperty('--kx', '0px'); knobEl.style.setProperty('--ky', '0px');
}
function stickMove(cx, cy) {
  let dx = cx - stickOX, dy = cy - stickOY;
  const d = Math.hypot(dx, dy);
  if (d > STICK_R) { dx = dx / d * STICK_R; dy = dy / d * STICK_R; }
  knobEl.style.setProperty('--kx', dx + 'px'); knobEl.style.setProperty('--ky', dy + 'px');
  const n = Math.min(1, d / STICK_R), dead = 0.12;
  const k = n < dead ? 0 : (n - dead) / (1 - dead);
  const a = Math.atan2(dy, dx);
  input.x = Math.cos(a) * k; input.y = -Math.sin(a) * k;
  ringEl.style.setProperty('--ang', (a * 180 / Math.PI + 90) + 'deg');
  ringEl.style.setProperty('--tip', k > 0.2 ? 1 : 0);
}
const zone = $('stick-zone');
zone.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (stickId !== null) return;
  stickId = e.pointerId;
  try { zone.setPointerCapture(e.pointerId); } catch { /* ok */ }
  // Come nei MOBA: il joystick si sposta dove appoggi il pollice
  stickOX = clamp(e.clientX, 85, innerWidth / 2 - 40);
  stickOY = clamp(e.clientY, 100, innerHeight - 80);
  stickEl.style.setProperty('--px', stickOX + 'px');
  stickEl.style.setProperty('--py', stickOY + 'px');
  stickEl.classList.add('on');
  stickMove(e.clientX, e.clientY);
});
zone.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) { e.preventDefault(); stickMove(e.clientX, e.clientY); } });
function stickEnd(e) {
  if (e.pointerId !== stickId) return;
  stickId = null; input.x = input.y = 0;
  stickEl.classList.remove('on'); stickRest();
}
zone.addEventListener('pointerup', stickEnd);
zone.addEventListener('pointercancel', stickEnd);
zone.addEventListener('lostpointercapture', stickEnd);

function button(el, onDown, onUp) {
  const ids = new Set();
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); ids.add(e.pointerId);
    try { el.setPointerCapture(e.pointerId); } catch { /* ok */ }
    el.classList.add('down'); onDown();
  });
  const up = (e) => {
    if (!ids.delete(e.pointerId)) return;
    if (!ids.size) { el.classList.remove('down'); onUp && onUp(); }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
button($('btn-jump'), () => { pl.jumpBuf = P.BUFFER; pl.jumpHeld = true; }, () => { pl.jumpHeld = false; });
button($('btn-dash'), () => { input.dash = true; });

// Tastiera (per provare dal computer): WASD/frecce, spazio = salto, shift/K = scatto
const keys = new Set();
function keyInput() {
  if (stickId !== null) return;
  const x = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
  const y = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
  const l = Math.hypot(x, y) || 1;
  input.x = x / l; input.y = y / l;
}
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (e.repeat) return;
  keys.add(k);
  if (k === ' ') { pl.jumpBuf = P.BUFFER; pl.jumpHeld = true; $('btn-jump').classList.add('down'); }
  if (k === 'shift' || k === 'k') { input.dash = true; $('btn-dash').classList.add('down'); }
  if (k === 'enter' && !$('overlay').hidden) $('ov-btn').click();
  keyInput();
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  keys.delete(k);
  if (k === ' ') { pl.jumpHeld = false; $('btn-jump').classList.remove('down'); }
  if (k === 'shift' || k === 'k') $('btn-dash').classList.remove('down');
  keyInput();
});

function haptic(ms = 12) { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* iOS non vibra dal web */ } }

// Indicatore di ricarica dello scatto (spicchio che si svuota, come le abilità dei MOBA)
const dashBtn = $('btn-dash'), dashCdEl = dashBtn.querySelector('.cd'), dashCdTxt = dashCdEl.querySelector('span');
let dashWasCooling = false;
function updateButtons() {
  const cooling = pl.dashCd > 0;
  if (cooling) {
    dashCdEl.style.setProperty('--p', (pl.dashCd / P.DASH_CD).toFixed(3));
    dashCdTxt.textContent = pl.dashCd > 0.3 ? pl.dashCd.toFixed(1) : '';
  }
  if (cooling !== dashWasCooling) {
    dashBtn.classList.toggle('cooling', cooling);
    if (!cooling) { dashBtn.classList.remove('ready'); void dashBtn.offsetWidth; dashBtn.classList.add('ready'); }
    dashWasCooling = cooling;
  }
}

// ---------- Messaggi e stati di gioco ----------
let flashTimer = 0;
function flash(text) {
  const b = $('banner'); b.textContent = text; b.hidden = false;
  b.style.animation = 'none'; void b.offsetWidth; b.style.animation = '';
  clearTimeout(flashTimer); flashTimer = setTimeout(() => { b.hidden = true; }, 1500);
}
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

let state = 'menu', time = 0, runTime = 0;
function showOverlay(title, html, btn) {
  $('ov-title').textContent = title; $('ov-text').innerHTML = html; $('ov-btn').textContent = btn;
  let hint = '';
  if (isIOS && !standalone) hint = 'Per giocare a tutto schermo: Condividi → "Aggiungi alla schermata Home".';
  else if (innerHeight > innerWidth) hint = 'Si gioca meglio con il telefono in orizzontale.';
  $('ov-hint').textContent = hint;
  $('overlay').hidden = false;
}
function reset() {
  gems.forEach((g) => { g.taken = false; g.mesh.visible = true; g.mesh.scale.set(1, 1.35, 1); });
  checkpoints.forEach((c, i) => { c.on = i === 0; c.flag.material = i === 0 ? M.flagOn : M.flagOff; });
  gemCount = 0; $('gem-count').textContent = '0';
  pl.cp = 0; pl.dashCd = 0; hinted = false; runTime = 0;
  respawn();
}
function start() {
  unlockAudio();
  $('overlay').hidden = true;
  state = 'play';
}
function win() {
  state = 'win';
  sfx.win(); puff(pl.x, pl.y + 1, pl.z, 30, 'gold', 5, 5);
  const best = store.get('best');
  const rec = !best || runTime < best.t;
  if (rec) store.set('best', { t: runTime, g: gemCount });
  setTimeout(() => showOverlay('Traguardo!',
    `Tempo <b>${fmt(runTime)}</b> · Gemme <b>${gemCount}/${gems.length}</b>${rec ? '<br>Nuovo record!' : `<br>Record: ${fmt(best.t)}`}`,
    'Gioca ancora'), 900);
}
$('ov-btn').addEventListener('click', () => { if (state !== 'menu') reset(); start(); });
$('btn-restart').addEventListener('click', () => { reset(); flash('Si ricomincia!'); });

// ---------- Ciclo principale ----------
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  if (stickId === null) stickRest();
}
addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 200));
resize();

let last = performance.now(), running = true;
function frame(now) {
  if (!running) return;
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  time += dt;
  if (state === 'play') {
    runTime += dt;
    $('clock').textContent = fmt(runTime);
    // Passi fissi: la fisica è uguale a 60 e a 120 Hz
    const steps = Math.ceil(dt / (1 / 120));
    for (let i = 0; i < steps; i++) stepPlayer(dt / steps);
  } else if (state === 'menu') {
    pl.face = Math.sin(time * 0.8) * 0.6; // il personaggio si guarda intorno
  }
  animateHero(dt);
  updateWorld(dt);
  updateCamera(dt);
  updateButtons();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// In pausa quando l'app va in background; al ritorno controlla gli aggiornamenti
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
    checkUpdate();
  } else {
    running = false;
    keys.clear(); input.x = input.y = 0; pl.jumpHeld = false;
  }
});

reset();
const best = store.get('best');
showOverlay('Saltello',
  'Joystick a sinistra per correre, <b>tasto grande</b> per saltare (anche doppio), <b>tasto piccolo</b> per lo scatto.<br>Raccogli le gemme e arriva al traguardo!' +
  (best ? `<br>Record: <b>${fmt(best.t)}</b>` : ''), 'Gioca');
checkUpdate();
requestAnimationFrame(frame);
