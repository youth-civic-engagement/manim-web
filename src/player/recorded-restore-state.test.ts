// @vitest-environment happy-dom
/**
 * Regression tests: Animation.reset() must restore the WHOLE recorded
 * state (Block G, symptoms S2 + S3).
 *
 * Two related gaps in the old restore walk, both in
 * Animation.ts's snapshot machinery:
 *
 * (S2) reset() restored the root's transform/style and per-node
 * POINTS, but no per-node styles or child transforms. A Transform's
 * interpolate()/finish() writes the target's per-leaf colors onto
 * the source's leaves; after any play (or seek to the end), seeking
 * back to the source's pre-Transform parked state showed the
 * target's colors on the source's glyphs (VS4: color spans bleeding
 * across part boundaries; VS4b: both parts in the target's colors).
 *
 * (S3) The child bookkeeping (captureChildIdentities /
 * restorePointsFromSnapshot) descended only through VMobject
 * children. A NumberPlane's grid lines live under a plain Group;
 * that subtree was never restored, so after a recorded ApplyMatrix
 * a seek to 0 left the lines transformed, and the next begin()
 * re-captured the corrupted points as its start state — the
 * corruption compounded across scrub cycles (VS3). Animations on a
 * plain (non-VMobject) root got no point restore at all.
 *
 * The restore walk now covers the full subtree (all children, any
 * node type) and restores every node's transform + style from the
 * snapshot alongside its points.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Player } from './Player';
import { MathTex } from '../mobjects/text/MathTex';
import { VMobject } from '../core/VMobject';
import { VGroup } from '../core/VGroup';
import { Group } from '../core/Group';
import { Mobject } from '../core/Mobject';
import { Transform } from '../animation/transform/Transform';
import { ApplyMatrix } from '../animation/transform/ApplyTransforms';
import { NumberPlane } from '../mobjects/graphing/NumberPlane';
import { Line } from '../mobjects/geometry/Line';
import { BLUE, ORANGE } from '../constants/colors';
import { Write } from '../animation/creation/Create';
import { Timeline } from '../animation/Timeline';
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

function leaves(m: Mobject): VMobject[] {
  return m.getFamily().filter((x): x is VMobject => x instanceof VMobject && x.hasOwnPoints());
}

/** Ordered per-leaf state: point count + local coordinate sum + colors. */
function leafStateSig(m: Mobject): string[] {
  return leaves(m).map((leaf) => {
    const lp = leaf.getLocalPoints();
    const sum = lp.reduce((a, p) => a + p[0] + p[1] * 7 + p[2] * 13, 0).toFixed(6);
    return `n=${lp.length} sum=${sum} c=${leaf.color.toLowerCase()} f=${(leaf.fillColor ?? '').toLowerCase()} pos=${leaf.position.x.toFixed(4)},${leaf.position.y.toFixed(4)}`;
  });
}

/** Ordered per-leaf local points, exactly (rounded for float noise). */
function leafPointsJson(m: Mobject): string {
  return JSON.stringify(
    leaves(m).map((leaf) =>
      leaf.getLocalPoints().map((p) => p.map((v) => Math.round(v * 1e9) / 1e9)),
    ),
  );
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

describe('recorded restore — parked-state colors (S2)', () => {
  let player: Player;
  let container: HTMLElement;
  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  it("seeking back to a colored Transform source's parked state returns its authored colors", async () => {
    ({ player, container } = createPlayer());
    const src = await tex(['\\mathbf{e}_1', '+', '\\mathbf{e}_2']);
    src.setColorByTex('\\mathbf{e}_1', BLUE);
    src.setColorByTex('\\mathbf{e}_2', BLUE);
    const tgt = await tex(['\\mathbf{v}']);
    tgt.setColorByTex('\\mathbf{v}', ORANGE);
    const authored = leafStateSig(src);
    await player.sequence(async (scene) => {
      scene.add(src);
      await scene.wait(0.5);
      await scene.play(new Transform(src, tgt));
    });
    // Pollute via a full play first (finish() writes target styles
    // onto the source's leaves), then seek back to the parked state.
    playToEnd(player);
    player.timeline.seek(0.25);
    expect(leafStateSig(src)).toEqual(authored);
    // Same after a seek to the end (no play): reconstruction must
    // also restore the parked state exactly.
    player.timeline.seek(player.timeline.getDuration());
    player.timeline.seek(0.25);
    expect(leafStateSig(src)).toEqual(authored);
  });
});

describe('recorded restore — nested subtree points (S3)', () => {
  let player: Player;
  let container: HTMLElement;
  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  const M = [
    [1.5, 0.5, 0],
    [0.5, 1.5, 0],
    [0, 0, 1],
  ];

  function buildPlaneGroup(): VGroup {
    const plane = new NumberPlane({ xRange: [-2, 2, 1], yRange: [-2, 2, 1] });
    const group = new VGroup();
    group.add(plane as unknown as VMobject);
    return group;
  }

  it('a recorded ApplyMatrix over a NumberPlane group survives a scrub cycle byte-exact', async () => {
    ({ player, container } = createPlayer());
    const group = buildPlaneGroup();
    const pristine = leafPointsJson(group);
    await player.sequence(async (scene) => {
      scene.add(group);
      await scene.play(new ApplyMatrix(group as unknown as VMobject, { matrix: M }));
    });
    const dur = player.timeline.getDuration();
    player.timeline.seek(dur);
    const end1 = leafPointsJson(group);
    expect(end1).not.toEqual(pristine);
    // Reference: the same matrix applied live, with no recorder.
    const live = buildPlaneGroup();
    const liveAnim = new ApplyMatrix(live as unknown as VMobject, { matrix: M });
    liveAnim.begin();
    liveAnim.interpolate(1);
    liveAnim.finish();
    expect(end1).toEqual(leafPointsJson(live));
    // Scrub to 0: the whole plane, grid lines included, is pristine.
    player.timeline.seek(0);
    expect(leafPointsJson(group)).toEqual(pristine);
    // Scrub back to the end: identical to the first end (no compounding).
    player.timeline.seek(dur);
    expect(leafPointsJson(group)).toEqual(end1);
  });

  it('bare begin/finish/reset restores the plane exactly (no Player)', () => {
    const group = buildPlaneGroup();
    const pristine = leafPointsJson(group);
    const anim = new ApplyMatrix(group as unknown as VMobject, { matrix: M });
    anim.begin();
    anim.interpolate(1);
    anim.finish();
    expect(leafPointsJson(group)).not.toEqual(pristine);
    anim.reset();
    expect(leafPointsJson(group)).toEqual(pristine);
  });

  it('reset restores points under plain Group containers, incl. a plain-Group root', () => {
    const inner = new Group();
    inner.add(new Line({ start: [-1, -1, 0], end: [1, -1, 0] }));
    inner.add(new Line({ start: [-1, 1, 0], end: [1, 1, 0] }));
    const outer = new Group();
    outer.add(inner);
    outer.add(new Line({ start: [0, -2, 0], end: [0, 2, 0] }));
    const pristine = leafPointsJson(outer);
    const anim = new ApplyMatrix(outer as unknown as Mobject, { matrix: M });
    anim.begin();
    anim.interpolate(1);
    anim.finish();
    expect(leafPointsJson(outer)).not.toEqual(pristine);
    anim.reset();
    expect(leafPointsJson(outer)).toEqual(pristine);
  });
});

// ---------------------------------------------------------------------------
// Block G round 3: the parked (pre-Transform) state must restore the
// source's OWN subpath topology, not just its points and colors.
//
// The S2 suite above asserted parked points/colors; round 2 asserted the
// Transform END state's full recursive state. Neither looked at the
// begin state of a glyph-CHANGING morph under seek. On the board, the
// VS4b status-line pattern -- a multi-part MathTex whose one part
// changes glyph (e1 -> v1) used as a Transform source -- parks with the
// changed glyph's counter FILLED: the parked "e" carries its own 47
// points and its own blue, but renders as a single ring.
//
// Mechanism (probe-verified on the round-2 tip): PointMorphStrategy
// .finish() installs the target leaf's partition on the source leaf --
// setTransformSubpathLengths(finalTargetSubpathLengths) -- which is
// correct for the end state, whose points ARE the target's. But
// Animation.reset()'s restore walk puts back transform, style and
// points only; the transform subpath-length override captured in the
// begin() snapshot is never restored, so the finish()-installed target
// partition ([58], the "v") survives onto the restored source points
// (47 points). The sum guard in getEffectiveSubpathLengths() then
// returns undefined -- "no topology" -- and the fill builder draws the
// glyph as one filled ring. Pre-round-2 this rendered crisp only by
// accident: finish() then installed undefined (copy() had dropped the
// target's base lengths), which cleared the override and let the parked
// state fall back to the leaf's own base lengths.
// ---------------------------------------------------------------------------

const PARKED_BEFORE = ['\\{', '\\mathbf{e}_1', ', ', '\\mathbf{e}_2', ', ', '\\mathbf{s}', '\\}'];
const PARKED_AFTER = ['\\{', '\\mathbf{v}_1', ', ', '\\mathbf{e}_2', ', ', '\\mathbf{s}', '\\}'];

async function buildGlyphPair(): Promise<{ before: MathTex; after: MathTex }> {
  const before = new MathTex({ latex: PARKED_BEFORE });
  await before.waitForRender();
  before.setColorByTex('\\mathbf{e}_1', BLUE);
  before.setColorByTex('\\mathbf{e}_2', BLUE);
  before.shift([0, 0.8, 0]);
  const after = new MathTex({ latex: PARKED_AFTER });
  await after.waitForRender();
  after.setColorByTex('\\mathbf{v}_1', ORANGE);
  after.setColorByTex('\\mathbf{e}_2', BLUE);
  after.shift([0, 0.8, 0]);
  return { before, after };
}

function rawOverride(leaf: VMobject): number[] | undefined {
  return (leaf as unknown as { _transformSubpathLengths?: number[] })._transformSubpathLengths;
}

const r9 = (v: number): number => Math.round(v * 1e9) / 1e9;

/** Ordered per-leaf full state: world points + style + effective topology. */
function fullLeafSig(m: VMobject): string[] {
  return leaves(m).map(
    (leaf) =>
      `${JSON.stringify(leaf.getPoints().map((p) => p.map(r9)))}|${leaf.color.toLowerCase()}|` +
      `${(leaf.fillColor ?? '').toLowerCase()}|${leaf.opacity}|${leaf.fillOpacity}|` +
      `${JSON.stringify(leaf.getEffectiveSubpathLengths() ?? null)}`,
  );
}

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

/** Centroid of a leaf's second subpath (the counter/hole ring), world space. */
function worldHoleCentroid(leaf: VMobject): [number, number] {
  const sub = leaf.getEffectiveSubpathLengths();
  if (!sub || sub.length < 2) throw new Error('worldHoleCentroid: leaf has no hole subpath');
  const ring = leaf.getPoints().slice(sub[0], sub[0] + sub[1]);
  const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
  const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  return [cx, cy];
}

describe('recorded restore -- parked-state topology (Block G round 3)', () => {
  let player: Player;
  let container: HTMLElement;
  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  // The board probe's exact segment shape: Write(1.0) -> wait(0.6) ->
  // Transform(1.2) -> wait(0.6); the parked time 1.3 sits inside the
  // pre-Transform wait.
  async function recordGlyphScene(): Promise<MathTex> {
    ({ player, container } = createPlayer());
    const { before, after } = await buildGlyphPair();
    await player.sequence(async (scene) => {
      await scene.play(new Write(before, { duration: 1.0 }));
      await scene.wait(0.6);
      await scene.play(new Transform(before, after, { duration: 1.2 }));
      await scene.wait(0.6);
    });
    return before;
  }

  it('seek(parked): full recursive state equals the authored source render', async () => {
    const { before: fresh } = await buildGlyphPair();
    const authored = fullLeafSig(fresh as unknown as VMobject);
    const before = await recordGlyphScene();

    playToEnd(player);
    player.timeline.seek(1.3);
    expect(fullLeafSig(before as unknown as VMobject)).toEqual(authored);

    // A full pass to the end and back must land on the same state.
    player.timeline.seek(player.timeline.getDuration());
    player.timeline.seek(1.3);
    expect(fullLeafSig(before as unknown as VMobject)).toEqual(authored);
  });

  it('fill geometry: the changed glyph keeps its counter open at the parked state', async () => {
    const { before: fresh } = await buildGlyphPair();
    const freshLeaves = leaves(fresh as unknown as VMobject);
    const before = await recordGlyphScene();
    playToEnd(player);
    player.timeline.seek(1.3);
    const parkedLeaves = leaves(before as unknown as VMobject);
    expect(parkedLeaves.length).toBe(freshLeaves.length);

    // Every compound (multi-subpath) authored glyph -- the two "e"s in
    // this scene -- must render at the parked state with the fill its
    // own topology describes: same area, counter left open. Pre-fix the
    // e1 "e" renders with the target's leftover partition, which does
    // not even sum to its point count: single ring, counter filled.
    const compound = freshLeaves
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => (f.getEffectiveSubpathLengths()?.length ?? 0) > 1);
    expect(compound.length).toBeGreaterThanOrEqual(2);
    for (const { f, i } of compound) {
      const parked = parkedLeaves[i];
      expect(parked.getEffectiveSubpathLengths()).toEqual(f.getEffectiveSubpathLengths());
      const parkedTris = worldFillTriangles(parked);
      const freshTris = worldFillTriangles(f);
      expect(Math.abs(fillArea(parkedTris) - fillArea(freshTris))).toBeLessThanOrEqual(
        fillArea(freshTris) * 1e-6,
      );
      const [hx, hy] = worldHoleCentroid(f);
      expect(coveredBy(freshTris, hx, hy)).toBe(false);
      expect(coveredBy(parkedTris, hx, hy)).toBe(false);
    }
  });

  it('bare Transform: finish() installs the target partition, reset() restores the begin-state topology', async () => {
    const { before, after } = await buildGlyphPair();
    const { before: fresh } = await buildGlyphPair();
    const freshLeaves = leaves(fresh as unknown as VMobject);
    const anim = new Transform(before, after);
    anim.begin();
    anim.interpolate(1);
    anim.finish();
    // End-state contract (round 2): the changed leaf renders with the
    // target leaf's partition over the target's points.
    const endLeaves = leaves(before as unknown as VMobject);
    const changedIdx = endLeaves.findIndex(
      (l, i) =>
        JSON.stringify(l.getEffectiveSubpathLengths()) !==
        JSON.stringify(freshLeaves[i].getEffectiveSubpathLengths()),
    );
    expect(changedIdx).toBeGreaterThanOrEqual(0);
    expect(rawOverride(endLeaves[changedIdx])).toEqual(
      leaves(after as unknown as VMobject)[changedIdx].getEffectiveSubpathLengths(),
    );

    anim.reset();
    // Begin-state contract: every leaf is back to the source's OWN
    // topology -- the override captured in the begin() snapshot (none,
    // for an authored mobject), so the effective lengths are the
    // leaf's own base lengths again.
    const resetLeaves = leaves(before as unknown as VMobject);
    expect(resetLeaves.length).toBe(freshLeaves.length);
    resetLeaves.forEach((leaf, i) => {
      expect(leaf.getEffectiveSubpathLengths()).toEqual(
        freshLeaves[i].getEffectiveSubpathLengths(),
      );
      expect(rawOverride(leaf)).toEqual(rawOverride(freshLeaves[i]));
    });
  });
});

// ---------------------------------------------------------------------------
// Block G round 4: a recorded CHAIN of Transforms on one mobject must
// reconstruct every state exactly -- in particular the parked state
// before the FIRST morph. Two coupled defects, one per layer:
//
// (alpha) RecordingScene.play() called anim.begin() at record time
// without running the earlier animations. Transform.begin() captures
// the Animation snapshot first, then its strategy aligns the LIVE
// mobject into the morph's aligned start state (resampled points,
// reordered subpaths, the source's styles). The next segment's
// begin() therefore snapshot a tree its predecessor's begin() had
// already mutated: T2's "begin state" was T1's aligned start state,
// not T1's end state (probe: the changed leaf at [13,58] over 71
// points where the target render has [58] over 58; the unchanged
// e2 with its subpaths swapped).
//
// (beta) The seek undo cascades (MasterTimeline.seek's reset-all and
// Timeline.seek's backward pass) reset animations in schedule order.
// reset() installs the animation's OWN begin state, so the last
// reset in the cascade decides any state no re-application covers:
// seeking to the pre-T1 parked time left T2's begin state installed
// (with true snapshots: the intermediate formula B, not A).
// End and middle states were exact only because re-application
// re-runs the earlier morphs to completion and overwrites the
// bad restore; a single morph was immune because its own reset
// runs last in its trivial cascade and its snapshot is pristine.
//
// Fix: RecordingScene records without beginning animations (begin --
// and with it the snapshot -- happens at the first playback/seek
// update, against the state the animation truly starts from), and
// reset cascades unwind in reverse schedule order (LIFO), with
// MasterTimeline performing the complete undo itself.
// ---------------------------------------------------------------------------

const CHAIN_THIRD = ['\\{', '\\mathbf{v}_1', ', ', '\\mathbf{e}_2', ', ', '\\mathbf{t}', '\\}'];

async function buildChainThird(): Promise<MathTex> {
  const third = new MathTex({ latex: CHAIN_THIRD });
  await third.waitForRender();
  third.setColorByTex('\\mathbf{v}_1', ORANGE);
  third.setColorByTex('\\mathbf{e}_2', BLUE);
  third.shift([0, 0.8, 0]);
  return third;
}

describe('recorded restore -- chained Transforms (Block G round 4)', () => {
  let player: Player;
  let container: HTMLElement;
  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  // Write(1.0) -> wait(0.6) -> Transform A->B (1.2) -> wait(0.6)
  //   -> Transform B->C (1.2) -> wait(0.6).
  // Parked (pre-T1) t=1.3; mid (post-T1) t=3.1; inside T1 t=2.2.
  async function recordChainScene(): Promise<{ src: MathTex; t1Start: number }> {
    ({ player, container } = createPlayer());
    const { before, after } = await buildGlyphPair();
    const third = await buildChainThird();
    let t1Start = 0;
    await player.sequence(async (scene) => {
      await scene.play(new Write(before, { duration: 1.0 }));
      await scene.wait(0.6);
      await scene.play(new Transform(before, after, { duration: 1.2 }));
      await scene.wait(0.6);
      await scene.play(new Transform(before, third, { duration: 1.2 }));
      await scene.wait(0.6);
    });
    t1Start = player.timeline.getSegments()[2].startTime;
    return { src: before, t1Start };
  }

  it('seek(parked) after a two-Transform chain returns the authored source in full', async () => {
    const { before: freshA } = await buildGlyphPair();
    const authoredA = fullLeafSig(freshA as unknown as VMobject);
    const { src } = await recordChainScene();

    playToEnd(player);
    player.timeline.seek(1.3);
    expect(fullLeafSig(src as unknown as VMobject)).toEqual(authoredA);

    // Same after a full pass to the end and back.
    player.timeline.seek(player.timeline.getDuration());
    player.timeline.seek(1.3);
    expect(fullLeafSig(src as unknown as VMobject)).toEqual(authoredA);
  });

  it('seek(mid) after the chain returns the first target in full (pin)', async () => {
    const { after: freshB } = await buildGlyphPair();
    const authoredB = fullLeafSig(freshB as unknown as VMobject);
    const { src } = await recordChainScene();
    playToEnd(player);
    player.timeline.seek(3.1);
    expect(fullLeafSig(src as unknown as VMobject)).toEqual(authoredB);
  });

  it('seek(end) after the chain returns the second target in full (pin)', async () => {
    const freshC = await buildChainThird();
    const authoredC = fullLeafSig(freshC as unknown as VMobject);
    const { src } = await recordChainScene();
    playToEnd(player);
    expect(fullLeafSig(src as unknown as VMobject)).toEqual(authoredC);
    player.timeline.seek(player.timeline.getDuration());
    expect(fullLeafSig(src as unknown as VMobject)).toEqual(authoredC);
  });

  it('scrubbing into the first morph of a chain interpolates from the authored source (pin)', async () => {
    const { src, t1Start } = await recordChainScene();
    // Bare reference: the same morph driven by hand from a fresh
    // authored source, updated to the same in-segment time.
    const { before: bareSrc, after: bareTgt } = await buildGlyphPair();
    const bare = new Transform(bareSrc, bareTgt, { duration: 1.2 });
    bare.startTime = t1Start;
    bare.update(0, t1Start + 0.6);

    playToEnd(player);
    player.timeline.seek(t1Start + 0.6);
    expect(fullLeafSig(src as unknown as VMobject)).toEqual(
      fullLeafSig(bareSrc as unknown as VMobject),
    );
  });

  it('a plain Timeline unwinds a chain LIFO: backward seek to parked returns the source', async () => {
    const { before: freshA } = await buildGlyphPair();
    const authoredA = fullLeafSig(freshA as unknown as VMobject);
    const { before: src, after: tgtB } = await buildGlyphPair();
    const tgtC = await buildChainThird();
    const tl = new Timeline();
    tl.add(new Write(src, { duration: 1.0 }), 0);
    tl.add(new Transform(src, tgtB, { duration: 1.2 }), 1.6);
    tl.add(new Transform(src, tgtC, { duration: 1.2 }), 3.4);
    tl.play();
    let guard = 0;
    while (tl.getCurrentTime() < tl.getDuration() - 1e-9 && guard++ < 100000) {
      tl.update(1 / 60);
    }
    tl.seek(3.1);
    const { after: freshB } = await buildGlyphPair();
    expect(fullLeafSig(src as unknown as VMobject)).toEqual(
      fullLeafSig(freshB as unknown as VMobject),
    );
    tl.seek(1.3);
    expect(fullLeafSig(src as unknown as VMobject)).toEqual(authoredA);
  });
});
