/**
 * The ONE definition of "what a play() contains" for the Player's
 * recording path.
 *
 * Grouped animations schedule only the container on the timeline, but
 * their children are the ones that actually animate mobjects. Every
 * consumer that tracks mobjects per animation — MasterTimeline's
 * first-appearance/visibility maps, Scene's live-play membership —
 * must see through containers, and must see through ALL of them the
 * same way. (F2's root cause was two subsystems holding different
 * views of this; a third hand-rolled walk — AnimationGroup-only — then
 * missed ChangeSpeed entirely, so this walk lives here, shared.)
 */

import { Animation } from './Animation';
import { AnimationGroup } from './AnimationGroup';
import { ChangeSpeed } from './speed/index';

/**
 * Child animations of a container animation, or null when `anim` is a
 * leaf animation that animates its own mobject directly.
 *
 * Containers: AnimationGroup (and its subclasses LaggedStart and
 * Succession) exposes `.animations`; ChangeSpeed wraps a single
 * `.animation` and delegates begin/interpolate/finish/reset to it.
 */
export function childAnimationsOf(anim: Animation): Animation[] | null {
  if (anim instanceof AnimationGroup) {
    return anim.animations;
  }
  if (anim instanceof ChangeSpeed) {
    return [anim.animation];
  }
  return null;
}

/**
 * Flatten an animation tree into every animation it contains, itself
 * first (depth-first, children in order).
 */
export function flattenAnimations(anim: Animation): Animation[] {
  const out: Animation[] = [anim];
  const children = childAnimationsOf(anim);
  if (children) {
    for (const child of children) {
      out.push(...flattenAnimations(child));
    }
  }
  return out;
}
