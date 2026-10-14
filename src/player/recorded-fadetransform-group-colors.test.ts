// @vitest-environment happy-dom
/**
 * Regression tests: FadeTransform / FadeTransformPieces on GROUP
 * mobjects must end at the target's own render — per leaf (Block H).
 *
 * Root cause: the group paths aligned the LIVE tree in place with
 * alignPoints() (FadeTransform at the root, FadeTransformPieces inside
 * each container piece). alignPoints pads and resamples the live
 * children, so the tree grew permanently (on the span pair below, 15
 * glyph leaves -> 32), and finish() installed only the aligned
 * (resampled) point arrays plus — for FadeTransform — the ROOT color.
 * A colored multi-part target's per-part colors never reached the
 * leaves: every part ended in the source's colors on resampled
 * geometry. (Bare Transform on the same pair was already exact: it
 * pairs the leaf families with pairLeafSnapshotsByIndex and installs
 * each target leaf's own points + style in finish().)
 *
 * The fade group paths now use the same leaf pairing, with the fade
 * curve layered on top: per-leaf opacity follows the V-curve, styles
 * switch from source to target at the invisible midpoint, and
 * finish() installs each target leaf's own points, subpath topology,
 * style, and position. The single-object (flat) paths are unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Player } from './Player';
import { MathTex } from '../mobjects/text/MathTex';
import { VMobject } from '../core/VMobject';
import { VGroup } from '../core/VGroup';
import { Mobject } from '../core/Mobject';
import { FadeTransform, FadeTransformPieces } from '../animation/transform/FadeTransforms';
import { Write } from '../animation/creation/Create';
import { BLUE, ORANGE, RED, GREEN } from '../constants/colors';

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

/** Per-leaf world-space signature: point count + weighted coordinate sum + colors. */
function worldSig(m: Mobject): string[] {
  return leaves(m).map((leaf) => {
    const wp = leaf.getPoints();
    const sum = wp.reduce((a, p) => a + p[0] + p[1] * 7 + p[2] * 13, 0).toFixed(6);
    return `n=${wp.length} wsum=${sum} c=${leaf.color.toLowerCase()} f=${(leaf.fillColor ?? '').toLowerCase()}`;
  });
}

/** Ordered per-leaf local state: points + colors + position (parked-state equality). */
function leafStateSig(m: Mobject): string[] {
  return leaves(m).map((leaf) => {
    const lp = leaf.getLocalPoints();
    const sum = lp.reduce((a, p) => a + p[0] + p[1] * 7 + p[2] * 13, 0).toFixed(6);
    return `n=${lp.length} sum=${sum} c=${leaf.color.toLowerCase()} f=${(leaf.fillColor ?? '').toLowerCase()} pos=${leaf.position.x.toFixed(4)},${leaf.position.y.toFixed(4)}`;
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
  return worldSig(ref);
}

async function freshSourceStateSig(): Promise<string[]> {
  const ref = await tex(BEFORE);
  ref.setColorByTex('\\mathbf{u}', BLUE);
  ref.setColorByTex('\\mathbf{v}', ORANGE);
  ref.shift([0, 1.8, 0]);
  return leafStateSig(ref);
}

function coloredLeaf(points: number[][], color: string): VMobject {
  const vm = new VMobject();
  vm.setPoints(points);
  vm.color = color;
  vm.fillColor = color;
  return vm;
}

describe('bare FadeTransform / FadeTransformPieces on groups (Block H)', () => {
  it('FadeTransform: end state is the target render per leaf, tree does not grow', async () => {
    const { before, after } = await buildSpanPair();
    const sourceLeafCount = leaves(before).length;
    const anim = new FadeTransform(before as unknown as VMobject, after as unknown as VMobject);
    anim.begin();
    anim.interpolate(0.5);
    anim.interpolate(1);
    anim.finish();
    expect(leaves(before).length).toBe(sourceLeafCount);
    expect(visuallyExact(worldSig(before), await freshTargetSig())).toBe(true);
  });

  it('FadeTransform: the fade curve is layered per leaf (mid-fade opacity dips to 0)', async () => {
    const { before, after } = await buildSpanPair();
    const anim = new FadeTransform(before as unknown as VMobject, after as unknown as VMobject);
    anim.begin();
    anim.interpolate(0.5);
    for (const leaf of leaves(before)) {
      expect(leaf.opacity).toBeCloseTo(0, 6);
    }
    anim.interpolate(0.25);
    for (const leaf of leaves(before)) {
      expect(leaf.opacity).toBeCloseTo(0.5, 6);
    }
  });

  it('FadeTransformPieces: end state is the target render per leaf', async () => {
    const { before, after } = await buildSpanPair();
    const anim = new FadeTransformPieces(
      before as unknown as VMobject,
      after as unknown as VMobject,
    );
    anim.begin();
    anim.interpolate(0.5);
    anim.interpolate(1);
    anim.finish();
    expect(visuallyExact(worldSig(before), await freshTargetSig())).toBe(true);
  });

  it('FadeTransform on a VGroup of colored leaves: per-leaf target colors survive', () => {
    const source = new VGroup(
      coloredLeaf(
        [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 0],
          [0, 1, 0],
        ],
        BLUE,
      ),
      coloredLeaf(
        [
          [2, 0, 0],
          [3, 0, 0],
          [3, 1, 0],
          [2, 1, 0],
        ],
        ORANGE,
      ),
    );
    const target = new VGroup(
      coloredLeaf(
        [
          [5, 5, 0],
          [6, 5, 0],
          [6, 6, 0],
        ],
        RED,
      ),
      coloredLeaf(
        [
          [7, 5, 0],
          [8, 5, 0],
          [8, 6, 0],
          [7, 6, 0],
        ],
        GREEN,
      ),
      coloredLeaf(
        [
          [9, 5, 0],
          [10, 5, 0],
          [10, 6, 0],
        ],
        BLUE,
      ),
    );
    const targetSig = worldSig(target);
    const anim = new FadeTransform(source as unknown as VMobject, target as unknown as VMobject);
    anim.begin();
    anim.interpolate(1);
    anim.finish();
    expect(visuallyExact(worldSig(source), targetSig)).toBe(true);
  });

  it('FadeTransformPieces on flat colored pieces: per-piece target colors survive', () => {
    const source = new VGroup(
      coloredLeaf(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        BLUE,
      ),
      coloredLeaf(
        [
          [0, 2, 0],
          [1, 2, 0],
        ],
        ORANGE,
      ),
    );
    const target = new VGroup(
      coloredLeaf(
        [
          [5, 0, 0],
          [6, 0, 0],
        ],
        RED,
      ),
      coloredLeaf(
        [
          [5, 2, 0],
          [6, 2, 0],
        ],
        GREEN,
      ),
    );
    const targetSig = worldSig(target);
    const anim = new FadeTransformPieces(
      source as unknown as VMobject,
      target as unknown as VMobject,
    );
    anim.begin();
    anim.interpolate(1);
    anim.finish();
    expect(visuallyExact(worldSig(source), targetSig)).toBe(true);
  });
});

describe('recorded FadeTransform / FadeTransformPieces on groups (Block H)', () => {
  let player: Player;
  let container: HTMLElement;
  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  it('recorded FadeTransform: seek(end) exact, seek(parked) returns the authored source', async () => {
    ({ player, container } = createPlayer());
    const { before, after } = await buildSpanPair();
    await player.sequence(async (scene) => {
      await scene.play(new Write(before as unknown as VMobject));
      await scene.wait(0.3);
      await scene.play(
        new FadeTransform(before as unknown as VMobject, after as unknown as VMobject),
      );
      await scene.wait(0.3);
    });

    const duration = player.timeline.getDuration();
    player.timeline.seek(duration);
    expect(visuallyExact(worldSig(before), await freshTargetSig())).toBe(true);

    // Parked: mid-wait BEFORE the FadeTransform segment starts at
    // 1.0 + 0.3 = 1.3 (at exactly 1.3 the segment's first frame — the
    // animation's begin state — is the correct state, not the parked
    // one; Block G round 3's parked probes use the same convention).
    player.timeline.seek(1.15);
    expect(leafStateSig(before)).toEqual(await freshSourceStateSig());
  });

  it('recorded FadeTransform: played-to-end state is the target render per leaf', async () => {
    ({ player, container } = createPlayer());
    const { before, after } = await buildSpanPair();
    await player.sequence(async (scene) => {
      await scene.play(new Write(before as unknown as VMobject));
      await scene.wait(0.3);
      await scene.play(
        new FadeTransform(before as unknown as VMobject, after as unknown as VMobject),
      );
      await scene.wait(0.3);
    });
    playToEnd(player);
    expect(visuallyExact(worldSig(before), await freshTargetSig())).toBe(true);
  });

  it('recorded FadeTransformPieces: seek(end) exact, seek(parked) returns the authored source', async () => {
    ({ player, container } = createPlayer());
    const { before, after } = await buildSpanPair();
    await player.sequence(async (scene) => {
      await scene.play(new Write(before as unknown as VMobject));
      await scene.wait(0.3);
      await scene.play(
        new FadeTransformPieces(before as unknown as VMobject, after as unknown as VMobject),
      );
      await scene.wait(0.3);
    });

    const duration = player.timeline.getDuration();
    player.timeline.seek(duration);
    expect(visuallyExact(worldSig(before), await freshTargetSig())).toBe(true);

    player.timeline.seek(1.15);
    expect(leafStateSig(before)).toEqual(await freshSourceStateSig());
  });
});
