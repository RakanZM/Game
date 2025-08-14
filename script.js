/* script.js
   Original isometric RPG prototype (Babylon.js)
   NOTE: This is an original medieval riverside town — not Lumbridge — to avoid IP infringement.
   Everything runs locally with no external assets beyond Babylon.js CDN.
*/

/* -----------------------------
   Embedded "Assets" (Base64)
   We synthesize textures and audio at runtime, then store as Base64 data URIs.
   This keeps the project self-contained while avoiding copyrighted content.
-------------------------------- */

// Tiny helper: generate a PNG data URI by drawing to an offscreen canvas
function makeSolidPNG(color = '#4caf50', size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
  // subtle noise for tiling
  const n = Math.floor(size * size * 0.02);
  for (let i = 0; i < n; i++) {
    const x = (Math.random() * size) | 0;
    const y = (Math.random() * size) | 0;
    ctx.fillStyle = `rgba(255,255,255,${Math.random()*0.08})`;
    ctx.fillRect(x, y, 1, 1);
  }
  return c.toDataURL('image/png');
}

// Synthesize a mono PCM16 WAV as Base64 data URI (simple tones or silence)
function synthWavBase64({ durationSec = 0.5, sampleRate = 44100, frequency = 440, volume = 0.2, envelope = 'beep' } = {}) {
  const numSamples = Math.floor(durationSec * sampleRate);
  const bytesPerSample = 2;
  const blockAlign = 1 * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * bytesPerSample;

  // WAV header (RIFF)
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeStr(offset, str) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }
  function write16(offset, v) { view.setUint16(offset, v, true); }
  function write32(offset, v) { view.setUint32(offset, v, true); }

  writeStr(0, 'RIFF');
  write32(4, 36 + dataSize);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  write32(16, 16);       // PCM
  write16(20, 1);        // Audio format = PCM
  write16(22, 1);        // Channels = 1
  write32(24, sampleRate);
  write32(28, byteRate);
  write16(32, blockAlign);
  write16(34, 16);       // bits per sample
  writeStr(36, 'data');
  write32(40, dataSize);

  // Generate samples
  let phase = 0;
  const twoPi = Math.PI * 2;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let amp = volume;
    if (envelope === 'beep') amp *= Math.min(1, t * 20) * (1 - Math.max(0, (t - durationSec * 0.7)) / (durationSec * 0.3));
    if (envelope === 'pad') amp *= 0.5 * (0.5 + 0.5 * Math.sin(Math.PI * t / durationSec));
    const sample = Math.sin(phase) * amp;
    phase += twoPi * frequency / sampleRate;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true);
  }

  // Base64 encode
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(binary);
}

// "Embedded" textures as base64 (generated at load)
const ASSETS = {
  texGrass: null,
  texDirt: null,
  texStone: null,
  texWater: null,
  texLeaf: null,
  texWood: null,
  /* Audio */
  sfxAttack: null,
  sfxHit: null,
  sfxChop: null,
  sfxFish: null,
  sfxCook: null,
  bgMusic: null
};

// Pre-synthesize at startup
(function buildEmbeddedAssets(){
  ASSETS.texGrass = makeSolidPNG('#3a6e3a', 64);
  ASSETS.texDirt  = makeSolidPNG('#6b4a2d', 64);
  ASSETS.texStone = makeSolidPNG('#808a98', 64);
  ASSETS.texWater = makeSolidPNG('#2d4a8a', 64);
  ASSETS.texLeaf  = makeSolidPNG('#2f7d4f', 64);
  ASSETS.texWood  = makeSolidPNG('#a77a43', 64);

  ASSETS.sfxAttack = synthWavBase64({ durationSec: 0.08, frequency: 700, volume: 0.35, envelope:'beep' });
  ASSETS.sfxHit    = synthWavBase64({ durationSec: 0.09, frequency: 200, volume: 0.35, envelope:'beep' });
  ASSETS.sfxChop   = synthWavBase64({ durationSec: 0.12, frequency: 320, volume: 0.3,  envelope:'beep' });
  ASSETS.sfxFish   = synthWavBase64({ durationSec: 0.18, frequency: 500, volume: 0.25, envelope:'beep' });
  ASSETS.sfxCook   = synthWavBase64({ durationSec: 0.25, frequency: 900, volume: 0.2,  envelope:'beep' });
  // simple looping "pad" chord by layering 3 tones into one WAV-like progression (cheap trick: fast arpeggio)
  ASSETS.bgMusic   = synthWavBase64({ durationSec: 2.8, frequency: 440, volume: 0.12, envelope:'pad' });
})();

/* -----------------------------
   Core Game Setup
-------------------------------- */
const canvas = document.getElementById('game-canvas');
const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true });

let scene, gui, player, navTarget;
let audio = {};
let state = {
  time: 0,
  musicOn: true,
  inventory: [],
  gold: 0,
  stats: {
    attack: 1,
    strength: 1,
    defense: 1,
    hp: 10,
    maxHp: 10
  },
  skills: {
    woodcutting: { lvl: 1, xp: 0 },
    fishing:     { lvl: 1, xp: 0 },
    cooking:     { lvl: 1, xp: 0 }
  },
  enemies: [],
  npcs: [],
  interactables: [],
};

// Keyboard input for isometric movement
const inputMap = {};
window.addEventListener('keydown', (e) => {
  inputMap[e.key.toLowerCase()] = true;
});
window.addEventListener('keyup', (e) => {
  inputMap[e.key.toLowerCase()] = false;
});

function handleKeyboardMovement(dt) {
  // Arrow keys for isometric movement: up/right/left/down
  let dx = 0, dz = 0;
  if (inputMap["arrowup"])    { dx += Math.SQRT1_2; dz += Math.SQRT1_2; }   // NW
  if (inputMap["arrowdown"])  { dx -= Math.SQRT1_2; dz -= Math.SQRT1_2; }   // SE
  if (inputMap["arrowleft"])  { dx -= Math.SQRT1_2; dz += Math.SQRT1_2; }   // SW
  if (inputMap["arrowright"]) { dx += Math.SQRT1_2; dz -= Math.SQRT1_2; }   // NE

  if (dx !== 0 || dz !== 0) {
    // Cancel click-destination movement
    moveDest = null;
    // Normalize so diagonal speed stays constant
    const norm = Math.sqrt(dx*dx + dz*dz);
    const speed = 5; // match moveSpeed
    player.moveWithCollisions(new BABYLON.Vector3(
      (dx / (norm||1)) * speed * dt,
      0,
      (dz / (norm||1)) * speed * dt
    ));
    // Player faces movement direction
    player.rotation.y = Math.atan2(dx, dz);
  }
}

function isoOrthoSetup(camera) {
  // ArcRotate with orthographic mode to achieve an "isometric-like" projection
  camera.mode = BABYLON.Camera.ORTHOGRAPHIC_CAMERA;
  function updateOrtho() {
    const rect = engine.getRenderingCanvasClientRect() || { width: canvas.width, height: canvas.height };
    const aspect = rect.width / rect.height;
    const orthoSize = 30; // zoom factor
    camera.orthoLeft   = -orthoSize * aspect;
    camera.orthoRight  =  orthoSize * aspect;
    camera.orthoTop    =  orthoSize;
    camera.orthoBottom = -orthoSize;
  }
  updateOrtho();
  window.addEventListener('resize', updateOrtho);
}

// ... rest of file unchanged, up to update() function below ...

let moveDest = null;
const moveSpeed = 5; // units/sec
function moveTo(point) {
  if (!point) return;
  moveDest = point.clone();
  moveDest.y = 1; // keep above ground
  navTarget.position.set(moveDest.x, 0.05, moveDest.z);
  navTarget.isVisible = true;
}
function update() {
  const dt = engine.getDeltaTime() / 1000;
  state.time += dt;

  // Keyboard movement (new)
  handleKeyboardMovement(dt);

  // Move player (point and click)
  if (moveDest) {
    const dir = moveDest.subtract(player.position);
    const d = dir.length();
    if (d < 0.1) { moveDest = null; navTarget.isVisible = false; }
    else {
      dir.normalize();
      player.moveWithCollisions(dir.scale(moveSpeed * dt));
      // face direction
      player.rotation.y = Math.atan2(dir.x, dir.z);
    }
  }

  // ... rest of your update logic unchanged ...
}

// ... rest of script.js unchanged ...