// @vitest-environment happy-dom
/**
 * Regression tests: seeking into/after a segment whose animations are
 * grouped (LaggedStart / AnimationGroup / Succession) must produce the
 * same visible state as playing to that time.
 *
 * Bug: `MasterTimeline.addSegment()` recorded first-appearance tracking
 * (`_mobjectFirstSegment` / `_savedMobjectOpacities`) only for TOP-LEVEL
 * animations. A mobject whose first animation was nested inside a
 * LaggedStart was attributed to a later segment where it happened to
 * appear at top level (in the repro: the FadeOut segment), so seek()
 * set its opacity to 0 — "not introduced yet" — for the entire span it
 * was actually being animated, and the Player rendered a blank canvas
 * even though the grouped animations' own state (dash reveals) was
 * correct. Fix: addSegment flattens grouped animations when recording
 * first-appearance tracking (scheduling still uses the top-level list).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Player } from './Player';
import { MathTex } from '../mobjects/text/MathTex';
import { Write, getLine2TotalLength } from '../animation/creation/Create';
import { FadeIn } from '../animation/fading/FadeIn';
import { FadeOut } from '../animation/fading/FadeOut';
import { LaggedStart } from '../animation/LaggedStart';
import { Succession } from '../animation/Succession';
import { AnimationGroup } from '../animation/AnimationGroup';
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

function expectStateClose(actual: TexState, expected: TexState): void {
  expect(actual.opacity).toBeCloseTo(expected.opacity, 6);
  expect(actual.revealFrac).toBeCloseTo(expected.revealFrac, 6);
}

const LINES = [
  'e^{i\\pi} + 1 = 0',
  '\\sin^2\\theta + \\cos^2\\theta = 1',
  '\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}',
];

async function buildLaggedScene(player: Player): Promise<MathTex[]> {
  const texes: MathTex[] = [];
  for (let i = 0; i < LINES.length; i++) {
    const t = await createRenderedTex(LINES[i]);
    t.shift([0, 2.6 - i * 1.2, 0]);
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
    await scene.play(new FadeOut(texes[0]), new FadeOut(texes[1]), new FadeOut(texes[2]));
    await scene.wait(0.4);
  });
  return texes;
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

describe('Player seek into grouped (LaggedStart) segments', () => {
  let player: Player;
  let container: HTMLElement;

  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  it('seek state matches playback state inside and after a LaggedStart segment', async () => {
    // SEEK path
    ({ player, container } = createPlayer());
    const seekTexes = await buildLaggedScene(player);
    const seekStates = new Map<number, TexState[]>();
    for (const t of [1.2, 2.2, 3.1]) {
      player.timeline.seek(t);
      seekStates.set(t, seekTexes.map(texState));
    }
    player.dispose();
    container.remove();

    // PLAYBACK path (independent instance, stepped updates)
    ({ player, container } = createPlayer());
    const playTexes = await buildLaggedScene(player);
    for (const t of [1.2, 2.2, 3.1]) {
      playTo(player, t);
      const playStates = playTexes.map(texState);
      const seekAt = seekStates.get(t)!;
      for (let i = 0; i < 3; i++) {
        expectStateClose(seekAt[i], playStates[i]);
      }
    }
  }, 60000);

  it('mobjects animated inside the LaggedStart are visible during its segment', async () => {
    ({ player, container } = createPlayer());
    const texes = await buildLaggedScene(player);

    // Inside the LaggedStart segment: not hidden, partially revealed.
    player.timeline.seek(1.2);
    for (const tex of texes) {
      const s = texState(tex);
      expect(s.opacity).toBe(1);
      expect(s.revealFrac).toBeGreaterThan(0);
    }

    // In the wait after it: fully written, still visible.
    player.timeline.seek(2.2);
    for (const tex of texes) {
      const s = texState(tex);
      expect(s.opacity).toBe(1);
      expect(s.revealFrac).toBeCloseTo(1, 6);
    }

    // Mid-FadeOut: grouped attribution did not leak into later segments.
    player.timeline.seek(3.1);
    for (const tex of texes) {
      expect(texState(tex).opacity).toBeCloseTo(0.5, 6);
    }
  }, 60000);

  it('guard: a mobject first animated in a later segment stays hidden before it', async () => {
    ({ player, container } = createPlayer());
    const a = await createRenderedTex('x^2');
    const b = await createRenderedTex('y^2');

    await player.sequence(async (scene) => {
      await scene.play(new Write(a));
      await scene.play(new FadeIn(b));
    });

    const bSegmentStart = player.timeline.getSegments()[1].startTime;
    player.timeline.seek(bSegmentStart - 0.1);
    expect(b.opacity).toBe(0);
    player.timeline.seek(bSegmentStart + 0.5);
    expect(b.opacity).toBeGreaterThan(0);
  }, 60000);

  it('group-only mobjects in a later LaggedStart are hidden before their segment', async () => {
    ({ player, container } = createPlayer());
    const a = await createRenderedTex('x^2');
    const b = await createRenderedTex('y^2');
    const c = await createRenderedTex('z^2');

    await player.sequence(async (scene) => {
      await scene.play(new Write(a));
      await scene.play(new LaggedStart([new Write(b), new Write(c)], { lagRatio: 0.5 }));
    });

    const groupStart = player.timeline.getSegments()[1].startTime;
    player.timeline.seek(groupStart - 0.1);
    expect(b.opacity).toBe(0);
    expect(c.opacity).toBe(0);

    player.timeline.seek(groupStart + 0.75);
    expect(b.opacity).toBe(1);
    expect(c.opacity).toBe(1);
    expect(texState(b).revealFrac).toBeGreaterThan(0);
  }, 60000);

  it('Succession children are attributed to the Succession segment', async () => {
    ({ player, container } = createPlayer());
    const a = await createRenderedTex('x^2');
    const b = await createRenderedTex('y^2');

    await player.sequence(async (scene) => {
      await scene.play(new Succession([new Write(a), new Write(b)]));
      await scene.play(new FadeOut(a));
    });

    // Inside the Succession (a written, b writing): both attributed to
    // segment 0, so neither is hidden as "introduced by the FadeOut".
    player.timeline.seek(1.5);
    expect(a.opacity).toBe(1);
    expect(b.opacity).toBe(1);
    // a's Write has completed its window (its reveal plateaus at the
    // two-phase stroke fraction until the group finishes); b is
    // mid-Write, strictly behind a.
    expect(texState(a).revealFrac).toBeGreaterThan(0.8);
    expect(texState(b).revealFrac).toBeGreaterThan(0);
    expect(texState(b).revealFrac).toBeLessThan(texState(a).revealFrac);
  }, 60000);

  // C1 (review repair): mobjects added directly via scene.add() carry
  // createdAtBeginning=true and are visible from t=0. update()'s re-hide
  // loop honored that flag, but seek()'s hide loop did not — so once
  // bd313e1 enrolled group children into the tracking maps, a pre-added
  // mobject first animated inside a LaggedStart vanished under seek for
  // the whole span before its segment, while playback showed it.
  it('pre-added mobjects first animated inside a LaggedStart stay visible under seek (C1)', async () => {
    ({ player, container } = createPlayer());
    const other = await createRenderedTex('q^2');
    const a = await createRenderedTex('x^2');
    const b = await createRenderedTex('y^2');

    await player.sequence(async (scene) => {
      scene.add(a);
      scene.add(b);
      await scene.play(new Write(other));
      await scene.play(new LaggedStart([new Write(a), new Write(b)], { lagRatio: 0.5 }));
    });

    const groupStart = player.timeline.getSegments()[1].startTime;

    // Before the group segment: playback shows the pre-added mobjects
    // (they were put on stage at t=0 and nothing hides them); seek must
    // agree.
    player.timeline.seek(groupStart - 0.25);
    expect(a.opacity).toBe(1);
    expect(b.opacity).toBe(1);

    // Mid-segment: visible and being written.
    player.timeline.seek(groupStart + 0.5);
    expect(a.opacity).toBe(1);
    expect(b.opacity).toBe(1);
    expect(texState(a).revealFrac).toBeGreaterThan(0);
  }, 60000);

  // C1 (review repair): the same exemption gap in seek()'s hide loop
  // applies to a pre-added mobject first animated at TOP level in a
  // later segment (the loop is shared).
  it('pre-added mobjects first animated at top level stay visible under seek (C1)', async () => {
    ({ player, container } = createPlayer());
    const other = await createRenderedTex('q^2');
    const a = await createRenderedTex('x^2');

    await player.sequence(async (scene) => {
      scene.add(a);
      await scene.play(new Write(other));
      await scene.play(new FadeIn(a));
    });

    const aStart = player.timeline.getSegments()[1].startTime;
    player.timeline.seek(aStart - 0.25);
    expect(a.opacity).toBe(1);
  }, 60000);

  // C2 (review repair): ChangeSpeed is a container too — it wraps a
  // single .animation instead of exposing .animations — and the old
  // AnimationGroup-only flattening could not see through it, so a
  // mobject first animated inside a ChangeSpeed was attributed to a
  // later segment and hidden under seek: the exact F2 signature.
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

  // C2/C3 (review repair): the shared flattening sees through nested
  // containers (depth 2) — children of a LaggedStart inside an
  // AnimationGroup are attributed to the outer segment, in both
  // directions (hidden before it, visible inside it).
  it('nested groups attribute children to the outer segment (C2/C3)', async () => {
    ({ player, container } = createPlayer());
    const a = await createRenderedTex('x^2');
    const b = await createRenderedTex('y^2');

    await player.sequence(async (scene) => {
      await scene.wait(0.5);
      await scene.play(
        new AnimationGroup([new LaggedStart([new Write(a), new Write(b)], { lagRatio: 0.5 })]),
      );
      await scene.play(new FadeOut(a));
    });

    // In the wait before the group segment: not yet introduced.
    player.timeline.seek(0.25);
    expect(a.opacity).toBe(0);
    expect(b.opacity).toBe(0);

    // Inside the group segment: visible, being written.
    const groupStart = player.timeline.getSegments()[1].startTime;
    player.timeline.seek(groupStart + 0.6);
    expect(a.opacity).toBe(1);
    expect(b.opacity).toBe(1);
    expect(texState(a).revealFrac).toBeGreaterThan(0);
  }, 60000);

  // Boundary + backward-seek pins (review repair): seeks landing
  // exactly on segment boundaries, and a backward seek after a forward
  // one, produce the same state as a direct seek.
  it('seeks at segment boundaries and backward seeks are consistent', async () => {
    ({ player, container } = createPlayer());
    const texes = await buildLaggedScene(player);
    const segs = player.timeline.getSegments();
    const fadeStart = segs[2].startTime;
    const end = player.timeline.getDuration();

    // Exactly at the FadeOut start: fade has not progressed yet.
    player.timeline.seek(fadeStart);
    for (const tex of texes) {
      expect(texState(tex).opacity).toBeCloseTo(1, 6);
    }

    // At the very end: the FadeOut has completed.
    player.timeline.seek(end);
    for (const tex of texes) {
      expect(texState(tex).opacity).toBeCloseTo(0, 6);
    }

    // Backward seek to mid-LaggedStart matches a fresh direct seek.
    player.timeline.seek(1.2);
    const backward = texes.map(texState);
    player.timeline.seek(0);
    player.timeline.seek(1.2);
    const direct = texes.map(texState);
    for (let i = 0; i < 3; i++) {
      expectStateClose(backward[i], direct[i]);
    }
  }, 60000);
});
