// @vitest-environment happy-dom
/**
 * WB use case — MathTex through the Player-recorded path.
 *
 * Whiteboard lessons are formulas first: the tutor copies a rendered
 * formula and keeps deriving from the copy, transforms one equation
 * into the next (glyph counts change), uses \mathbb for number sets,
 * and scales a line before re-using it. Each behavior below broke on
 * pristine upstream in the RECORDED path specifically (upstream's
 * spring fixes covered direct playback only):
 *
 *   - copy of a rendered MathTex -> chain patch "MathTex.copy"
 *     (duplicated glyphs / lost parts; original symptom of #251)
 *   - transform changing glyph count -> chain patch "group
 *     alignment" (recorded variant of #280; threw
 *     "VGroup.setPoints: expected 158 points, got 316")
 *   - \mathbb -> chain patch "mathbb dynamic font"
 *   - pre-applied scale through a copy -> chain patches "MathTex.copy"
 *     + scale handling (recorded variant of #324)
 *
 * On pristine v0.39.3 every test in this file is expected to FAIL;
 * on the grafted stack all pass.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Player } from '../player/Player';
import { MathTex } from '../mobjects/text/MathTex';
import { VMobject } from '../core/VMobject';
import { Create, Write, getLine2TotalLength } from '../animation/creation/Create';
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

function revealFrac(m: VMobject): number {
  let reveal = 0;
  let total = 0;
  for (const member of m.familyMembersWithPoints()) {
    for (const line of member.getOwnStrokeLines()) {
      const len = getLine2TotalLength(line);
      total += len;
      if (line.visible) {
        const mat = line.material as unknown as { dashed: boolean; dashSize: number };
        reveal += mat.dashed ? Math.min(mat.dashSize, len) : len;
      }
    }
  }
  return total > 0 ? reveal / total : 0;
}

describe('WB MathTex through the recorded path', () => {
  let player: Player;
  let container: HTMLElement;

  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  it('recorded Create on a copy of a rendered MathTex keeps every glyph exactly once', async () => {
    ({ player, container } = createPlayer());
    const original = await createRenderedTex('x^2 + y^2 = r^2');
    const copy = original.copy() as MathTex;
    await player.sequence(async (scene) => {
      await scene.play(new Create(copy));
    });

    player.timeline.seek(1);
    expect(copy.children.length).toBe(original.children.length);
    expect(totalPoints(copy)).toBe(totalPoints(original));
    expect(revealFrac(copy)).toBeCloseTo(1, 3);
  }, 60000);

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

  it('\\mathbb renders through the recorded path (dynamic font)', async () => {
    ({ player, container } = createPlayer());
    const tex = await createRenderedTex('\\mathbb{R}');
    // The double-struck glyph exists only if the NewCM dynamic font
    // range loaded; a missing font leaves an empty glyph shell.
    expect(tex.children.length).toBeGreaterThan(0);
    expect(totalPoints(tex)).toBeGreaterThan(0);

    await player.sequence(async (scene) => {
      await scene.play(new Write(tex));
    });
    player.timeline.seek(1);
    expect(revealFrac(tex)).toBeCloseTo(1, 3);
  }, 60000);

  it('a pre-applied scale survives copying and recorded Create', async () => {
    ({ player, container } = createPlayer());
    const original = await createRenderedTex('e^{i\\pi} + 1 = 0');
    original.scale(0.5);
    const scaledWidth = original.getWidth();
    const copy = original.copy() as MathTex;
    await player.sequence(async (scene) => {
      await scene.play(new Create(copy));
    });

    player.timeline.seek(1);
    expect(copy.getWidth()).toBeCloseTo(scaledWidth, 2);
    expect(totalPoints(copy)).toBe(totalPoints(original));
  }, 60000);
});
