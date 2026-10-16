// @vitest-environment happy-dom
/**
 * WB use case — the Player-recorded path, end to end.
 *
 * Every manim step on the whiteboard runs through this path and no
 * other: a RecordingScene records a scene's animations into a
 * MasterTimeline, and the Player plays that timeline back while the
 * tutor seeks constantly (stepping through a derivation). Upstream's
 * 2026 spring fixes (#279 / #298 / #374) covered the DIRECT animation
 * path only; this file pins the recorded path's contract:
 *
 *   - seek(t) produces exactly the state playback reaches at t;
 *   - seek(end) lands on the exact final state;
 *   - seek(0) rewinds animations that have begun.
 *
 * Plus one characterization test pinning a KNOWN WART (present on the
 * deployed 0.37 stack too): after seek(end), seek(0) leaves a
 * not-yet-begun Write fully revealed instead of hidden. The wart is
 * asserted as-is so any change to it — fix or regression — trips
 * this suite loudly instead of silently changing lesson behavior.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Player } from '../player/Player';
import { Rectangle } from '../mobjects/geometry/Rectangle';
import { Circle } from '../mobjects/geometry/Circle';
import { VMobject } from '../core/VMobject';
import { FadeIn } from '../animation/fading/FadeIn';
import { FadeOut } from '../animation/fading/FadeOut';
import { Transform } from '../animation/transform/Transform';
import { Write, getLine2TotalLength } from '../animation/creation/Create';

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

function totalPoints(root: VMobject): number {
  let n = 0;
  for (const m of root.familyMembersWithPoints()) {
    n += m.getLocalPoints().length;
  }
  return n;
}

interface ShapeState {
  opacity: number;
  cx: number;
  cy: number;
  pts: number;
}

function shapeState(m: VMobject): ShapeState {
  const c = m.getCenter();
  return { opacity: m.opacity, cx: c[0], cy: c[1], pts: totalPoints(m) };
}

function expectStateClose(actual: ShapeState, expected: ShapeState): void {
  expect(actual.opacity).toBeCloseTo(expected.opacity, 3);
  expect(actual.cx).toBeCloseTo(expected.cx, 3);
  expect(actual.cy).toBeCloseTo(expected.cy, 3);
  expect(actual.pts).toBe(expected.pts);
}

/** Stroke-reveal fraction of a VMobject (0 = hidden, 1 = fully drawn). */
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

/** FadeIn a wide rectangle, morph it into a shifted circle, fade it out. */
async function buildShapeScene(player: Player): Promise<VMobject> {
  const rect = new Rectangle({ width: 3, height: 1.5 });
  const circle = new Circle({ radius: 1 });
  circle.shift([1.5, 0.5, 0]);
  await player.sequence(async (scene) => {
    await scene.play(new FadeIn(rect));
    await scene.play(new Transform(rect, circle));
    await scene.play(new FadeOut(rect));
  });
  return rect;
}

describe('WB recorded path (RecordingScene -> Player)', () => {
  let player: Player;
  let container: HTMLElement;

  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  it('seek state matches playback state inside every segment', async () => {
    ({ player, container } = createPlayer());
    const seekShape = await buildShapeScene(player);
    const seekStates = new Map<number, ShapeState>();
    for (const t of [0.5, 1.5, 2.5]) {
      player.timeline.seek(t);
      seekStates.set(t, shapeState(seekShape));
    }
    player.dispose();
    container.remove();

    ({ player, container } = createPlayer());
    const playShape = await buildShapeScene(player);
    for (const t of [0.5, 1.5, 2.5]) {
      playTo(player, t);
      expectStateClose(seekStates.get(t)!, shapeState(playShape));
    }
  }, 60000);

  it('seek(end) is the exact end state; seek(0) rewinds begun animations', async () => {
    ({ player, container } = createPlayer());
    const shape = await buildShapeScene(player);

    player.timeline.seek(3);
    const end = shapeState(shape);
    expect(end.opacity).toBeCloseTo(0, 3); // faded out
    expect(end.cx).toBeCloseTo(1.5, 3); // morphed to the circle's center
    expect(end.cy).toBeCloseTo(0.5, 3);

    player.timeline.seek(0);
    const start = shapeState(shape);
    expect(start.opacity).toBeCloseTo(0, 3); // FadeIn has not begun
    expect(start.cx).toBeCloseTo(0, 3); // back to the rectangle's center
    expect(start.cy).toBeCloseTo(0, 3);
  }, 60000);

  it('characterization: seek(end) then seek(0) leaves an unbegun Write fully revealed (known wart)', async () => {
    ({ player, container } = createPlayer());
    const first = new Rectangle({ width: 1.6, height: 1.6 });
    first.shift([-2.2, 0, 0]);
    const second = new Rectangle({ width: 1.6, height: 1.6 });
    second.shift([2.2, 0, 0]);
    await player.sequence(async (scene) => {
      await scene.play(new Write(first));
      await scene.play(new Write(second));
    });

    player.timeline.seek(2);
    expect(revealFrac(second)).toBeCloseTo(1, 3);

    // WART (pinned, not endorsed): rewinding to 0 restores the first
    // Write — which HAS begun by t=0's frame — but the second Write,
    // which has not begun at t=0, stays fully revealed instead of
    // returning to hidden. If this assertion starts failing because
    // the wart got FIXED (second becomes 0), update the pin and note
    // it in FIX_NOTES; if it fails any other way, it's a regression.
    player.timeline.seek(0);
    expect(revealFrac(first)).toBeCloseTo(0, 3);
    expect(revealFrac(second)).toBeCloseTo(1, 3);
  }, 60000);
});
