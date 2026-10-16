// @vitest-environment happy-dom
/**
 * WB use case — slides: slidesMode + RecordingScene.nextSlide() +
 * MasterTimeline.slides[].
 *
 * The whiteboard's episode work (S1-R B7) drives manim scenes one
 * teaching beat at a time: scenes mark beats with nextSlide(), the
 * Player runs in slidesMode, and slide boundaries come from
 * MasterTimeline.slides[]. These APIs were byte-identical between
 * upstream v0.37.0 and v0.39.3, so every test here is expected to
 * pass on pristine upstream too — this file is the drift alarm for
 * the surface B7 is built on. If one of these starts failing after
 * an upstream bump, B7's assumptions broke; do not "fix" the test.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Player } from '../player/Player';
import { Rectangle } from '../mobjects/geometry/Rectangle';
import { FadeIn } from '../animation/fading/FadeIn';
import type { Slide } from '../animation/MasterTimeline';

function createPlayer(): { player: Player; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const player = new Player(container, {
    width: 800,
    height: 450,
    headless: true,
    slidesMode: true,
  });
  return { player, container };
}

function slidesOf(player: Player): Slide[] {
  return (player.timeline as unknown as { _slides: Slide[] })._slides;
}

describe('WB slides surface (B7 dependency)', () => {
  let player: Player;
  let container: HTMLElement;

  afterEach(() => {
    player?.dispose();
    container?.remove();
  });

  it('nextSlide() segments the timeline; slides[] carries boundaries and loop flags', async () => {
    ({ player, container } = createPlayer());
    const rect = new Rectangle({ width: 2, height: 2 });
    await player.sequence(async (scene) => {
      await scene.wait(1);
      await scene.nextSlide();
      await scene.play(new FadeIn(rect));
      await scene.nextSlide({ loop: true });
      await scene.wait(1);
    });

    const slides = slidesOf(player);
    expect(slides.length).toBe(3);
    expect(slides[0].startTime).toBeCloseTo(0, 6);
    expect(slides[1].startTime).toBeCloseTo(1, 6);
    expect(slides[2].startTime).toBeCloseTo(2, 6);
    expect(slides[2].loop).toBe(true);
    expect(slides[0].loop).toBe(false);
  }, 60000);

  it('prevSegment() from inside a slide lands on the previous slide start', async () => {
    ({ player, container } = createPlayer());
    const rect = new Rectangle({ width: 2, height: 2 });
    await player.sequence(async (scene) => {
      await scene.wait(1);
      await scene.nextSlide();
      await scene.play(new FadeIn(rect));
      await scene.nextSlide({ loop: true });
      await scene.wait(1);
    });

    player.seek(2.5); // inside slide 2 (the looping wait)
    player.prevSegment();
    expect(player.timeline.getCurrentTime()).toBeCloseTo(1, 6);

    player.seek(1.5); // inside slide 1
    player.prevSegment();
    expect(player.timeline.getCurrentTime()).toBeCloseTo(0, 6);
  }, 60000);

  it('consecutive nextSlide() calls do not create a phantom slide', async () => {
    ({ player, container } = createPlayer());
    await player.sequence(async (scene) => {
      await scene.nextSlide();
      await scene.nextSlide();
      await scene.wait(1);
    });

    const slides = slidesOf(player);
    expect(slides.length).toBe(1);
    expect(slides[0].startTime).toBeCloseTo(0, 6);
    expect(slides[0].endTime).toBeCloseTo(1, 6);
  }, 60000);
});
