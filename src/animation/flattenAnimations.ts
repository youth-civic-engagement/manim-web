/**
 * The shared walk for "what a play() contains" when animations are
 * grouped: a group schedules only itself, but its children are the
 * animations that actually run.
 *
 * Scene._collectAllAnimations and RecordingScene._collectAll used to
 * keep verbatim copies of this recursion; both now call this one
 * helper, so the live scene and the recording path can never disagree
 * about the contents of a play().
 */

import { Animation } from './Animation';
import { AnimationGroup } from './AnimationGroup';

/**
 * Flatten an animation tree into every animation it contains, itself
 * first (depth-first, children in order).
 */
export function flattenAnimations(anim: Animation): Animation[] {
  const out: Animation[] = [anim];
  if (anim instanceof AnimationGroup) {
    for (const child of anim.animations) {
      out.push(...flattenAnimations(child));
    }
  }
  return out;
}
