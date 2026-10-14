// @vitest-environment happy-dom
/**
 * Regression tests: a recorded Transform's terminal state must be the
 * target's own rendered state (Block G, symptom S1).
 *
 * Root cause: segment start/end times are accumulated floats. With a
 * 1.0s Write followed by a 0.3s wait, the Transform segment starts at
 * 1.2999999999999998, so at the segment's end Animation.update()
 * computed elapsed = 0.9999999999999998 < duration and rawAlpha
 * stalled at 1 - epsilon: finish() -- the only place Transform
 * installs the target's exact points/colors -- never ran, in
 * playback or on seek. The end state stayed interpolate(1 - epsilon)
 * over the morph's aligned/resampled arrays: glyphs drawn from
 * resampled outlines (the VS2 "(a+c)" overplot blob, the VS1p2
 * identity-settle bolding). With binary-exact segment sums (a 0.5s
 * wait) the same scene settled crisp, which is what pinned the
 * mechanism. Animation.update() now snaps the final sliver of
 * elapsed time to the full duration.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Player } from './Player';
import { Animation } from '../animation/Animation';
import { MathTex } from '../mobjects/text/MathTex';
import { VMobject } from '../core/VMobject';
import { Transform } from '../animation/transform/Transform';
import { Write } from '../animation/creation/Create';
import { BLUE, ORANGE } from '../constants/colors';
import { buildEarcutFillGeometry } from '../core/VMobjectGeometry';

function createPlayer(): { player: Player; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const player = new Player(container, { width: 800, height: 450, headless: true });
  return { player, container };
}

async function tex(latex: string | string[]): Promise<MathTex> {
  const t = new MathTex({ latex, fontSize: 1 });
  await t.waitForRender();
  return t;
}

/** Per-leaf world-space signature: point count + weighted coordinate sum + colors. */
function worldSig(m: VMobject): string[] {
  return m
    .getFamily()
    .filter((x): x is VMobject => x instanceof VMobject && x.hasOwnPoints())
    .map((leaf) => {
      const wp = leaf.getPoints();
      const sum = wp.reduce((a, p) => a + p[0] + p[1] * 7 + p[2] * 13, 0).toFixed(6);
      return `n=${wp.length} wsum=${sum} c=${leaf.color.toLowerCase()} f=${(leaf.fillColor ?? '').toLowerCase()}`;
    });
}

/**
 * Visually exact: every rendered leaf matches some target leaf
 * exactly, and every target leaf is rendered. (A part-count-changing
 * morph legitimately keeps CE-style padding duplicates, which render
 * exactly on top of their target glyph.)
 */
function visuallyExact(end: string[], target: string[]): boolean {
  const tSet = new Set(target);
  const eSet = new Set(end);
  return end.every((s) => tSet.has(s)) && target.every((s) => eSet.has(s));
}

function playToEnd(player: Player): void {
  const tl = player.timeline;
  tl.seek(0);
  tl.play();
  let guard = 0;
  while (tl.getCurrentTime() < tl.getDuration() - 1e-9 && guard++ < 100000) {
    tl.update(1 / 60);
  }
}

const BEFORE = [
  '(a',
  '\\mathbf{u}',
  ' + b',
  '\\mathbf{v}',
  ')',
  ' + ',
  '(c',
  '\\mathbf{u}',
  ' + d',
  '\\mathbf{v}',
  ')',
];
const AFTER = ['(a+c)', '\\mathbf{u}', ' + ', '(b+d)', '\\mathbf{v}'];

async function buildSpanPair(): Promise<{ before: MathTex; after: MathTex }> {
  const before = await tex(BEFORE);
  before.setColorByTex('\\mathbf{u}', BLUE);
  before.setColorByTex('\\mathbf{v}', ORANGE);
  before.shift([0, 1.8, 0]);
  const after = await tex(AFTER);
  after.setColorByTex('\\mathbf{u}', BLUE);
  after.setColorByTex('\\mathbf{v}', ORANGE);
  after.shift([0, 1.8, 0]);
  return { before, after };
}

async function freshTargetSig(): Promise<string[]> {
  const ref = await tex(AFTER);
  ref.setColorByTex('\\mathbf{u}', BLUE);
  ref.setColorByTex('\\mathbf{v}', ORANGE);
  ref.shift([0, 1.8, 0]);
  return worldSig(ref as unknown as VMobject);
}

describe('Animation.update terminal snap (mechanism)', () => {
  class ProbeAnimation extends Animation<VMobject> {
    alphas: number[] = [];
    finishCount = 0;
    interpolate(alpha: number): void {
      this.alphas.push(alpha);
    }
    override finish(): void {
      this.finishCount++;
      super.finish();
    }
  }

  it('finishes when accumulated float error leaves elapsed a hair below duration', () => {
    const anim = new ProbeAnimation(new VMobject(), { duration: 1 });
    // The exact accumulation a [1.0s segment + 0.3s wait] prefix
    // produces for the next segment's start/end times.
    const startTime = 1 + 0.3;
    const endTime = startTime + 1;
    anim.startTime = startTime;
    anim.update(0, endTime);
    expect(anim.finishCount).toBe(1);
    expect(anim.isFinished()).toBe(true);
    expect(anim.alphas[anim.alphas.length - 1]).toBe(1);
  });
});

describe('recorded Transform end state (S1)', () => {
  let player: Player;
  let container: HTMLElement;
  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  it('seek(end) after a part-count-changing Transform equals the target render', async () => {
    const targetSig = await freshTargetSig();
    ({ player, container } = createPlayer());
    const { before, after } = await buildSpanPair();
    await player.sequence(async (scene) => {
      await scene.play(new Write(before));
      await scene.wait(0.3);
      await scene.play(new Transform(before, after));
    });
    player.timeline.seek(player.timeline.getDuration());
    expect(visuallyExact(worldSig(before as unknown as VMobject), targetSig)).toBe(true);
  });

  it('playing to the end lands on the same exact target state', async () => {
    const targetSig = await freshTargetSig();
    ({ player, container } = createPlayer());
    const { before, after } = await buildSpanPair();
    await player.sequence(async (scene) => {
      await scene.play(new Write(before));
      await scene.wait(0.3);
      await scene.play(new Transform(before, after));
    });
    playToEnd(player);
    expect(visuallyExact(worldSig(before as unknown as VMobject), targetSig)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Block G round 2: full recursive end-state fidelity.
//
// The signature tests above compare per-leaf point count + a weighted
// coordinate sum + colors. That set is blind to a leaf's RENDER
// TOPOLOGY: how its points partition into subpaths (outer rings and
// holes), which the fill builder reads from
// getEffectiveSubpathLengths(). On the live board the S1-fixed scene
// still ended with the "(a+c)" glyph as a filled blob while every
// signature matched: the terminal leaves carried the target's exact
// points, but with no (or the wrong) subpath lengths, so the fill
// builder fell back to a single ring and filled the glyph's counter.
// Points/colors/structure equality is therefore NOT end-state
// equality. The tests below assert the full recursive state --
// points, transforms (via world points), styles, AND subpath
// topology -- plus the fill geometry the renderer builds from that
// state, using the board scene's own construction (default font
// size, the short Write -> wait(0.3) -> Transform -> wait(0.3)
// segment shape that blobbed identically on the board).
//
// Note on local points: a leaf-paired morph's terminal leaves hold
// their points in the strategy's normalized frame (their positions
// compensate), so local points legitimately differ from a standalone
// fresh render's. The render-relevant invariant is world points +
// style + topology, and the world-space fill geometry built from
// them -- which is what is asserted here.
// ---------------------------------------------------------------------

async function texFullSize(latex: string | string[]): Promise<MathTex> {
  const t = new MathTex({ latex });
  await t.waitForRender();
  return t;
}

async function buildSpanPairFullSize(): Promise<{ before: MathTex; after: MathTex }> {
  const before = await texFullSize(BEFORE);
  before.setColorByTex('\\mathbf{u}', BLUE);
  before.setColorByTex('\\mathbf{v}', ORANGE);
  before.shift([0, 1.8, 0]);
  const after = await texFullSize(AFTER);
  after.setColorByTex('\\mathbf{u}', BLUE);
  after.setColorByTex('\\mathbf{v}', ORANGE);
  after.shift([0, 1.8, 0]);
  return { before, after };
}

async function freshTargetFullSize(): Promise<MathTex> {
  const ref = await texFullSize(AFTER);
  ref.setColorByTex('\\mathbf{u}', BLUE);
  ref.setColorByTex('\\mathbf{v}', ORANGE);
  ref.shift([0, 1.8, 0]);
  return ref;
}

const r9 = (v: number): number => Math.round(v * 1e9) / 1e9;
const ptsKey = (pts: number[][]): string => JSON.stringify(pts.map((p) => p.map(r9)));

interface LeafFull {
  leaf: VMobject;
  worldKey: string;
  localKey: string;
  sub: number[] | undefined;
  style: string;
}

function fullLeaves(m: VMobject): LeafFull[] {
  return m
    .getFamily()
    .filter((x): x is VMobject => x instanceof VMobject && x.hasOwnPoints())
    .map((leaf) => ({
      leaf,
      worldKey: ptsKey(leaf.getPoints()),
      localKey: ptsKey(leaf.getLocalPoints()),
      sub: leaf.getEffectiveSubpathLengths(),
      style: `${leaf.color.toLowerCase()}|${(leaf.fillColor ?? '').toLowerCase()}|${leaf.opacity}|${leaf.fillOpacity}|${leaf.strokeWidth}`,
    }));
}

/**
 * Full recursive end-state equality: every end leaf must match a fresh
 * target leaf on world points, style, and subpath topology; every
 * fresh leaf must be rendered. (Padding duplicates are admitted, as
 * in visuallyExact, but a duplicate must match on ALL fields --
 * including the topology it renders with.)
 */
function fullStateDivergences(endRoot: VMobject, freshRoot: VMobject): string[] {
  const end = fullLeaves(endRoot);
  const fresh = fullLeaves(freshRoot);
  const out: string[] = [];
  for (const e of end) {
    const cands = fresh.filter((f) => f.worldKey === e.worldKey);
    if (cands.length === 0) {
      out.push(
        `end leaf (n=${e.leaf.getLocalPoints().length}) has no fresh leaf with equal world points`,
      );
      continue;
    }
    const match = cands.find(
      (f) => f.style === e.style && JSON.stringify(f.sub ?? null) === JSON.stringify(e.sub ?? null),
    );
    if (!match) {
      const f = cands[0];
      out.push(
        `end leaf (n=${e.leaf.getLocalPoints().length}) matches a fresh leaf on world points but diverges: ` +
          `subpathLengths end=${JSON.stringify(e.sub)} fresh=${JSON.stringify(f.sub)}, ` +
          `styleEqual=${f.style === e.style}`,
      );
    }
  }
  const endWorld = new Set(end.map((e) => e.worldKey));
  for (const f of fresh) {
    if (!endWorld.has(f.worldKey)) {
      out.push(`fresh leaf (n=${f.leaf.getLocalPoints().length}) is not rendered at the end state`);
    }
  }
  return out;
}

/**
 * The leaf's fill triangles in WORLD space. The renderer builds them
 * from local points + the leaf's effective subpath lengths and places
 * them under the leaf's world transform; Bezier sampling and earcut
 * are affine-covariant, so building from the world control points
 * with the same lengths yields the rendered triangles.
 */
function worldFillTriangles(leaf: VMobject): [number, number][][] {
  const eff = leaf.getEffectiveSubpathLengths();
  const geom = buildEarcutFillGeometry(
    leaf.getPoints(),
    leaf.getVisiblePoints(),
    eff ? () => eff : undefined,
  );
  if (!geom) return [];
  const pos = geom.getAttribute('position');
  const tris: [number, number][][] = [];
  for (let i = 0; i + 2 < pos.count; i += 3) {
    const tri: [number, number][] = [];
    for (let k = 0; k < 3; k++) tri.push([pos.getX(i + k), pos.getY(i + k)]);
    tris.push(tri);
  }
  return tris;
}

function fillArea(tris: [number, number][][]): number {
  let a = 0;
  for (const [p, q, r] of tris)
    a += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / 2;
  return a;
}

function pointInTriangle(px: number, py: number, t: [number, number][]): boolean {
  const [a, b, c] = t;
  const s = (p: [number, number], q: [number, number], r: [number, number]): number =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = s([px, py], a, b);
  const d2 = s([px, py], b, c);
  const d3 = s([px, py], c, a);
  const neg = d1 < -1e-12 || d2 < -1e-12 || d3 < -1e-12;
  const pos = d1 > 1e-12 || d2 > 1e-12 || d3 > 1e-12;
  return !(neg && pos);
}

function coveredBy(tris: [number, number][][], px: number, py: number): boolean {
  return tris.some((t) => pointInTriangle(px, py, t));
}

function distToSegment(px: number, py: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function distToEdges(tris: [number, number][][], px: number, py: number): number {
  let d = Infinity;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) d = Math.min(d, distToSegment(px, py, t[k], t[(k + 1) % 3]));
  }
  return d;
}

/** Centroid of a leaf's second subpath (the counter/hole ring), world space. */
function worldHoleCentroid(leaf: VMobject): [number, number] {
  const sub = leaf.getEffectiveSubpathLengths();
  if (!sub || sub.length < 2) throw new Error('worldHoleCentroid: leaf has no hole subpath');
  const ring = leaf.getPoints().slice(sub[0], sub[0] + sub[1]);
  const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
  const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  return [cx, cy];
}

describe('recorded Transform end state -- full recursive state (Block G round 2)', () => {
  let player: Player;
  let container: HTMLElement;
  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  async function recordSpanMorph(): Promise<MathTex> {
    ({ player, container } = createPlayer());
    const { before, after } = await buildSpanPairFullSize();
    await player.sequence(async (scene) => {
      await scene.play(new Write(before));
      await scene.wait(0.3);
      await scene.play(new Transform(before, after));
      await scene.wait(0.3);
    });
    return before;
  }

  it('seek(end): full recursive state (points, styles, subpath topology) equals the target render', async () => {
    const fresh = await freshTargetFullSize();
    const before = await recordSpanMorph();
    player.timeline.seek(player.timeline.getDuration());
    expect(
      fullStateDivergences(before as unknown as VMobject, fresh as unknown as VMobject),
    ).toEqual([]);
  });

  it('played-to-end: full recursive state equals the target render', async () => {
    const fresh = await freshTargetFullSize();
    const before = await recordSpanMorph();
    playToEnd(player);
    expect(
      fullStateDivergences(before as unknown as VMobject, fresh as unknown as VMobject),
    ).toEqual([]);
  });

  it('fill geometry: compound glyphs keep their counters open at the end state', async () => {
    const fresh = await freshTargetFullSize();
    const before = await recordSpanMorph();
    player.timeline.seek(player.timeline.getDuration());
    const endLeaves = fullLeaves(before as unknown as VMobject);
    const freshLeaves = fullLeaves(fresh as unknown as VMobject);
    // Every compound (multi-subpath) fresh glyph -- a, b, d in this
    // scene -- must be rendered by an end leaf whose world-space fill
    // is the fresh leaf's: same area, same coverage on a probe grid,
    // counter left open. Pre-fix, the "a" and "b" end leaves carried
    // the target's exact points but rendered them as one filled ring:
    // larger area, counter covered -- the blob.
    const compound = freshLeaves.filter((f) => (f.sub?.length ?? 0) > 1);
    expect(compound.length).toBeGreaterThanOrEqual(3);
    for (const f of compound) {
      const e = endLeaves.find((x) => x.worldKey === f.worldKey);
      expect(e, 'compound fresh leaf has an end counterpart').toBeDefined();
      const endTris = worldFillTriangles(e!.leaf);
      const freshTris = worldFillTriangles(f.leaf);
      expect(Math.abs(fillArea(endTris) - fillArea(freshTris))).toBeLessThanOrEqual(
        fillArea(freshTris) * 1e-6,
      );
      const [hx, hy] = worldHoleCentroid(f.leaf);
      expect(coveredBy(freshTris, hx, hy)).toBe(false);
      expect(coveredBy(endTris, hx, hy)).toBe(false);
      // Probe grid over the glyph bbox: coverage must agree everywhere
      // not too close to an edge of either triangulation.
      const wp = f.leaf.getPoints();
      const xs = wp.map((p) => p[0]);
      const ys = wp.map((p) => p[1]);
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      let probed = 0;
      for (let i = 0; i <= 8; i++) {
        for (let j = 0; j <= 8; j++) {
          const px = x0 + ((x1 - x0) * i) / 8;
          const py = y0 + ((y1 - y0) * j) / 8;
          if (distToEdges(endTris, px, py) < 1e-4 || distToEdges(freshTris, px, py) < 1e-4)
            continue;
          probed++;
          expect(coveredBy(endTris, px, py)).toBe(coveredBy(freshTris, px, py));
        }
      }
      expect(probed).toBeGreaterThan(40);
    }
  });
});
