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

function createScene() {
  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.04,0.06,0.09,1);
  scene.ambientColor = new BABYLON.Color3(0.6,0.6,0.7);

  const camera = new BABYLON.ArcRotateCamera("isoCam", -Math.PI * 0.25, Math.PI * 0.5, 60, new BABYLON.Vector3(0,0,0), scene);
  camera.upperBetaLimit = Math.PI * 0.5;
  camera.lowerBetaLimit = Math.PI * 0.5;
  camera.upperRadiusLimit = camera.lowerRadiusLimit = 60; // lock zoom
  camera.panningSensibility = 0;
  camera.attachControl(canvas, true);
  isoOrthoSetup(camera);

  const light = new BABYLON.HemisphericLight("h", new BABYLON.Vector3(0.5,1,0.3), scene);
  light.intensity = 0.95;

  // GUI
  gui = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("gui", true, scene);

  // Audio Manager
  audio.bg = new BABYLON.Sound("bg", ASSETS.bgMusic, scene, null, { loop: true, autoplay: true, volume: 0.35 });
  audio.attack = new BABYLON.Sound("atk", ASSETS.sfxAttack, scene, null, { volume: 0.7 });
  audio.hit    = new BABYLON.Sound("hit", ASSETS.sfxHit, scene, null, { volume: 0.7 });
  audio.chop   = new BABYLON.Sound("chop", ASSETS.sfxChop, scene, null, { volume: 0.7 });
  audio.fish   = new BABYLON.Sound("fish", ASSETS.sfxFish, scene, null, { volume: 0.7 });
  audio.cook   = new BABYLON.Sound("cook", ASSETS.sfxCook, scene, null, { volume: 0.7 });

  // Materials
  const matGrass = new BABYLON.StandardMaterial("matGrass", scene);
  matGrass.diffuseTexture = new BABYLON.Texture(ASSETS.texGrass, scene);
  matGrass.specularColor = BABYLON.Color3.Black();

  const matDirt = new BABYLON.StandardMaterial("matDirt", scene);
  matDirt.diffuseTexture = new BABYLON.Texture(ASSETS.texDirt, scene);
  matDirt.specularColor = BABYLON.Color3.Black();

  const matStone = new BABYLON.StandardMaterial("matStone", scene);
  matStone.diffuseTexture = new BABYLON.Texture(ASSETS.texStone, scene);
  matStone.specularColor = BABYLON.Color3.Black();

  const matWater = new BABYLON.StandardMaterial("matWater", scene);
  matWater.diffuseTexture = new BABYLON.Texture(ASSETS.texWater, scene);
  matWater.alpha = 0.85;
  matWater.specularColor = new BABYLON.Color3(0.2,0.3,0.8);

  const matLeaf = new BABYLON.StandardMaterial("matLeaf", scene);
  matLeaf.diffuseTexture = new BABYLON.Texture(ASSETS.texLeaf, scene);
  matLeaf.specularColor = BABYLON.Color3.Black();

  const matWood = new BABYLON.StandardMaterial("matWood", scene);
  matWood.diffuseTexture = new BABYLON.Texture(ASSETS.texWood, scene);
  matWood.specularColor = BABYLON.Color3.Black();

  // Ground (tiles)
  const tileSize = 3;
  const half = 10;
  const groundParent = new BABYLON.TransformNode("groundParent", scene);
  for (let x = -half; x <= half; x++) {
    for (let z = -half; z <= half; z++) {
      const tile = BABYLON.MeshBuilder.CreateGround(`g_${x}_${z}`, { width: tileSize, height: tileSize, subdivisions: 1 }, scene);
      tile.position.set(x * tileSize, 0, z * tileSize);
      tile.checkCollisions = false;
      // River strip
      if (z >= -2 && z <= 0) tile.material = matWater;
      else if ((x+z) % 7 === 0) tile.material = matDirt;
      else tile.material = matGrass;
      tile.parent = groundParent;
    }
  }

  // Bridge across river
  const bridge = BABYLON.MeshBuilder.CreateBox("bridge", { width: tileSize * 2, height: 0.4, depth: tileSize * 4 }, scene);
  bridge.position = new BABYLON.Vector3(0, 0.2, -3);
  bridge.material = matStone;

  // Keep (castle-like)
  const keepBase = BABYLON.MeshBuilder.CreateBox("keepBase", { width: 12, height: 4, depth: 10 }, scene);
  keepBase.position = new BABYLON.Vector3(0, 2, 15);
  keepBase.material = matStone;
  const keepTowerL = BABYLON.MeshBuilder.CreateCylinder("towerL", { diameter: 3, height: 8 }, scene);
  keepTowerL.position = new BABYLON.Vector3(-5, 4, 18);
  keepTowerL.material = matStone;
  const keepTowerR = keepTowerL.clone("towerR");
  keepTowerR.position = new BABYLON.Vector3(5, 4, 18);

  // Trees (instanced)
  const trunk = BABYLON.MeshBuilder.CreateCylinder("trunkProto", { diameter: 0.6, height: 2 }, scene);
  trunk.material = matWood;
  const crown = BABYLON.MeshBuilder.CreateSphere("crownProto", { diameter: 2.2, segments: 8 }, scene);
  crown.position.y = 1.6;
  crown.material = matLeaf;
  const treeProto = BABYLON.Mesh.MergeMeshes([trunk, crown], true, true, undefined, false, true);
  treeProto.name = "treeProto";
  const treePositions = [
    [-12, 8], [-8, 10], [-6, -6], [10,-10], [14,6], [-14,-8], [12,12], [-2, -12], [6, 14]
  ];
  treePositions.forEach(([x,z]) => {
    const t = treeProto.createInstance(`tree_${x}_${z}`);
    t.position.set(x, 0, z);
    state.interactables.push({ type: 'tree', node: t, respawn: 0 });
  });

  // Fishing spots (buoys)
  function makeBuoy(name, x, z) {
    const b = BABYLON.MeshBuilder.CreateCylinder(name, { diameterTop: 0.2, diameterBottom: 0.6, height: 1.2 }, scene);
    b.position.set(x, 0.6, z);
    b.material = matStone;
    state.interactables.push({ type:'fishing', node: b, respawn: 0 });
  }
  makeBuoy('fish1', -6, -1);
  makeBuoy('fish2', 6, -1);

  // Campfire (cooking)
  const fire = BABYLON.MeshBuilder.CreateCylinder("firePit", { diameter: 1.2, height: 0.4 }, scene);
  fire.position.set(4, 0.2, 6);
  fire.material = matDirt;
  state.interactables.push({ type:'cooking', node: fire, respawn: 0 });

  // Player
  player = BABYLON.MeshBuilder.CreateCapsule("player", { height: 2, radius: 0.45 }, scene);
  player.position.set(-2, 1, 2);
  player.material = new BABYLON.StandardMaterial("pmat", scene);
  player.material.diffuseColor = new BABYLON.Color3(0.85,0.85,1.0);
  player.checkCollisions = true;
  player.ellipsoid = new BABYLON.Vector3(0.45, 1.0, 0.45);

  // Simple selection marker
  navTarget = BABYLON.MeshBuilder.CreateTorus("nav", { diameter: 1.2, thickness: 0.07, tessellation: 32 }, scene);
  navTarget.position.y = 0.05;
  navTarget.isVisible = false;
  navTarget.material = new BABYLON.StandardMaterial("navMat", scene);
  navTarget.material.emissiveColor = new BABYLON.Color3(0.2, 0.8, 1);

  // Enemies (boglins)
  function spawnEnemy(id, pos) {
    const e = BABYLON.MeshBuilder.CreateBox(`enemy_${id}`, { size: 1.2 }, scene);
    e.position.copyFrom(pos);
    const m = new BABYLON.StandardMaterial(`em_${id}`, scene);
    m.diffuseColor = new BABYLON.Color3(0.2, 0.9, 0.3);
    e.material = m;
    e.metadata = {
      maxHp: 8, hp: 8, alive: true, respawnTimer: 0, attackCd: 0,
      stats: { attack: 1, strength: 1, defense: 0 },
      loot: [{ name: 'Bone', qty: 1, value: 1 }]
    };
    // Health bar (GUI)
    const rect = new BABYLON.GUI.Rectangle(`hp_${id}`);
    rect.width = "60px"; rect.height = "8px";
    rect.thickness = 1; rect.color = "#99ffbb";
    rect.cornerRadius = 4;
    rect.background = "rgba(0,0,0,0.4)";
    gui.addControl(rect);
    rect.linkWithMesh(e);
    rect.linkOffsetY = -50;
    const bar = new BABYLON.GUI.Rectangle();
    bar.height = "100%"; bar.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    bar.background = "#2aff88"; bar.width = "100%";
    rect.addControl(bar);
    e.metadata.hpUI = { rect, bar };
    state.enemies.push(e);
  }
  spawnEnemy(1, new BABYLON.Vector3(-5, 0.6, 9));
  spawnEnemy(2, new BABYLON.Vector3(8,  0.6, -6));
  spawnEnemy(3, new BABYLON.Vector3(10, 0.6, 10));

  // NPC (Lord of Brookhaven) with dialogue
  const npc = BABYLON.MeshBuilder.CreateCylinder("npc_lord", { diameter: 1.4, height: 2.2 }, scene);
  npc.position.set(0, 1.1, 13.5);
  const npcMat = new BABYLON.StandardMaterial("npcMat", scene);
  npcMat.diffuseColor = new BABYLON.Color3(0.8,0.75,0.4);
  npc.material = npcMat;
  state.npcs.push({ name: "Lord of Brookhaven", node: npc });

  // Click handling (point & click)
  scene.onPointerObservable.add((pointerInfo) => {
    if (pointerInfo.type !== BABYLON.PointerEventTypes.POINTERPICK) return;
    const pick = pointerInfo.pickInfo;
    if (!pick?.hit) return;

    const picked = pick.pickedMesh;
    if (picked && picked.name.startsWith("enemy_")) {
      combat.handlePlayerAttack(picked);
      return;
    }
    const inter = state.interactables.find(i => i.node === picked);
    if (inter) {
      if (inter.type === 'tree') skills.woodcut(inter);
      else if (inter.type === 'fishing') skills.fish(inter);
      else if (inter.type === 'cooking') skills.cook(inter);
      return;
    }
    const npcTarget = state.npcs.find(n=>n.node===picked);
    if (npcTarget) {
      ui.dialogue(npcTarget.name, [
        { text: "Who are you?", reply: "I am the Lord of these lands. Keep the bridge safe and the hearth warm." },
        { text: "Any work for me?", reply: "Chop wood, catch fish, cook meals — the keep always needs supplies." },
        { text: "Goodbye.", reply: "May your blade stay keen." }
      ]);
      return;
    }

    // Move command to ground/any empty pick
    moveTo(pick.pickedPoint);
  });

  // Simple tick
  scene.onBeforeRenderObservable.add(update);
  return scene;
}

/* -----------------------------
   Movement & Animation (simplified)
-------------------------------- */
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

  // Move player
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

  // Enemies: basic proximity aggro
  state.enemies.forEach(e => {
    const md = e.metadata;
    if (!md.alive) {
      md.respawnTimer -= dt;
      if (md.respawnTimer <= 0) {
        md.alive = true; e.isVisible = true; e.setEnabled(true);
        md.hp = md.maxHp;
        ui.updateEnemyHp(e);
      }
      return;
    }
    // cooldowns
    md.attackCd = Math.max(0, md.attackCd - dt);

    const toPlayer = player.position.subtract(e.position);
    const dist = toPlayer.length();
    if (dist < 8 && dist > 1.6) {
      toPlayer.normalize();
      e.moveWithCollisions(toPlayer.scale(2 * dt));
      e.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);
    } else if (dist <= 1.6 && md.attackCd === 0) {
      combat.enemyAttackPlayer(e);
      md.attackCd = 1.1;
    }
  });

  // Floating UI updates
  ui.refreshPanels();
}

/* -----------------------------
   UI (Babylon GUI + DOM)
-------------------------------- */
const ui = {
  invList: document.getElementById('inventoryList'),
  invPanel: document.getElementById('inventoryPanel'),
  statsPanel: document.getElementById('statsPanel'),
  skillsPanel: document.getElementById('skillsPanel'),
  statsDiv: document.getElementById('charStats'),
  skillsDiv: document.getElementById('skillsStats'),

  // Dialogue popup
  dialogue(name, options) {
    const panel = new BABYLON.GUI.Rectangle();
    panel.width = "420px"; panel.height = "220px";
    panel.thickness = 1; panel.color = "#bcd";
    panel.background = "rgba(12,16,22,0.85)"; panel.cornerRadius = 10;
    gui.addControl(panel);
    const title = new BABYLON.GUI.TextBlock();
    title.text = name; title.fontSize = 22; title.height = "40px";
    title.color = "#fff"; title.paddingTop = 8;
    panel.addControl(title);
    const reply = new BABYLON.GUI.TextBlock();
    reply.text = "Greetings, traveler."; reply.color = "#cfe"; reply.height = "60px"; reply.top = "34px";
    panel.addControl(reply);

    let y = 80;
    options.forEach(opt => {
      const b = BABYLON.GUI.Button.CreateSimpleButton("opt", opt.text);
      b.width = "90%"; b.height = "34px"; b.top = `${y}px`; b.thickness = 1;
      b.color = "#fff"; b.background = "rgba(255,255,255,0.08)"; b.cornerRadius = 8;
      b.onPointerUpObservable.add(()=> { reply.text = opt.reply; });
      panel.addControl(b);
      y += 38;
    });

    const close = BABYLON.GUI.Button.CreateSimpleButton("close", "Close");
    close.width = "90%"; close.height = "34px"; close.top = `${y}px`; close.color="#ffdddd";
    close.background = "rgba(255,100,100,0.15)"; close.cornerRadius = 8; close.thickness=1;
    close.onPointerUpObservable.add(()=> { panel.dispose(); });
    panel.addControl(close);
  },

  updateEnemyHp(enemy) {
    const { hp, maxHp, hpUI } = enemy.metadata;
    const ratio = Math.max(0, hp / maxHp);
    hpUI.bar.width = Math.floor(60 * ratio) + "px";
  },

  refreshPanels() {
    // Stats
    const s = state.stats;
    this.statsDiv.innerHTML = `
      <div>HP: ${s.hp} / ${s.maxHp}</div>
      <div>Attack: ${s.attack}</div>
      <div>Strength: ${s.strength}</div>
      <div>Defense: ${s.defense}</div>
      <div>Gold: ${state.gold}</div>
    `;
    // Skills
    const sk = state.skills;
    this.skillsDiv.innerHTML = `
      <div>Woodcutting: Lv ${sk.woodcutting.lvl} — ${sk.woodcutting.xp} xp</div>
      <div>Fishing: Lv ${sk.fishing.lvl} — ${sk.fishing.xp} xp</div>
      <div>Cooking: Lv ${sk.cooking.lvl} — ${sk.cooking.xp} xp</div>
    `;
    // Inventory
    this.invList.innerHTML = '';
    state.inventory.forEach((item, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${item.name} x${item.qty || 1}</span><span class="badge">V:${item.value ?? 0}</span>`;
      this.invList.appendChild(li);
    });
  }
};

// Panel toggles + hotkeys
(function panelSetup(){
  const btnInventory = document.getElementById('btnInventory');
  const btnStats = document.getElementById('btnStats');
  const btnSkills = document.getElementById('btnSkills');
  const btnMusic = document.getElementById('btnMusic');

  btnInventory.onclick = ()=> ui.invPanel.classList.toggle('hidden');
  btnStats.onclick = ()=> ui.statsPanel.classList.toggle('hidden');
  btnSkills.onclick = ()=> ui.skillsPanel.classList.toggle('hidden');
  btnMusic.onclick = ()=> toggleMusic();

  window.addEventListener('keydown', (e)=>{
    if (e.key.toLowerCase()==='i') btnInventory.click();
    if (e.key.toLowerCase()==='c') btnStats.click();
    if (e.key.toLowerCase()==='k') btnSkills.click();
    if (e.key.toLowerCase()==='m') btnMusic.click();
  });
})();

/* -----------------------------
   Leveling helpers
-------------------------------- */
function xpForLevel(lvl) {
  // lightweight curve
  return Math.floor(50 * Math.pow(lvl - 1, 1.6) + 0);
}
function grantSkillXp(skillKey, amount) {
  const sk = state.skills[skillKey];
  sk.xp += amount;
  while (sk.xp >= xpForLevel(sk.lvl + 1)) {
    sk.lvl++;
    // small character bonuses
    if (skillKey === 'woodcutting') state.stats.strength += 1;
    if (skillKey === 'fishing') state.stats.defense += 1;
    if (skillKey === 'cooking') state.stats.attack += 1;
  }
}

/* -----------------------------
   Combat System
-------------------------------- */
const combat = {
  damage(attackerStats, defenderStats) {
    // super simple: base ± random, modified by attack/strength vs defense
    const base = 1 + Math.floor(attackerStats.strength * 0.6 + attackerStats.attack * 0.4);
    const reduction = Math.floor(defenderStats.defense * 0.4);
    const roll = Math.floor(Math.random()*2); // 0–1
    return Math.max(1, base + roll - reduction);
  },

  handlePlayerAttack(enemy) {
    if (!enemy.metadata.alive) return;
    // move into melee range if far
    const dist = BABYLON.Vector3.Distance(player.position, enemy.position);
    if (dist > 1.7) {
      moveTo(enemy.position);
      return;
    }
    // swing
    audio.attack.play();
    const dmg = this.damage(state.stats, enemy.metadata.stats);
    enemy.metadata.hp -= dmg;
    ui.updateEnemyHp(enemy);
    if (enemy.metadata.hp <= 0) {
      this.killEnemy(enemy);
    } else {
      // enemy counter chance
      if (Math.random() < 0.4) this.enemyAttackPlayer(enemy);
    }
  },

  enemyAttackPlayer(enemy) {
    if (!enemy.metadata.alive) return;
    audio.hit.play();
    const dmg = this.damage(enemy.metadata.stats, state.stats);
    state.stats.hp = Math.max(0, state.stats.hp - dmg);
    if (state.stats.hp <= 0) {
      this.playerDeath();
    }
  },

  killEnemy(enemy) {
    enemy.metadata.alive = false;
    enemy.isVisible = false;
    enemy.setEnabled(false);
    enemy.metadata.respawnTimer = 6 + Math.random()*4;
    // Loot + chance for unique item
    const loot = [...enemy.metadata.loot];
    // Unique drop system (extremely low rate)
    if (Math.random() < 0.005) {
      loot.push(generateUniqueItem());
    } else if (Math.random() < 0.4) {
      loot.push({ name: 'Coin', qty: 5 + Math.floor(Math.random()*6), value: 1 });
    }
    loot.forEach(addItem);
    // tiny heal on kill
    state.stats.hp = Math.min(state.stats.maxHp, state.stats.hp + 1);
    // stat xp bump
    state.stats.attack += Math.random()<0.2 ? 1 : 0;
    state.stats.strength += Math.random()<0.2 ? 1 : 0;
    ui.updateEnemyHp(enemy);
  },

  playerDeath() {
    // respawn near the bridge
    state.stats.hp = state.stats.maxHp;
    player.position.set(0, 1, 2);
  }
};

/* -----------------------------
   Unique Item Generation
-------------------------------- */
function generateUniqueItem() {
  const prefixes = ['Elder', 'Starlit', 'Warden’s', 'Whispering', 'Brookhaven'];
  const bases = ['Blade', 'Axe', 'Halberd', 'Spear', 'Mace'];
  const suffixes = ['of Tides', 'of Embers', 'of Zephyrs', 'of Dawn', 'of the Keep'];
  const name = `${prefixes[(Math.random()*prefixes.length)|0]} ${bases[(Math.random()*bases.length)|0]} ${suffixes[(Math.random()*suffixes.length)|0]}`;
  const roll = ()=> 1 + (Math.random()*3|0);
  const stats = { attack: roll(), strength: roll(), defense: roll() };
  const value = 100 + ((stats.attack + stats.strength + stats.defense) * 25);
  return { name, unique: true, stats, value };
}

/* -----------------------------
   Skills
-------------------------------- */
const skills = {
  woodcut(inter) {
    if (inter.respawn > 0) return; // on cooldown
    // move close
    if (BABYLON.Vector3.Distance(player.position, inter.node.position) > 2) {
      moveTo(inter.node.position);
      return;
    }
    audio.chop.play();
    grantSkillXp('woodcutting', 10 + ((Math.random()*6)|0));
    addItem({ name:'Log', qty: 1, value: 2 });
    inter.respawn = 3;
    // small shake
    inter.node.scaling.y = 0.95;
    setTimeout(()=> inter.node.scaling.y = 1, 200);
    // Cooldown tick
    cooldown(inter);
  },

  fish(inter) {
    if (inter.respawn > 0) return;
    if (BABYLON.Vector3.Distance(player.position, inter.node.position) > 2.2) {
      moveTo(inter.node.position);
      return;
    }
    audio.fish.play();
    grantSkillXp('fishing', 10 + ((Math.random()*6)|0));
    addItem({ name:'Raw Fish', qty: 1, value: 3 });
    inter.respawn = 3;
    cooldown(inter);
  },

  cook(inter) {
    // require raw fish
    const idx = state.inventory.findIndex(i=>i.name==='Raw Fish' && (i.qty??1)>0);
    if (idx === -1) return;
    if (BABYLON.Vector3.Distance(player.position, inter.node.position) > 2.2) {
      moveTo(inter.node.position);
      return;
    }
    audio.cook.play();
    grantSkillXp('cooking', 10 + ((Math.random()*6)|0));
    removeItemAt(idx, 1);
    addItem({ name:'Cooked Fish', qty: 1, value: 5 });
  }
};

function cooldown(inter) {
  const t = setInterval(()=>{
    inter.respawn = Math.max(0, inter.respawn - 0.5);
    if (inter.respawn === 0) clearInterval(t);
  }, 500);
}

/* -----------------------------
   Inventory helpers
-------------------------------- */
function addItem(it) {
  const existing = state.inventory.find(x=>x.name===it.name && !x.unique);
  if (existing && it.qty) existing.qty += it.qty;
  else state.inventory.push({ ...it });
}
function removeItemAt(idx, qty=1) {
  const it = state.inventory[idx];
  if (!it) return;
  if ((it.qty??1) > qty) it.qty -= qty;
  else state.inventory.splice(idx,1);
}

/* -----------------------------
   Music toggle
-------------------------------- */
function toggleMusic() {
  state.musicOn = !state.musicOn;
  if (state.musicOn) audio.bg.play();
  else audio.bg.pause();
}

/* -----------------------------
   Boot
-------------------------------- */
createScene();
engine.runRenderLoop(()=> scene.render());
window.addEventListener('resize', ()=> engine.resize());

// Initial UI state
ui.refreshPanels();
document.getElementById('inventoryPanel').classList.remove('hidden');
document.getElementById('statsPanel').classList.remove('hidden');
document.getElementById('skillsPanel').classList.remove('hidden');
