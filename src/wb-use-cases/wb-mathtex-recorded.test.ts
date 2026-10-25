// @vitest-environment happy-dom
/**
 * WB use case -- MathTex through the Player-recorded path.
 *
 * Transform one equation into the next where the glyph count changes:
 * the recorded variant of the group-alignment defect (threw
 * "VGroup.setPoints: expected 158 points, got 316"). -> chain patch
 * "group alignment"
 *
 * (The copy-of-rendered-MathTex, \\mathbb, and pre-applied-scale cases
 * that also lived here pass on pristine upstream since the MathTex.copy
 * and mathbb fixes merged; their tests were pruned in the 2026-10-25
 * cleanup.)
 *
 * On pristine upstream this test FAILS; on the grafted stack it passes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Player } from '../player/Player';
import { MathTex } from '../mobjects/text/MathTex';
import { VMobject } from '../core/VMobject';
import { Transform } from '../animation/transform/Transform';

function createPlayer(): { player: Player; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const player = new Player(container, { width: 800, height: 450, headless: true });
  return { player, container };
}

async function createRenderedTex(latex: string): Promise<MathTex> {
  const tex = new MathTex({ latex, fontSize: 1 });
  await tex.waitForRender();
  return tex;
}

function totalPoints(root: VMobject): number {
  let n = 0;
  for (const m of root.familyMembersWithPoints()) {
    n += m.getLocalPoints().length;
  }
  return n;
}

describe('WB MathTex through the recorded path', () => {
  let player: Player;
  let container: HTMLElement;

  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  it('recorded Transform between formulas with different glyph counts ends exact', async () => {
    ({ player, container } = createPlayer());
    const from = await createRenderedTex('a + b');
    const to = await createRenderedTex('\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}');
    await player.sequence(async (scene) => {
      await scene.play(new Transform(from, to));
    });

    player.timeline.seek(1);
    expect(from.opacity).toBeCloseTo(1, 3);
    expect(totalPoints(from)).toBe(totalPoints(to));
    const fc = from.getCenter();
    const tc = to.getCenter();
    expect(fc[0]).toBeCloseTo(tc[0], 3);
    expect(fc[1]).toBeCloseTo(tc[1], 3);
  }, 60000);
});
