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
