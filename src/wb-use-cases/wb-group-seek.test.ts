// @vitest-environment happy-dom
/**
 * WB use case — grouped animation, as lessons actually use it.
 *
 * Two grouped idioms carry most whiteboard lessons:
 *
 *   - Reveal a derivation line by line with a LaggedStart of Writes,
 *     then seek around inside it while discussing a step. Seeking
 *     into the group must show exactly what playback showed — the
 *     grouped-seek defect made grouped mobjects vanish or appear at
 *     the wrong segment. -> chain patches "flattenAnimations" +
 *     "grouped seek"
 *   - Morph one grouped diagram into another (a VGroup Transform):
 *     children must land on their targets, not on a point-count
 *     error. -> chain patch "group alignment"
 *
 * On pristine v0.39.3 both tests are expected to FAIL.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Player } from '../player/Player';
import { MathTex } from '../mobjects/text/MathTex';
import { VGroup } from '../core/VGroup';
import { VMobject } from '../core/VMobject';
import { Circle } from '../mobjects/geometry/Circle';
import { Rectangle } from '../mobjects/geometry/Rectangle';
import { FadeIn } from '../animation/fading/FadeIn';
import { Transform } from '../animation/transform/Transform';
import { Write, getLine2TotalLength } from '../animation/creation/Create';
import { LaggedStart } from '../animation/LaggedStart';

function createPlayer(): { player: Player; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const player = new Player(container, { width: 800, height: 450, headless: true });
  return { player, container };
}

function playTo(player: Player, t: number): void {
  player.timeline.seek(0);
  player.timeline.play();
  const step = 1 / 60;
  let now = 0;
  while (now < t - 1e-9) {
    player.timeline.update(step);
    now += step;
  }
}

async function createRenderedTex(latex: string): Promise<MathTex> {
  const tex = new MathTex({ latex, fontSize: 1 });
  await tex.waitForRender();
  return tex;
}

interface TexState {
  opacity: number;
  revealFrac: number;
}

function texState(tex: MathTex): TexState {
  let reveal = 0;
  let total = 0;
  for (const member of tex.familyMembersWithPoints()) {
    for (const line of member.getOwnStrokeLines()) {
      const len = getLine2TotalLength(line);
      total += len;
      if (line.visible) {
        const mat = line.material as unknown as { dashed: boolean; dashSize: number };
        reveal += mat.dashed ? Math.min(mat.dashSize, len) : len;
      }
    }
  }
  return { opacity: tex.opacity, revealFrac: total > 0 ? reveal / total : 0 };
}

const LINES = ['e^{i\\pi} + 1 = 0', '\\sin^2\\theta + \\cos^2\\theta = 1', '\\sum_{k=1}^{n} k'];

async function buildLessonScene(player: Player): Promise<MathTex[]> {
  const texes: MathTex[] = [];
  for (let i = 0; i < LINES.length; i++) {
    const t = await createRenderedTex(LINES[i]);
    t.shift([0, 2.2 - i * 1.6, 0]);
    texes.push(t);
  }
  await player.sequence(async (scene) => {
    await scene.play(
      new LaggedStart(
        texes.map((t) => new Write(t)),
        { lagRatio: 0.5 },
      ),
    );
    await scene.wait(0.6);
  });
  return texes;
}

describe('WB grouped animation (lesson idioms)', () => {
  let player: Player;
  let container: HTMLElement;

  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  it('seek inside a LaggedStart reveal matches playback; after it, all lines are up', async () => {
    ({ player, container } = createPlayer());
    const seekTexes = await buildLessonScene(player);
    player.timeline.seek(1.2);
    const seekStates = seekTexes.map(texState);
    player.dispose();
    container.remove();

    ({ player, container } = createPlayer());
    const playTexes = await buildLessonScene(player);
    playTo(player, 1.2);
    const playStates = playTexes.map(texState);
    for (let i = 0; i < LINES.length; i++) {
      expect(seekStates[i].opacity).toBeCloseTo(playStates[i].opacity, 3);
      expect(seekStates[i].revealFrac).toBeCloseTo(playStates[i].revealFrac, 3);
    }

    player.timeline.seek(2.5); // group done, inside the wait
    for (const s of playTexes.map(texState)) {
      expect(s.opacity).toBeCloseTo(1, 3);
      expect(s.revealFrac).toBeCloseTo(1, 3);
    }
  }, 60000);

  it('recorded Transform of one VGroup diagram into another lands leaves on their targets', async () => {
    ({ player, container } = createPlayer());
    const srcDot = new Circle({ radius: 0.5 });
    srcDot.shift([-2, 0, 0]);
    const srcBox = new Rectangle({ width: 1, height: 1 });
    srcBox.shift([2, 0, 0]);
    const source = new VGroup(srcDot, srcBox);

    // The target diagram GAINS an element (a construction mark) —
    // child counts differ, which is exactly where recursive child-
    // list alignment is needed; a same-count morph passes even on
    // pristine upstream and would not guard the fix.
    const tgtDot = new Circle({ radius: 1 });
    tgtDot.shift([-2, 1, 0]);
    const tgtBall = new Circle({ radius: 0.5 });
    tgtBall.shift([2, -1, 0]);
    const tgtMark = new Rectangle({ width: 0.6, height: 0.6 });
    tgtMark.shift([0, 2, 0]);
    const target = new VGroup(tgtDot, tgtBall, tgtMark);

    await player.sequence(async (scene) => {
      await scene.play(new FadeIn(source));
      await scene.play(new Transform(source, target));
    });

    player.timeline.seek(2);
    const leafCenters = (root: VMobject): Array<[number, number]> =>
      root.familyMembersWithPoints().map((m) => {
        const c = m.getCenter();
        return [c[0], c[1]] as [number, number];
      });
    const landed = leafCenters(source);
    const wanted = leafCenters(target);
    expect(landed.length).toBe(wanted.length);
    for (const [wx, wy] of wanted) {
      const hit = landed.some(([lx, ly]) => Math.abs(lx - wx) < 0.01 && Math.abs(ly - wy) < 0.01);
      expect(hit, `a leaf landed at (${wx}, ${wy})`).toBe(true);
    }
    expect(source.opacity).toBeCloseTo(1, 3);
  }, 60000);
});
