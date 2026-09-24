import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

interface TrackedPlane {
  changed: number;
  collider: RAPIER.Collider;
  shadow: THREE.Mesh;
  label?: string;
  centre: THREE.Vector3;
  quat: THREE.Quaternion;
  half: THREE.Vector2;
  area: number;
}

export interface Surface {
  centre: THREE.Vector3;
  quat: THREE.Quaternion;
  half: THREE.Vector2;
  label?: string;
}

/**
 * Turns the headset's detected horizontal planes (Space Setup) into static
 * physics colliders and shadow catchers. Picks the table to spawn on.
 */
export class Surfaces {
  private readonly planes = new Map<XRPlane, TrackedPlane>();
  private readonly shadowMat = new THREE.ShadowMaterial({ opacity: 0.35 });
  /** Fallback floor at y = 0 of local-floor, removed once the headset reports a floor plane. */
  private fallbackFloor: RAPIER.Collider | null;

  constructor(private readonly R: typeof RAPIER, private readonly world: RAPIER.World, private readonly scene: THREE.Scene) {
    this.fallbackFloor = world.createCollider(R.ColliderDesc.cuboid(20, 0.05, 20).setTranslation(0, -0.05, 0));
  }

  /** Height of the floor: the detected floor plane, else y = 0. */
  get floorY() {
    for (const t of this.planes.values()) if (t.label === 'floor') return t.centre.y;
    return 0;
  }

  get count() {
    return this.planes.size;
  }

  update(frame: XRFrame, ref: XRReferenceSpace) {
    const detected: XRPlaneSet | undefined = frame.detectedPlanes;
    if (!detected) return;
    for (const [plane, t] of this.planes) {
      if (!detected.has(plane)) {
        this.world.removeCollider(t.collider, false);
        this.scene.remove(t.shadow);
        this.planes.delete(plane);
      }
    }
    for (const plane of detected) {
      if (plane.orientation !== 'horizontal') continue;
      const label = (plane as XRPlane & { semanticLabel?: string }).semanticLabel;
      if (label === 'ceiling') continue;
      const known = this.planes.get(plane);
      if (known && known.changed === plane.lastChangedTime) continue;
      const pose = frame.getPose(plane.planeSpace, ref);
      if (!pose) continue;
      if (known) {
        this.world.removeCollider(known.collider, false);
        this.scene.remove(known.shadow);
      }
      // Bounding box of the polygon in plane space (x, z; y is the plane normal).
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of plane.polygon) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const quat = new THREE.Quaternion().setFromRotationMatrix(m);
      const centre = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2).applyMatrix4(m);
      const half = new THREE.Vector2((maxX - minX) / 2, (maxZ - minZ) / 2);
      const thick = 0.02;
      const below = centre.clone().add(new THREE.Vector3(0, -thick, 0).applyQuaternion(quat));
      const collider = this.world.createCollider(
        this.R.ColliderDesc.cuboid(half.x, thick, half.y)
          .setTranslation(below.x, below.y, below.z)
          .setRotation(quat)
          .setFriction(0.9)
          .setRestitution(0.2),
      );
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(half.x * 2, half.y * 2), this.shadowMat);
      shadow.receiveShadow = true;
      shadow.position.copy(centre).add(new THREE.Vector3(0, 0.0005, 0));
      shadow.quaternion.copy(quat).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)));
      this.scene.add(shadow);
      this.planes.set(plane, { changed: plane.lastChangedTime, collider, shadow, label, centre, quat, half, area: half.x * half.y * 4 });
      if (label === 'floor' && this.fallbackFloor) {
        this.world.removeCollider(this.fallbackFloor, false);
        this.fallbackFloor = null;
      }
    }
  }

  /**
   * The surface to spawn on: a plane labelled "table" if there is one, else a
   * horizontal plane at table height (0.4–1.3 m). The nearest to `head` wins.
   */
  pickTable(head: THREE.Vector3): Surface | null {
    let best: TrackedPlane | null = null;
    let bestScore = Infinity;
    const floor = this.floorY;
    for (const t of this.planes.values()) {
      const isTable = t.label === 'table';
      const h = t.centre.y - floor;
      const tableHeight = h > 0.4 && h < 1.3 && t.area > 0.08 && t.label !== 'floor';
      if (!isTable && !tableHeight) continue;
      const score = t.centre.distanceTo(head) - (isTable ? 10 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best && { centre: best.centre, quat: best.quat, half: best.half, label: best.label };
  }
}

/** The point on `s` nearest to `from`, at least `margin` inside its edge. */
export function spawnPointOn(s: Surface, from: THREE.Vector3, margin = 0.12) {
  const inv = s.quat.clone().invert();
  const local = from.clone().sub(s.centre).applyQuaternion(inv);
  local.x = THREE.MathUtils.clamp(local.x, -Math.max(0, s.half.x - margin), Math.max(0, s.half.x - margin));
  local.z = THREE.MathUtils.clamp(local.z, -Math.max(0, s.half.y - margin), Math.max(0, s.half.y - margin));
  local.y = 0;
  return local.applyQuaternion(s.quat).add(s.centre);
}
