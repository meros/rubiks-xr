import * as THREE from 'three';
import { TextPanel, HAND_COLOUR } from './ui';

interface Button {
  id: string;
  label: string;
  panel: TextPanel;
  base: THREE.Vector3;
  armed: boolean;
  lit: number;
}

const W = 0.075, H = 0.024, GAP = 0.006, TRAVEL = 0.008;

/**
 * Wrist menu on the left hand. It shows when the left palm faces the head.
 * The right index finger presses a button by poking through its face.
 */
export class WristMenu {
  readonly group = new THREE.Group();
  private readonly buttons: Button[] = [];
  private readonly title = new TextPanel(W, 0.014, 512);
  private shown = 0;
  onPress?: (id: string) => void;

  constructor(items: { id: string; label: string }[]) {
    this.title.set('Palm menu · poke to press', { bg: 'rgba(0,0,0,0)', fg: '#cfd6e0' });
    this.title.position.y = (items.length * (H + GAP)) / 2 + 0.006;
    this.group.add(this.title);
    items.forEach((it, i) => {
      const panel = new TextPanel(W, H, 512);
      panel.set(it.label);
      const base = new THREE.Vector3(0, ((items.length - 1) / 2 - i) * (H + GAP) - 0.004, 0);
      panel.position.copy(base);
      this.group.add(panel);
      this.buttons.push({ id: it.id, label: it.label, panel, base, armed: true, lit: 0 });
    });
    this.group.visible = false;
    this.group.scale.setScalar(0.001);
  }

  get visible() {
    return this.shown > 0.5;
  }

  /**
   * palm: the centre of the left palm, palmNormal: out of the palm, head: the
   * viewer. finger: the right index tip, or null.
   */
  update(dt: number, palm: THREE.Vector3 | null, palmNormal: THREE.Vector3 | null, head: THREE.Vector3, finger: THREE.Vector3 | null) {
    const facing = palm && palmNormal ? palmNormal.dot(head.clone().sub(palm).normalize()) : -1;
    const target = facing > 0.55 ? 1 : 0;
    this.shown += (target - this.shown) * Math.min(1, dt * 12);
    this.group.visible = this.shown > 0.02;
    this.group.scale.setScalar(Math.max(0.001, this.shown));
    if (!this.group.visible || !palm || !palmNormal) return;

    const pos = palm.clone().addScaledVector(palmNormal, 0.05).add(new THREE.Vector3(0, 0.03, 0));
    this.group.position.lerp(pos, Math.min(1, dt * 20));
    this.group.lookAt(head);
    this.group.updateMatrixWorld();

    const inv = this.group.matrixWorld.clone().invert();
    const tip = finger ? finger.clone().applyMatrix4(inv) : null;
    for (const b of this.buttons) {
      // The group's +Z faces the head, so a finger that presses moves toward -Z.
      const inside = !!tip && Math.abs(tip.x - b.base.x) < W / 2 && Math.abs(tip.y - b.base.y) < H / 2;
      const depth = inside && tip!.z > -0.03 ? THREE.MathUtils.clamp(0.004 - tip!.z, 0, TRAVEL) : 0;
      b.panel.position.z = -depth;
      const hovered = inside && tip!.z < 0.03 && tip!.z > -0.03;
      if (b.armed && depth >= TRAVEL * 0.8) {
        b.armed = false;
        b.lit = 1;
        this.onPress?.(b.id);
      }
      if (!b.armed && (!tip || tip.z > 0.015 || !inside)) b.armed = true;
      b.lit = Math.max(0, b.lit - dt * 3);
      const accent = b.lit > 0 ? '#' + HAND_COLOUR.right.getHexString() : hovered ? '#ffffff' : undefined;
      b.panel.set(b.label, { accent, bg: b.lit > 0 ? 'rgba(40,110,140,0.9)' : undefined });
    }
  }
}
