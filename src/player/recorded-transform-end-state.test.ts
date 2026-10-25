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
