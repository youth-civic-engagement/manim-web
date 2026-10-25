// @vitest-environment happy-dom
/**
 * WB use case -- grouped animation, as lessons actually use it.
 *
 * Morph one grouped diagram into another (a VGroup Transform) where
 * the target GAINS an element: leaves must land on their targets, not
 * on a point-count error. -> chain patch "group alignment"
 *
 * (The LaggedStart grouped-seek idiom that also lived here is covered
 * by upstream since #866 and its test was pruned in the 2026-10-25
 * cleanup: it passed on pristine upstream.)
 *
 * On pristine upstream this test FAILS; on the grafted stack it passes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Player } from '../player/Player';
import { VGroup } from '../core/VGroup';
import { VMobject } from '../core/VMobject';
import { Circle } from '../mobjects/geometry/Circle';
import { Rectangle } from '../mobjects/geometry/Rectangle';
import { FadeIn } from '../animation/fading/FadeIn';
import { Transform } from '../animation/transform/Transform';

function createPlayer(): { player: Player; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const player = new Player(container, { width: 800, height: 450, headless: true });
  return { player, container };
}

describe('WB grouped animation (lesson idioms)', () => {
  let player: Player;
  let container: HTMLElement;

  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

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
