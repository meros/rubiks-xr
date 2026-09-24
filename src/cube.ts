import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Model units per cubie in the GLB (one Blender unit). */
const MODEL_SCALE = 0.03;
/** Half the edge length of the cube in metres (2.97 model units wide). */
export const HALF = 1.485 * MODEL_SCALE;
/** Distance between the centres of two neighbouring cubies, in metres. */
export const PITCH = MODEL_SCALE;

export type Axis = 0 | 1 | 2;
export type Layer = -1 | 0 | 1;

export interface Turn {
  axis: Axis;
  layer: Layer;
  /** +1 turns clockwise seen from outside the face at `layer`, -1 counterclockwise. */
  dir: 1 | -1;
  duration: number;
}

interface Cubie {
  node: THREE.Object3D;
  home: THREE.Vector3;
  /** Sticker directions in the cubie's own frame; the direction is also the colour id. */
  stickers: THREE.Vector3[];
}

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * The cube's visual state and turn logic. `frame` is the unscaled pose in the
 * world (driven by physics); `model` is the scaled GLB under it.
 */
export class RubiksCube {
  readonly frame = new THREE.Group();
  readonly model = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private readonly cubies: Cubie[] = [];
  private queue: Turn[] = [];
  private active: { turn: Turn; members: Cubie[]; t: number; q: THREE.Quaternion } | null = null;
  onTurnStart?: (turn: Turn) => void;
  onTurnEnd?: (turn: Turn) => void;

  constructor(gltf: GLTF) {
    this.model.scale.setScalar(MODEL_SCALE);
    this.frame.add(this.model);
    this.model.add(this.pivot);
    const src = gltf.scene.getObjectByName('RubiksCube') ?? gltf.scene;
    for (const child of [...src.children]) {
      const home = child.position.clone().round();
      const stickers: THREE.Vector3[] = [];
      for (let i = 0; i < 3; i++) if (home.getComponent(i) !== 0) stickers.push(AXES[i].clone().multiplyScalar(Math.sign(home.getComponent(i))));
      child.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = true;
      });
      this.model.add(child);
      this.cubies.push({ node: child, home, stickers });
    }
  }

  get busy() {
    return this.active !== null || this.queue.length > 0;
  }

  enqueue(turn: Turn) {
    if (this.queue.length < 3 || turn.duration < 0.15) this.queue.push(turn);
  }

  /** Cubies whose current grid coordinate on `axis` equals `layer`. */
  private members(axis: Axis, layer: Layer) {
    return this.cubies.filter((c) => Math.round(c.node.position.getComponent(axis)) === layer);
  }

  update(dt: number) {
    if (!this.active && this.queue.length) {
      const turn = this.queue.shift()!;
      const sign = turn.layer === 0 ? -1 : turn.layer;
      const q = new THREE.Quaternion().setFromAxisAngle(AXES[turn.axis], (-Math.PI / 2) * sign * turn.dir);
      const members = this.members(turn.axis, turn.layer);
      for (const m of members) this.pivot.add(m.node);
      this.active = { turn, members, t: 0, q };
      this.onTurnStart?.(turn);
    }
    if (!this.active) return;
    const a = this.active;
    a.t = Math.min(1, a.t + dt / a.turn.duration);
    this.pivot.quaternion.identity().slerp(a.q, ease(a.t));
    if (a.t < 1) return;
    for (const m of a.members) {
      m.node.position.applyQuaternion(a.q).round();
      m.node.quaternion.premultiply(a.q).normalize();
      this.model.add(m.node);
    }
    this.pivot.quaternion.identity();
    this.active = null;
    this.onTurnEnd?.(a.turn);
  }

  scramble(n = 20) {
    let last = -1;
    for (let i = 0; i < n; i++) {
      let axis: Axis;
      do axis = Math.floor(Math.random() * 3) as Axis;
      while (axis === last);
      last = axis;
      const layer = (Math.random() < 0.5 ? -1 : 1) as Layer;
      this.queue.push({ axis, layer, dir: Math.random() < 0.5 ? 1 : -1, duration: 0.09 });
    }
  }

  reset() {
    this.queue = [];
    if (this.active) {
      for (const m of this.active.members) this.model.add(m.node);
      this.pivot.quaternion.identity();
      this.active = null;
    }
    for (const c of this.cubies) {
      c.node.position.copy(c.home);
      c.node.quaternion.identity();
    }
  }

  isSolved() {
    const colourOf = new Map<string, string>();
    const v = new THREE.Vector3();
    for (const c of this.cubies) {
      for (const s of c.stickers) {
        v.copy(s).applyQuaternion(c.node.quaternion).round();
        const dirKey = `${v.x},${v.y},${v.z}`;
        const colour = `${s.x},${s.y},${s.z}`;
        const seen = colourOf.get(dirKey);
        if (seen && seen !== colour) return false;
        colourOf.set(dirKey, colour);
      }
    }
    return true;
  }

  /** Test hook: every cubie grid position, rounded. */
  debugState() {
    return this.cubies.map((c) => c.node.position.toArray().join(','));
  }
}
