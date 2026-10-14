// @vitest-environment happy-dom
/**
 * Regression test (C2): a mobject whose first animation is wrapped in
 * a ChangeSpeed must be attributed to that animation's own segment.
 *
 * Upstream's segment tracking (#866/#861) flattens AnimationGroup
 * children, and plain LaggedStart/Succession attribution is covered
 * upstream. ChangeSpeed is a different container shape -- it wraps a
 * single .animation instead of exposing .animations -- so the
 * upstream flattening cannot see through it: a mobject first animated
 * inside a ChangeSpeed was attributed to a later segment (here, the
 * FadeOut segment) and seek() hid it for its whole first segment.
 * The fix walks the shared flattenAnimations helper, which unwraps
 * ChangeSpeed, when recording first-appearance tracking.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Player } from './Player';
import { MathTex } from '../mobjects/text/MathTex';
import { Write, getLine2TotalLength } from '../animation/creation/Create';
import { FadeOut } from '../animation/fading/FadeOut';
import { ChangeSpeed } from '../animation/speed/index';

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

interface TexState {
  opacity: number;
  revealFrac: number;
}

/** Visible state of a MathTex: root opacity + stroke-reveal fraction. */
function texState(tex: MathTex): TexState {
  let revealSum = 0;
  let totalSum = 0;
  for (const member of tex.familyMembersWithPoints()) {
    for (const line of member.getOwnStrokeLines()) {
      const total = getLine2TotalLength(line);
      totalSum += total;
      if (line.visible) {
        const mat = line.material as unknown as { dashed: boolean; dashSize: number };
        revealSum += mat.dashed ? Math.min(mat.dashSize, total) : total;
      }
    }
  }
  return {
    opacity: tex.opacity,
    revealFrac: totalSum > 0 ? revealSum / totalSum : 0,
  };
}

describe('Player seek into grouped (LaggedStart) segments', () => {
  let player: Player;
  let container: HTMLElement;

  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  // C2 (review repair): ChangeSpeed is a container too -- it wraps a
  // single .animation instead of exposing .animations -- and the old
  // AnimationGroup-only flattening could not see through it, so a
  // mobject first animated inside a ChangeSpeed was attributed to a
  // later segment and hidden under seek.
  it('ChangeSpeed-wrapped animations are attributed to their own segment (C2)', async () => {
    ({ player, container } = createPlayer());
    const tex = await createRenderedTex('x^2');

    await player.sequence(async (scene) => {
      await scene.play(new ChangeSpeed(new Write(tex), () => 1));
      await scene.play(new FadeOut(tex));
    });

    const seg0 = player.timeline.getSegments()[0];
    player.timeline.seek((seg0.startTime + seg0.endTime) / 2);
    expect(tex.opacity).toBe(1);
    expect(texState(tex).revealFrac).toBeGreaterThan(0);
  }, 60000);
});
