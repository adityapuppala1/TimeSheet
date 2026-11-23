/**
 * WHAT: the lines that show agents working TOGETHER — glowing arcs between two points with packets
 * travelling along them. Two kinds share one pool:
 *   - hand-offs between specialists' rooms (office-model.ts `activeFlows`): drawn only while the
 *     upstream agent has a REAL run, so a moving packet always means live work;
 *   - conversations (a chat at a desk, a stand-up): a short, soft arc between the people talking —
 *     office life, the same idle ambience the feed labels "Idle".
 *
 * COST: a fixed pool of 8 arcs, each one line (24 segments) plus three packet sprites. Arcs not in use
 * are hidden; geometry is rewritten only when an arc's endpoints change.
 */
import * as THREE from "three";

const POOL = 8;
const SEGMENTS = 24;
const PACKETS = 3;

export interface ArcSpec {
  key: string;
  from: THREE.Vector3;
  to: THREE.Vector3;
  color: number;
  /** Arc height above the higher end (m). */
  lift: number;
  /** 0..1 — dimmer for ambience, brighter for a live hand-off. */
  strength: number;
  /** Packets travel both ways (a conversation) rather than from → to (a hand-off). */
  twoWay: boolean;
}

interface Slot {
  line: THREE.Line;
  geo: THREE.BufferGeometry;
  mat: THREE.LineBasicMaterial;
  packets: THREE.Sprite[];
  packetMat: THREE.SpriteMaterial;
  curve: THREE.QuadraticBezierCurve3;
  key: string | null;
  fade: number;
  spec: ArcSpec | null;
}

export interface Flows {
  group: THREE.Group;
  /** The arcs that should exist now (at most 8; extras are dropped). */
  set(specs: readonly ArcSpec[]): void;
  /** Per frame. Returns true while anything is visible. */
  update(t: number, dt: number): boolean;
  dispose(): void;
}

function dotTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.8)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
  }
  return new THREE.CanvasTexture(canvas);
}

export function createFlows(): Flows {
  const group = new THREE.Group();
  const dot = dotTexture();
  const slots: Slot[] = [];
  for (let i = 0; i < POOL; i += 1) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3));
    const mat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending });
    const line = new THREE.Line(geo, mat);
    line.visible = false;
    line.frustumCulled = false;
    line.renderOrder = 5;
    const packetMat = new THREE.SpriteMaterial({ map: dot, transparent: true, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending });
    const packets = Array.from({ length: PACKETS }, () => {
      const s = new THREE.Sprite(packetMat);
      s.scale.setScalar(0.32);
      s.visible = false;
      s.renderOrder = 6;
      group.add(s);
      return s;
    });
    group.add(line);
    slots.push({ line, geo, mat, packets, packetMat, curve: new THREE.QuadraticBezierCurve3(), key: null, fade: 0, spec: null });
  }

  function shape(slot: Slot, spec: ArcSpec) {
    const mid = spec.from.clone().lerp(spec.to, 0.5);
    mid.y = Math.max(spec.from.y, spec.to.y) + spec.lift;
    slot.curve.v0.copy(spec.from);
    slot.curve.v1.copy(mid);
    slot.curve.v2.copy(spec.to);
    const pos = slot.geo.getAttribute("position") as THREE.BufferAttribute;
    const p = new THREE.Vector3();
    for (let i = 0; i <= SEGMENTS; i += 1) {
      slot.curve.getPoint(i / SEGMENTS, p);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    slot.mat.color.setHex(spec.color);
    slot.packetMat.color.setHex(spec.color);
  }

  return {
    group,
    set(specs) {
      const wanted = new Map(specs.slice(0, POOL).map((s) => [s.key, s]));
      // Keep slots whose arc still exists; release the rest to fade out.
      for (const slot of slots) {
        const spec = slot.key ? wanted.get(slot.key) : undefined;
        if (spec) {
          if (!slot.spec || !slot.spec.from.equals(spec.from) || !slot.spec.to.equals(spec.to)) shape(slot, spec);
          slot.spec = spec;
          wanted.delete(spec.key);
        } else slot.key = null;
      }
      for (const spec of wanted.values()) {
        const free = slots.find((s) => s.key === null && s.fade < 0.02) ?? slots.find((s) => s.key === null);
        if (!free) break;
        free.key = spec.key;
        free.spec = spec;
        shape(free, spec);
      }
    },
    update(t, dt) {
      let any = false;
      for (const [i, slot] of slots.entries()) {
        const want = slot.key ? 1 : 0;
        slot.fade += (want - slot.fade) * Math.min(1, dt * 4);
        const on = slot.fade > 0.01 && slot.spec !== null;
        slot.line.visible = on;
        for (const p of slot.packets) p.visible = on;
        if (!on || !slot.spec) continue;
        any = true;
        const strength = slot.spec.strength * slot.fade;
        slot.mat.opacity = 0.25 + strength * 0.45;
        slot.packetMat.opacity = strength;
        slot.packets.forEach((p, k) => {
          let u = (t * 0.32 + k / PACKETS + i * 0.13) % 1;
          if (slot.spec?.twoWay && k % 2 === 1) u = 1 - u;
          slot.curve.getPoint(u, p.position);
          p.scale.setScalar(0.22 + strength * 0.16);
        });
      }
      return any;
    },
    dispose() {
      for (const slot of slots) {
        slot.geo.dispose();
        slot.mat.dispose();
        slot.packetMat.dispose();
      }
      dot.dispose();
    }
  };
}
