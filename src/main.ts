import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ARButton } from 'three/examples/jsm/webxr/ARButton.js';
import { XRHandModelFactory } from 'three/examples/jsm/webxr/XRHandModelFactory.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RubiksCube, HALF, type Axis, type Layer } from './cube';
import { Surfaces, spawnPointOn } from './table';
import { Toast, TextPanel, LayerHighlight, HandRay, GrabBox, PinchRing, DropMarker, type Handedness } from './ui';
import { WristMenu } from './menu';
import { sfx, unlockAudio } from './audio';

const params = new URLSearchParams(location.search);
const arSupported = await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false);
const emulator = params.has('emulate') || !arSupported ? await (await import('./emulator')).installEmulator(params) : null;

await RAPIER.init();

// ---- renderer, scene, light ------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.NeutralToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
scene.add(camera);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.7;
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -0.25, right: 0.25, top: 0.25, bottom: -0.25, near: 0.05, far: 3 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- physics -----------------------------------------------------------------
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const surfaces = new Surfaces(RAPIER, world, scene);
const body = world.createRigidBody(
  RAPIER.RigidBodyDesc.kinematicPositionBased().setCcdEnabled(true).setLinearDamping(0.05).setAngularDamping(0.4).setTranslation(0, -10, 0),
);
world.createCollider(RAPIER.ColliderDesc.cuboid(HALF, HALF, HALF).setDensity(140).setFriction(0.8).setRestitution(0.2), body);
const STEP = 1 / 90;
let accumulator = 0;

// ---- cube and affordances --------------------------------------------------
const gltf = await new GLTFLoader().loadAsync(import.meta.env.BASE_URL + 'cube.glb');
const cube = new RubiksCube(gltf);
cube.frame.visible = false;
scene.add(cube.frame);
const grabBox = new GrabBox();
cube.frame.add(grabBox.box);
const drop = new DropMarker();
scene.add(drop.mesh);
const toast = new Toast(scene);
const hint = new TextPanel(0.26, 0.075, 768);
hint.visible = false;
scene.add(hint);
const menu = new WristMenu([
  { id: 'spawn', label: 'New cube' },
  { id: 'scramble', label: 'Scramble' },
  { id: 'reset', label: 'Solve / reset' },
]);
scene.add(menu.group);

// ---- hands -------------------------------------------------------------------
interface HandSlot {
  hand: THREE.XRHandSpace;
  ray: THREE.XRTargetRaySpace;
  side: Handedness | null;
  isHand: boolean;
  occluderReady: boolean;
}
interface HandState {
  side: Handedness;
  pinching: boolean;
  pinch: number;
  pinchPoint: THREE.Vector3;
  hover: { axis: Axis; layer: Layer } | null;
  pokeArmed: boolean;
  /** Last time (ms) the open pinch point was in grab range. */
  nearAt: number;
  ray: HandRay;
  highlight: LayerHighlight;
  ring: PinchRing;
}
const factory = new XRHandModelFactory();
const slots: HandSlot[] = [0, 1].map((i) => {
  const hand = renderer.xr.getHand(i);
  const ray = renderer.xr.getController(i);
  hand.add(factory.createHandModel(hand, 'mesh'));
  const slot: HandSlot = { hand, ray, side: null, isHand: false, occluderReady: false };
  hand.addEventListener('connected', (e) => {
    const src = (e as unknown as { data: XRInputSource }).data;
    slot.side = src.handedness === 'left' ? 'left' : 'right';
    slot.isHand = !!src.hand;
    if (!src.hand) toast.show('Put the controllers down:\nthis game uses hand tracking', 4);
  });
  hand.addEventListener('disconnected', () => (slot.side = null));
  scene.add(hand, ray);
  return slot;
});
const hands: Record<Handedness, HandState> = {
  left: makeHandState('left'),
  right: makeHandState('right'),
};
function makeHandState(side: Handedness): HandState {
  const s: HandState = {
    side, pinching: false, pinch: 0, pinchPoint: new THREE.Vector3(), hover: null, pokeArmed: true, nearAt: -Infinity,
    ray: new HandRay(side), highlight: new LayerHighlight(side), ring: new PinchRing(side),
  };
  scene.add(s.ray.line, s.ray.reticle, s.ring.mesh);
  cube.frame.add(s.highlight.group);
  return s;
}
/** Real hands hide the cube behind them: the hand mesh writes depth only. */
function makeOccluder(slot: HandSlot) {
  if (slot.occluderReady) return;
  slot.hand.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
      (o as THREE.Mesh).material = new THREE.MeshBasicMaterial({ colorWrite: false });
      o.renderOrder = -1;
      slot.occluderReady = true;
    }
  });
}
const joint = (slot: HandSlot, name: XRHandJoint) => {
  const j = slot.hand.joints[name];
  return j && j.visible ? j.getWorldPosition(new THREE.Vector3()) : null;
};

// ---- game state ----------------------------------------------------------------
const TURN_DIR: Record<Handedness, 1 | -1> = { right: 1, left: -1 };
let held: { side: Handedness; offset: THREE.Matrix4; history: { t: number; pos: THREE.Vector3; quat: THREE.Quaternion }[] } | null = null;
let spawnState: { t: number; start: THREE.Vector3; yaw: number; floating: boolean } | null = null;
let floating = false;
let spawned = false;
let sessionStart = 0;
let lastVy = 0;
let tutorial: 'grab' | 'turn' | 'menu' | 'done' = 'grab';
let moves = 0;
let scrambledAt: number | null = null;

cube.onTurnStart = () => sfx.turnStart();
cube.onTurnEnd = (turn) => {
  sfx.turnEnd();
  if (turn.duration >= 0.15) moves++;
  if (tutorial === 'turn') tutorial = 'menu';
  if (scrambledAt !== null && !cube.busy && cube.isSolved()) {
    const s = Math.round((performance.now() - scrambledAt) / 1000);
    toast.show(`Solved in ${moves} moves · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, 5, '#7CFC9A');
    sfx.solved();
    scrambledAt = null;
  }
};

menu.onPress = (id) => {
  sfx.button();
  if (tutorial === 'menu') tutorial = 'done';
  if (id === 'spawn') spawn();
  if (id === 'scramble') {
    cube.scramble(20);
    moves = 0;
    scrambledAt = performance.now() + 20 * 90;
    toast.show('Scrambled. Solve it!', 2);
  }
  if (id === 'reset') {
    cube.reset();
    scrambledAt = null;
    toast.show('Reset to solved', 1.5);
  }
};

function headPosition() {
  return renderer.xr.getCamera().getWorldPosition(new THREE.Vector3());
}

function spawn() {
  const head = headPosition();
  const table = surfaces.pickTable(head);
  const yaw = Math.random() * Math.PI * 2;
  held = null;
  cube.frame.visible = true;
  body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  let start: THREE.Vector3;
  if (table) {
    const p = spawnPointOn(table, head);
    drop.show(p);
    start = p.clone().add(new THREE.Vector3(0, 0.35, 0));
    toast.show(table.label === 'table' ? 'Dropping a cube on your table' : 'Dropping a cube', 2);
  } else {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(renderer.xr.getCamera().quaternion).setY(0).normalize();
    start = head.clone().addScaledVector(fwd, 0.45).add(new THREE.Vector3(0, -0.2, 0));
    toast.show('No table found, so the cube floats.\nMark a table in Space Setup to drop it.', 4);
  }
  body.setTranslation(start, true);
  body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), true);
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  spawnState = { t: 0, start, yaw, floating: !table };
  floating = !table;
  spawned = true;
  sfx.spawn();
}

function grab(state: HandState, slot: HandSlot) {
  const handM = handMatrix(state, slot);
  if (!handM) return;
  const offset = handM.invert().multiply(cube.frame.matrixWorld);
  held = { side: state.side, offset, history: [] };
  spawnState = null;
  body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  if (tutorial === 'grab') tutorial = 'turn';
  sfx.grab();
}

function release() {
  if (!held) return;
  const h = held.history;
  held = null;
  floating = floating && surfaces.count === 0;
  if (floating) return; // no surfaces known: leave it where it was let go
  body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  if (h.length >= 2) {
    const a = h[0], b = h[h.length - 1];
    const dt = Math.max(1e-3, (b.t - a.t) / 1000);
    const v = b.pos.clone().sub(a.pos).divideScalar(dt).clampLength(0, 6);
    const dq = b.quat.clone().multiply(a.quat.clone().invert());
    const angle = 2 * Math.acos(THREE.MathUtils.clamp(Math.abs(dq.w), -1, 1));
    const axis = new THREE.Vector3(dq.x, dq.y, dq.z).normalize().multiplyScalar(dq.w < 0 ? -1 : 1);
    const w = angle > 1e-4 ? axis.multiplyScalar(Math.min(25, angle / dt)) : new THREE.Vector3();
    body.setLinvel(v, true);
    body.setAngvel(w, true);
  }
  sfx.release();
}

/**
 * The pose the held cube follows. It is the wrist, not the pinch point: the
 * pinch point moves when the fingers open, which would read as a throw.
 */
function handMatrix(_state: HandState, slot: HandSlot) {
  const wrist = slot.hand.joints['wrist'];
  if (!wrist || !wrist.visible) return null;
  return wrist.matrixWorld.clone();
}

/** Distance from a world point to the cube's surface (0 inside), and the point in cube space. */
function toCube(p: THREE.Vector3) {
  const local = cube.frame.worldToLocal(p.clone());
  const outside = new THREE.Vector3(Math.max(0, Math.abs(local.x) - HALF), Math.max(0, Math.abs(local.y) - HALF), Math.max(0, Math.abs(local.z) - HALF));
  return { local, dist: outside.length() };
}

/** The face nearest to a point in cube space: the axis with the largest component. */
function faceOf(local: THREE.Vector3): { axis: Axis; layer: Layer } {
  const a = [Math.abs(local.x), Math.abs(local.y), Math.abs(local.z)];
  const axis = a.indexOf(Math.max(...a)) as Axis;
  return { axis, layer: (Math.sign(local.getComponent(axis)) || 1) as Layer };
}

function turn(state: HandState, face: { axis: Axis; layer: Layer }) {
  cube.enqueue({ ...face, dir: TURN_DIR[state.side], duration: 0.22 });
}

// ---- per-frame hand logic ---------------------------------------------------------
const GRAB_RANGE = 0.035;
function updateHand(state: HandState, slot: HandSlot | undefined, dt: number, head: THREE.Vector3) {
  const thumb = slot && joint(slot, 'thumb-tip');
  const index = slot && joint(slot, 'index-finger-tip');
  if (!slot || !thumb || !index) {
    if (held?.side === state.side) release();
    state.ray.hide(); state.highlight.hide(); state.ring.update(null, 0, head);
    state.pinching = false; state.hover = null;
    return null;
  }
  makeOccluder(slot);
  const d = thumb.distanceTo(index);
  state.pinch = THREE.MathUtils.clamp((0.07 - d) / (0.07 - 0.018), 0, 1);
  state.pinchPoint.copy(thumb).add(index).multiplyScalar(0.5);
  const wasPinching = state.pinching;
  state.pinching = wasPinching ? d < 0.035 : d < 0.02;
  const pinchStart = state.pinching && !wasPinching;
  const pinchEnd = !state.pinching && wasPinching;

  const other = hands[state.side === 'left' ? 'right' : 'left'];
  const holding = held?.side === state.side;
  const cubeLive = cube.frame.visible;
  const near = cubeLive ? toCube(state.pinchPoint) : { dist: Infinity, local: new THREE.Vector3() };
  const menuHand = state.side === 'left' && menu.visible;

  // Holding: follow the hand; let go on pinch release. On the release frame the
  // fingers are opening and the hand pose is the least reliable, so it is not used.
  if (holding) {
    const m = pinchEnd ? null : handMatrix(state, slot);
    if (m) {
      const target = m.multiply(held!.offset);
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
      target.decompose(pos, quat, new THREE.Vector3());
      body.setNextKinematicTranslation(pos);
      body.setNextKinematicRotation(quat);
      const now = performance.now();
      held!.history.push({ t: now, pos, quat });
      while (held!.history.length > 2 && now - held!.history[0].t > 90) held!.history.shift();
    }
    if (pinchEnd) release();
    state.ray.hide(); state.highlight.hide(); state.ring.update(null, 0, head); state.hover = null;
    return { grabbable: false };
  }

  // Poke: when the other hand holds the cube, the index tip turns the face it presses.
  if (cubeLive && held?.side === other.side && state.pinch < 0.4) {
    const tip = toCube(index);
    if (tip.dist < 0.03) {
      const face = faceOf(tip.local);
      const depth = Math.abs(tip.local.getComponent(face.axis)) - HALF; // > 0 outside
      state.highlight.show(face.axis, face.layer, THREE.MathUtils.clamp(1 - depth / 0.03, 0, 1), dt);
      if (state.pokeArmed && depth < 0.002) {
        state.pokeArmed = false;
        turn(state, face);
      }
      if (depth > 0.015) state.pokeArmed = true;
      state.ray.hide(); state.ring.update(null, 0, head);
      state.hover = null;
      return { grabbable: false };
    }
    state.pokeArmed = true;
  }

  // Direct grab range: the pinch ring and the grab box show it. The fingers
  // close a few cm from where the open thumb-index midpoint was, so a pinch
  // grabs if the hand was in range during the last 250 ms.
  const now = performance.now();
  if (cubeLive && near.dist < GRAB_RANGE && !menuHand) state.nearAt = now;
  if (cubeLive && !menuHand && now - state.nearAt < 250) {
    state.ray.hide(); state.highlight.hide(); state.hover = null;
    state.ring.update(state.pinchPoint, state.pinch, head);
    if (pinchStart) grab(state, slot);
    return { grabbable: true };
  }
  state.ring.update(null, 0, head);

  // Far: point the hand ray at a face; pinch turns it.
  const origin = slot.ray.getWorldPosition(new THREE.Vector3());
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(slot.ray.getWorldQuaternion(new THREE.Quaternion()));
  let hit: { point: THREE.Vector3; normal: THREE.Vector3 } | null = null;
  let face: { axis: Axis; layer: Layer } | null = null;
  if (cubeLive && !menuHand && !cube.busy) {
    const inv = cube.frame.matrixWorld.clone().invert();
    const localRay = new THREE.Ray(origin.clone().applyMatrix4(inv), dir.clone().transformDirection(inv));
    const p = localRay.intersectBox(new THREE.Box3(new THREE.Vector3(-HALF, -HALF, -HALF), new THREE.Vector3(HALF, HALF, HALF)), new THREE.Vector3());
    if (p && p.distanceTo(localRay.origin) < 2.5) {
      face = faceOf(p);
      const n = new THREE.Vector3().setComponent(face.axis, face.layer).transformDirection(cube.frame.matrixWorld);
      hit = { point: cube.frame.localToWorld(p.clone()), normal: n };
    }
  }
  if (menuHand) state.ray.hide();
  else state.ray.update(origin, dir, hit, state.pinch);
  if (face) {
    if (!state.hover || state.hover.axis !== face.axis || state.hover.layer !== face.layer) sfx.hover();
    state.highlight.show(face.axis, face.layer, state.pinch, dt);
    if (pinchStart) turn(state, face);
  } else {
    state.highlight.hide();
  }
  state.hover = face;
  return { grabbable: false };
}

// ---- tutorial hint above the cube --------------------------------------------------------
const HINTS = {
  grab: 'Pinch the cube to pick it up',
  turn: 'Point at a face and pinch to turn it\nRight hand ↻ clockwise · Left hand ↺',
  menu: 'Turn your left palm toward you\nfor Scramble and New cube',
};
function updateHint(head: THREE.Vector3) {
  hint.visible = cube.frame.visible && tutorial !== 'done' && !spawnState;
  if (!hint.visible) return;
  hint.set(HINTS[tutorial as keyof typeof HINTS]);
  hint.position.copy(cube.frame.position).add(new THREE.Vector3(0, HALF + 0.09, 0));
  hint.lookAt(head);
}

// ---- main loop ---------------------------------------------------------------
const timer = new THREE.Timer();
renderer.setAnimationLoop((t, frame) => {
  timer.update(t);
  const dt = Math.min(0.05, timer.getDelta());
  if (!renderer.xr.isPresenting || !frame) {
    renderer.render(scene, camera);
    return;
  }
  const ref = renderer.xr.getReferenceSpace()!;
  surfaces.update(frame, ref);
  const head = headPosition();
  const xrCam = renderer.xr.getCamera();
  xrCam.updateMatrixWorld();

  if (!spawned && (surfaces.pickTable(head) || performance.now() - sessionStart > 2500)) spawn();

  // Spawn animation: grow while hovering, then drop (or keep floating).
  if (spawnState) {
    spawnState.t += dt;
    const k = Math.min(1, spawnState.t / 0.4);
    cube.frame.scale.setScalar(THREE.MathUtils.lerp(0.05, 1, 1 - Math.pow(1 - k, 3)));
    body.setNextKinematicTranslation(spawnState.start.clone().add(new THREE.Vector3(0, 0.01 * Math.sin(spawnState.t * 8), 0)));
    if (spawnState.t > 0.6) {
      cube.frame.scale.setScalar(1);
      if (!spawnState.floating) body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      spawnState = null;
    }
  }

  const bySide: Partial<Record<Handedness, HandSlot>> = {};
  for (const s of slots) if (s.side && s.isHand) bySide[s.side] = s;
  const grabbable: Handedness[] = [];
  for (const side of ['right', 'left'] as const) {
    const r = updateHand(hands[side], bySide[side], dt, head);
    if (r?.grabbable) grabbable.push(side);
  }
  grabBox.update(
    held ? { hand: held.side, pinch: 1, held: true }
      : grabbable.length ? { hand: grabbable[0], pinch: hands[grabbable[0]].pinch, held: false } : null,
  );

  const leftSlot = bySide.left;
  const wrist = leftSlot && joint(leftSlot, 'wrist');
  const idxMeta = leftSlot && joint(leftSlot, 'index-finger-metacarpal');
  const pinkyMeta = leftSlot && joint(leftSlot, 'pinky-finger-metacarpal');
  let palm: THREE.Vector3 | null = null, palmNormal: THREE.Vector3 | null = null;
  if (wrist && idxMeta && pinkyMeta) {
    // For a left hand, (index - wrist) x (pinky - wrist) points out of the back of the hand.
    palmNormal = idxMeta.clone().sub(wrist).cross(pinkyMeta.clone().sub(wrist)).normalize().negate();
    palm = wrist.clone().add(idxMeta).add(pinkyMeta).divideScalar(3);
  }
  const rightIndex = bySide.right ? joint(bySide.right, 'index-finger-tip') : null;
  menu.update(dt, palm, palmNormal, head, rightIndex);

  // Physics at a fixed step.
  accumulator += dt;
  while (accumulator >= STEP) {
    world.step();
    accumulator -= STEP;
  }
  const tr = body.translation(), rot = body.rotation();
  cube.frame.position.set(tr.x, tr.y, tr.z);
  cube.frame.quaternion.set(rot.x, rot.y, rot.z, rot.w);
  cube.frame.updateMatrixWorld();
  const vy = body.linvel().y;
  if (body.isDynamic() && lastVy < -0.4 && vy > lastVy + 0.3) sfx.land(-lastVy);
  lastVy = vy;
  if (spawned && tr.y < surfaces.floorY - 1) spawn();

  cube.update(dt);
  drop.update(dt, !spawnState && (!body.isDynamic() || Math.abs(vy) < 0.05));
  toast.update(dt, xrCam);
  updateHint(head);
  sun.position.copy(cube.frame.position).add(new THREE.Vector3(0.3, 1.2, 0.4));
  sun.target.position.copy(cube.frame.position);

  renderer.render(scene, camera);
});

// ---- start button -------------------------------------------------------------------
const button = ARButton.createButton(renderer, {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['hand-tracking', 'plane-detection'],
});
button.addEventListener('click', unlockAudio);
document.body.appendChild(button);
renderer.xr.addEventListener('sessionstart', () => {
  sessionStart = performance.now();
  spawned = false;
  document.getElementById('intro')!.style.display = 'none';
  toast.show('Looking for a table…', 2.5);
});
renderer.xr.addEventListener('sessionend', () => {
  document.getElementById('intro')!.style.display = '';
});

// Test hook for the emulator (Playwright drives the emulated hands).
Object.assign(window as object, {
  __game: {
    emulator, cube, body, surfaces, menu,
    spawn: () => spawn(),
    state: () => ({
      presenting: renderer.xr.isPresenting,
      spawned, floating, held: held?.side ?? null, tutorial, busy: cube.busy, solved: cube.isSolved(),
      cube: body.translation(), vy: body.linvel().y, planes: surfaces.count,
      table: surfaces.pickTable(headPosition()) && { ...surfaces.pickTable(headPosition())!.centre, label: surfaces.pickTable(headPosition())!.label },
      hover: { left: hands.left.hover, right: hands.right.hover },
      pinch: { left: hands.left.pinch, right: hands.right.pinch },
      pinchPoint: { left: hands.left.pinchPoint.toArray(), right: hands.right.pinchPoint.toArray() },
      head: headPosition().toArray(),
      indexTip: Object.fromEntries(slots.filter((s) => s.side).map((s) => [s.side, joint(s, 'index-finger-tip')?.toArray()])),
      menuPos: menu.group.position.toArray(),
      menuQuat: menu.group.quaternion.toArray(),
      cubeQuat: body.rotation(),
      menu: menu.visible,
      grid: cube.debugState(),
    }),
  },
});
