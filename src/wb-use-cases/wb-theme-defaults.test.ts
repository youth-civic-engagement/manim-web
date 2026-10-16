// @vitest-environment happy-dom
/**
 * WB use case — theme-seeded default colors.
 *
 * The whiteboard's stage is LIGHT: before a lesson, the app calls
 * setTheme('light') and then expects everything a scene constructs
 * without an explicit color to come up dark on the white stage —
 * formulas, plain text, axes — while colors a scene pins explicitly
 * (gold arrows, red emphasis) are never overridden.
 *
 * What provides what:
 *   - Scene background + the Mobject-constructor color seed (seen
 *     on a bare VMobject): UPSTREAM's ThemeManager seeding. These
 *     pins pass on pristine upstream; they are drift alarms.
 *     (Shaped mobjects carry their own color defaults — Rectangle
 *     is BLUE, Line is WHITE — which is why wb scenes pin colors
 *     explicitly; the seed governs everything without an override.)
 *   - MathTex / Text defaults: deployed extra "theme seed — text"
 *     (upstream hardcoded WHITE, i.e. white-on-white on our stage).
 *   - Axes / NumberLine defaults: deployed extra "theme seed —
 *     graphing" (same white-on-white defect).
 *
 * On pristine v0.39.3 the MathTex/Text/Axes light-theme tests FAIL
 * (the extras are not upstream); everything else passes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Player } from '../player/Player';
import { MathTex } from '../mobjects/text/MathTex';
import { Text } from '../mobjects/text/Text';
import { Axes } from '../mobjects/graphing/Axes';
import { NumberLine } from '../mobjects/graphing/NumberLine';
import { VMobject } from '../core/VMobject';
import { WHITE, BLACK } from '../constants/colors';
import { setTheme, resetThemes } from '../utils/ThemeManager';

const RED = '#ff0000';

/** Colors of a MathTex's glyph VMobjects. */
function glyphColors(tex: MathTex): string[] {
  return tex.children.filter((c): c is VMobject => c instanceof VMobject).map((c) => c.color);
}

/** Every color carried by a VMobject in the mobject's family (incl. itself). */
function familyColors(root: VMobject): string[] {
  return root
    .getFamily()
    .filter((m): m is VMobject => m instanceof VMobject)
    .map((m) => m.color);
}

/** Mock CanvasRenderingContext2D (happy-dom has none), as in text.test.ts. */
function createMockCtx(): CanvasRenderingContext2D {
  return {
    font: '',
    textBaseline: 'top',
    textAlign: 'center',
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    measureText: vi.fn((_text: string) => ({
      width: _text.length * 10,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 2,
      fontBoundingBoxAscent: 12,
      fontBoundingBoxDescent: 3,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: _text.length * 10,
    })),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe('WB theme-seeded defaults (light stage)', () => {
  let player: Player | undefined;
  let container: HTMLElement | undefined;

  beforeEach(() => {
    resetThemes();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((contextId: string) => {
      if (contextId === '2d') return createMockCtx();
      return null;
    });
  });

  afterEach(() => {
    resetThemes();
    vi.restoreAllMocks();
    player?.dispose();
    container?.remove();
    player = undefined;
    container = undefined;
  });

  it('light theme seeds mobject defaults and the scene background (upstream seeding)', () => {
    setTheme('light');
    expect(new VMobject().color).toBe(BLACK);

    container = document.createElement('div');
    document.body.appendChild(container);
    player = new Player(container, { width: 800, height: 450, headless: true });
    expect(player.scene.backgroundColor.getHexString()).toBe('ffffff');
  });

  it('default theme keeps the historical white-on-black pins (upstream seeding)', () => {
    expect(new VMobject().color).toBe(WHITE);

    container = document.createElement('div');
    document.body.appendChild(container);
    player = new Player(container, { width: 800, height: 450, headless: true });
    // The `default` theme's background is MANIM_BACKGROUND (#1c1c1c),
    // not pure black — that is the `dark` theme's background.
    expect(player.scene.backgroundColor.getHexString()).toBe('1c1c1c');
  });

  it('MathTex glyphs default to the light theme fill; explicit color wins (theme seed — text)', async () => {
    setTheme('light');
    const tex = new MathTex({ latex: 'x^2', fontSize: 1 });
    await tex.waitForRender();
    const colors = glyphColors(tex);
    expect(colors.length).toBeGreaterThan(0);
    for (const c of colors) {
      expect(c).toBe(BLACK);
    }

    const red = new MathTex({ latex: 'x^2', fontSize: 1, color: RED });
    await red.waitForRender();
    for (const c of glyphColors(red)) {
      expect(c).toBe(RED);
    }
  }, 60000);

  it('Text defaults to the light theme fill; explicit color wins (theme seed — text)', () => {
    setTheme('light');
    expect(new Text({ text: 'Title' }).color).toBe(BLACK);
    expect(new Text({ text: 'Title', color: RED }).color).toBe(RED);
  });

  it('Axes and NumberLine default to the light theme fill; explicit color wins (theme seed — graphing)', () => {
    setTheme('light');
    const axes = new Axes();
    for (const c of familyColors(axes as unknown as VMobject)) {
      expect(c).toBe(BLACK);
    }
    const line = new NumberLine({ includeNumbers: false });
    expect(line.color).toBe(BLACK);

    const redLine = new NumberLine({ includeNumbers: false, color: RED });
    expect(redLine.color).toBe(RED);
  });
});
