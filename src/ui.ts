import * as THREE from 'three';
import { HALF, PITCH, type Axis, type Layer } from './cube';

export const HAND_COLOUR = { left: new THREE.Color('#ffb02e'), right: new THREE.Color('#35d0ff') };
export type Handedness = 'left' | 'right';

const additive = (colour: THREE.ColorRepresentation, opacity: number) =>
  new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });

// ---------------------------------------------------------------------------
// Text panel: a canvas texture on a plane. Width in metres, text wraps by line.

export class TextPanel extends THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private text = '';

  constructor(width: number, height: number, private readonly px = 512) {
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = Math.round((px * height) / width);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    super(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.texture = texture;
    this.renderOrder = 10;
  }

  set(text: string, opts: { bg?: string; fg?: string; size?: number; accent?: string } = {}) {
    const key = text + JSON.stringify(opts);
    if (key === this.text) return;
    this.text = key;
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height, r = h * 0.18;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = opts.bg ?? 'rgba(18,20,26,0.82)';
    ctx.beginPath();
    ctx.roundRect(2, 2, w - 4, h - 4, Math.min(r, 40));
    ctx.fill();
    if (opts.accent) {
      ctx.strokeStyle = opts.accent;
      ctx.lineWidth = 6;
      ctx.stroke();
    }
    const lines = text.split('\n');
    let size = opts.size ?? Math.min(h / (lines.length + 0.8), this.px / 14);
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    // Shrink the text until the widest line fits inside the padding.
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if (widest > w * 0.9) {
      size *= (w * 0.9) / widest;
      ctx.font = `600 ${size}px system-ui, sans-serif`;
    }
    ctx.fillStyle = opts.fg ?? '#f2f2f2';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 1.25));
    this.texture.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Toast: a panel that follows the head at a distance and fades out.

export class Toast {
  readonly panel = new TextPanel(0.36, 0.07, 768);
  private life = 0;
  constructor(scene: THREE.Scene) {
    this.panel.visible = false;
    scene.add(this.panel);
  }
  show(text: string, seconds = 2.5, accent?: string) {
    this.panel.set(text, { accent });
    this.life = seconds;
    this.panel.visible = true;
  }
  update(dt: number, head: THREE.Object3D) {
    if (!this.panel.visible) return;
    this.life -= dt;
    const target = new THREE.Vector3(0, -0.18, -0.7).applyMatrix4(head.matrixWorld);
    this.panel.position.lerp(target, Math.min(1, dt * 6));
    this.panel.lookAt(head.getWorldPosition(new THREE.Vector3()));
    this.panel.material.opacity = Math.min(1, this.life * 2);
    if (this.life <= 0) this.panel.visible = false;
  }
}

// ---------------------------------------------------------------------------
// Curved arrow for "this face turns clockwise / counterclockwise".

function arrowMesh(colour: THREE.Color) {
  const g = new THREE.Group();
  const r = PITCH * 1.05;
  const arc = Math.PI * 1.4;
  const torus = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0022, 6, 32, arc), additive(colour, 0.95));
  torus.rotation.z = Math.PI / 2 - arc; // arc ends at the top (angle 90°)
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.0065, 0.014, 12), additive(colour, 0.95));
  // The arc runs counterclockwise (seen from +Z) and ends at (0, r); the tip points along -X there.
  head.position.set(-0.004, r, 0);
  head.rotation.z = Math.PI / 2;
  g.add(torus, head);
  return g;
}

/**
 * Hover affordance for one hand: a glowing box around the layer that will turn,
 * and an arrow on its outer face in the direction that hand turns it.
 */
export class LayerHighlight {
  readonly group = new THREE.Group();
  private readonly slab: THREE.Mesh;
  private readonly edges: THREE.LineSegments;
  private readonly arrow: THREE.Group;
  private pulse = 0;

  constructor(readonly hand: Handedness) {
    const colour = HAND_COLOUR[hand];
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.slab = new THREE.Mesh(box, additive(colour, 0.14));
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.9 }));
    this.arrow = arrowMesh(colour);
    this.group.add(this.slab, this.edges, this.arrow);
    this.group.visible = false;
  }

  show(axis: Axis, layer: Layer, strength: number, dt: number) {
    this.group.visible = true;
    this.pulse += dt * 4;
    const pad = 1.06;
    const size = new THREE.Vector3(2 * HALF * pad, 2 * HALF * pad, 2 * HALF * pad);
    size.setComponent(axis, PITCH * 1.12);
    const centre = new THREE.Vector3();
    centre.setComponent(axis, layer * PITCH);
    this.slab.scale.copy(size);
    this.slab.position.copy(centre);
    this.edges.scale.copy(size);
    this.edges.position.copy(centre);
    (this.slab.material as THREE.MeshBasicMaterial).opacity = 0.1 + 0.2 * strength + 0.04 * Math.sin(this.pulse);

    // Arrow on the outer face: its +Z is the face normal.
    const normal = new THREE.Vector3().setComponent(axis, layer);
    this.arrow.position.copy(normal).multiplyScalar(HALF + 0.004);
    this.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    // Right hand: clockwise seen from outside, so mirror the counterclockwise arrow.
    this.arrow.scale.set(this.hand === 'right' ? -1 : 1, 1, 1).multiplyScalar(1 + 0.15 * strength);
  }

  hide() {
    this.group.visible = false;
  }
}

// ---------------------------------------------------------------------------
// Ray from the hand and the reticle where it hits, with a pinch-progress disc.

export class HandRay {
  readonly line: THREE.Line;
  readonly reticle = new THREE.Group();
  private readonly fill: THREE.Mesh;
  private readonly positions: Float32Array;

  constructor(readonly hand: Handedness) {
    const colour = HAND_COLOUR[hand];
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array([1, 1, 1, 1, 1, 1]), 3));
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
    this.line.frustumCulled = false;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.0075, 0.0095, 32), additive(colour, 1));
    this.fill = new THREE.Mesh(new THREE.CircleGeometry(0.0075, 32), additive(colour, 0.8));
    this.reticle.add(ring, this.fill);
    this.reticle.visible = false;
    this.line.visible = false;
  }

  /** `hit` null draws a short faint ray; otherwise a coloured ray to the hit and the reticle. */
  update(origin: THREE.Vector3, dir: THREE.Vector3, hit: { point: THREE.Vector3; normal: THREE.Vector3 } | null, pinch: number) {
    this.line.visible = true;
    const end = hit ? hit.point : origin.clone().addScaledVector(dir, 0.25);
    this.positions.set([origin.x, origin.y, origin.z, end.x, end.y, end.z]);
    this.line.geometry.attributes.position.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();
    const m = this.line.material as THREE.LineBasicMaterial;
    m.color.copy(hit ? HAND_COLOUR[this.hand] : new THREE.Color(0xffffff));
    m.opacity = hit ? 0.9 : 0.25;
    this.reticle.visible = !!hit;
    if (hit) {
      this.reticle.position.copy(hit.point).addScaledVector(hit.normal, 0.002);
      this.reticle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal);
      this.fill.scale.setScalar(Math.max(0.01, pinch));
    }
  }

  hide() {
    this.line.visible = false;
    this.reticle.visible = false;
  }
}

// ---------------------------------------------------------------------------
// Grab affordance: an outline box around the cube, plus a pinch ring at the fingers.

export class GrabBox {
  readonly box: THREE.LineSegments;
  constructor() {
    const s = 2 * HALF * 1.12;
    this.box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(s, s, s)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    this.box.renderOrder = 5;
  }
  /** state: 0 hidden, (0,1) a hand can grab (pinch progress), 'held' held by that hand. */
  update(state: { hand: Handedness; pinch: number; held: boolean } | null) {
    const m = this.box.material as THREE.LineBasicMaterial;
    if (!state) {
      m.opacity = Math.max(0, m.opacity - 0.08);
      this.box.visible = m.opacity > 0;
      return;
    }
    this.box.visible = true;
    m.color.copy(state.held ? HAND_COLOUR[state.hand] : new THREE.Color(0xffffff).lerp(HAND_COLOUR[state.hand], state.pinch));
    m.opacity = state.held ? 0.9 : 0.35 + 0.5 * state.pinch;
    this.box.scale.setScalar(state.held ? 1 : 1.04 - 0.04 * state.pinch);
  }
}

export class PinchRing {
  readonly mesh: THREE.Mesh;
  constructor(hand: Handedness) {
    this.mesh = new THREE.Mesh(new THREE.RingGeometry(0.009, 0.011, 32), additive(HAND_COLOUR[hand], 0.9));
    this.mesh.visible = false;
  }
  update(at: THREE.Vector3 | null, pinch: number, head: THREE.Vector3) {
    this.mesh.visible = !!at;
    if (!at) return;
    this.mesh.position.copy(at);
    this.mesh.lookAt(head);
    this.mesh.scale.setScalar(1.4 - 0.8 * pinch);
  }
}

// ---------------------------------------------------------------------------
// Drop marker: a pulsing ring on the table where the cube lands.

export class DropMarker {
  readonly mesh = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.058, 48), additive('#ffffff', 0.8));
  private t = 0;
  constructor() {
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.visible = false;
  }
  show(at: THREE.Vector3) {
    this.mesh.position.copy(at).y += 0.002;
    this.mesh.visible = true;
    this.t = 0;
  }
  update(dt: number, landed: boolean) {
    if (!this.mesh.visible) return;
    this.t += dt;
    const m = this.mesh.material as THREE.MeshBasicMaterial;
    this.mesh.scale.setScalar(1 + 0.15 * Math.sin(this.t * 6));
    if (landed) m.opacity = Math.max(0, m.opacity - dt * 1.5);
    else m.opacity = 0.8;
    if (m.opacity <= 0) this.mesh.visible = false;
  }
}
