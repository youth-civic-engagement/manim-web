/**
 * Fade-type Transform animations for manimweb.
 * Includes FadeTransform, FadeTransformPieces, and TransformFromCopy.
 */

import * as THREE from 'three';
import { VMobject } from '../../core/VMobject';
import { Animation, AnimationOptions } from '../Animation';
import { Transform } from './Transform';
import { lerpPoint } from '../../utils/math';
import { worldToParentLocalPosition } from '../../core/MobjectTraversal';
import {
  alignVmobjectPair,
  canMorphByPoints,
  needsLeafPairing,
  pairLeafSnapshotsByIndex,
  type LeafPairByIndex,
} from './TransformPairing';

// ============================================================================
// Leaf-pairing machinery for the group paths
// ============================================================================
//
// FadeTransform / FadeTransformPieces on a group (a VGroup, a multi-part
// MathTex, ...) cannot morph the root's flat point arrays: the old paths
// aligned the LIVE tree in place with alignPoints(), which resampled the
// live children permanently (on the VS2 span scene the glyph leaf count
// went 15 -> 32 at begin() and stayed there), and finish() installed
// only the aligned (resampled) points plus the ROOT color, so a colored
// multi-part target ended in the source's per-part colors on resampled
// geometry. The group paths below pair the two leaf families with
// pairLeafSnapshotsByIndex — the same primitive PointMorphStrategy's
// VGroup path uses — and layer the fade curve on top: points and
// positions interpolate per leaf, opacity follows the fade V-curve per
// leaf, the remaining style channels switch from the source leaf's to
// the target leaf's at the midpoint (where the leaf is fully faded out,
// so the switch is never visible), and finish() installs each target
// leaf's own points and style, exactly like PointMorphStrategy.finish().

interface FadeLeafStyle {
  opacity: number;
  fillOpacity: number;
  strokeWidth: number;
  color: string;
  fillColor: string;
}

interface FadeLeafState {
  child: VMobject;
  startPoints: number[][];
  targetPoints: number[][];
  // Both positions are absolute coordinates in the source root's
  // parent-local frame, computed via
  // worldToParentLocalPosition(*.worldPosition, src.parentWorldMatrix)
  // (the target position deliberately uses the SOURCE snapshot's parent
  // matrix so both live in the same frame — PointMorphStrategy's
  // convention).
  startPosition: THREE.Vector3;
  targetPosition: THREE.Vector3;
  finalTargetPoints: number[][];
  finalTargetSubpathLengths?: number[];
  startStyle: FadeLeafStyle;
  targetStyle: FadeLeafStyle;
}

function captureFadeStyle(m: VMobject): FadeLeafStyle {
  return {
    opacity: m.opacity,
    fillOpacity: m.fillOpacity,
    strokeWidth: m.strokeWidth,
    color: m.color,
    fillColor: m.fillColor || m.color,
  };
}

function captureFadedStyle(m: VMobject): FadeLeafStyle {
  return {
    opacity: 0,
    fillOpacity: 0,
    strokeWidth: m.strokeWidth,
    color: m.color,
    fillColor: m.fillColor || m.color,
  };
}

/**
 * Build one leaf's morph state, mirroring PointMorphStrategy._build:
 * a placeholder source starts as an invisible copy of the target leaf,
 * a padded duplicate joins the scene graph as a real sibling, and a
 * morphable pair is aligned on copies (the live leaf receives the
 * aligned start points, never a resampling of its own tree in place).
 */
function buildFadeLeafState(root: VMobject, pair: LeafPairByIndex): FadeLeafState {
  const { source: src, target: tgt, sourceIsPlaceholder, targetIsPlaceholder, sourceIsNew } = pair;
  const sc = src.leaf;
  const tc = tgt.leaf;
  let child: VMobject = sc;
  if (sourceIsPlaceholder) {
    // Blank filler (only when the source family had zero leaves at
    // all): start as an invisible copy of the target, fading in in
    // place.
    child = tc.copy();
    child.opacity = 0;
    child.fillOpacity = 0;
    root.add(child);
  } else if (sourceIsNew) {
    // A real duplicate of an existing sibling (Manim CE's
    // add_n_more_submobjects): already a full, visible VMobject with
    // its own geometry/style — it just needs to join the scene graph.
    root.add(child);
  }
  const canMorph = canMorphByPoints(sc, tc) && !sourceIsPlaceholder && !targetIsPlaceholder;
  const aligned = canMorph ? alignVmobjectPair(sc, tc) : undefined;
  const startPoints = aligned?.startPoints ?? child.getLocalPoints();
  const targetPoints = aligned?.targetPoints ?? child.getLocalPoints();
  const finalTargetPoints = aligned?.finalTargetPoints ?? child.getLocalPoints();
  const finalTargetSubpathLengths = aligned?.finalTargetSubpathLengths;
  if (aligned) {
    child.setPoints(aligned.startPoints);
    child.setTransformSubpathLengths(aligned.alignedSubpathLengths);
  } else {
    child.setTransformSubpathLengths(undefined);
  }
  const startStyle = sourceIsPlaceholder ? captureFadedStyle(tc) : captureFadeStyle(child);
  const targetStyle = targetIsPlaceholder ? captureFadedStyle(sc) : captureFadeStyle(tc);
  return {
    child,
    startPoints,
    targetPoints,
    finalTargetPoints,
    finalTargetSubpathLengths,
    startPosition: worldToParentLocalPosition(src.worldPosition, src.parentWorldMatrix),
    targetPosition: worldToParentLocalPosition(tgt.worldPosition, src.parentWorldMatrix),
    startStyle,
    targetStyle,
  };
}

function interpolateFadeLeaf(leaf: FadeLeafState, alpha: number): void {
  const child = leaf.child;
  const interpolatedPoints: number[][] = [];
  for (let i = 0; i < leaf.startPoints.length; i++) {
    interpolatedPoints.push(lerpPoint(leaf.startPoints[i], leaf.targetPoints[i], alpha));
  }
  child.setPoints(interpolatedPoints);
  child.position.lerpVectors(leaf.startPosition, leaf.targetPosition, alpha);
  // The fade curve owns opacity. The remaining style channels switch
  // from the source leaf's to the target leaf's at alpha = 0.5, where
  // the leaf is fully faded out, so the switch is never visible.
  const style = alpha < 0.5 ? leaf.startStyle : leaf.targetStyle;
  child.fillOpacity = style.fillOpacity;
  child.strokeWidth = style.strokeWidth;
  child.color = style.color;
  child.fillColor = style.fillColor;
  child.opacity =
    alpha < 0.5
      ? leaf.startStyle.opacity * (1 - 2 * alpha)
      : leaf.targetStyle.opacity * (2 * alpha - 1);
  child._markDirty();
}

const ZERO_POS_OFFSET = new THREE.Vector3();

/**
 * Install a target leaf's own final state (points, topology, style,
 * position). `posOffset` re-expresses the target position from the
 * morph root's parent frame into the root's local frame when the root
 * itself moves to the target root's position (FadeTransform); it is
 * zero when the leaf's parent never moves (FadeTransformPieces).
 */
function finishFadeLeaf(leaf: FadeLeafState, posOffset: THREE.Vector3): void {
  const child = leaf.child;
  child.setPoints(leaf.finalTargetPoints);
  child.position.copy(leaf.targetPosition).sub(posOffset);
  child.opacity = leaf.targetStyle.opacity;
  child.fillOpacity = leaf.targetStyle.fillOpacity;
  child.strokeWidth = leaf.targetStyle.strokeWidth;
  child.color = leaf.targetStyle.color;
  child.fillColor = leaf.targetStyle.fillColor;
  child.setTransformSubpathLengths(leaf.finalTargetSubpathLengths);
  child._markDirty();
}

// ============================================================================
// FadeTransform
// ============================================================================

export interface FadeTransformOptions extends AnimationOptions {
  /** Stretch factor for fading effect */
  stretchFactor?: number;
}

/**
 * FadeTransform animation - transforms with a fade effect.
 * The source fades out while morphing to the target, which fades in.
 */
export class FadeTransform extends Animation<VMobject> {
  /** The target mobject to transform into */
  readonly target: VMobject;

  /** Stretch factor for the fade */
  readonly stretchFactor: number;

  /** Copy of the starting points */
  private _startPoints: number[][] = [];

  /** Copy of the target points */
  private _targetPoints: number[][] = [];

  /** Starting opacity */
  private _startOpacity: number = 1;

  /** Target opacity */
  private _targetOpacity: number = 1;

  /** Transform-time subpath lengths override for compound paths */
  private _alignedSubpathLengths?: number[];

  /** Per-leaf morph states for the group path (null = flat path) */
  private _groupLeafStates: FadeLeafState[] | null = null;

  /** Group root positions (parent-local) captured on the group path */
  private _groupStartPosition = new THREE.Vector3();
  private _groupTargetPosition = new THREE.Vector3();

  constructor(mobject: VMobject, target: VMobject, options: FadeTransformOptions = {}) {
    super(mobject, options);
    this.target = target;
    this.stretchFactor = options.stretchFactor ?? 2;
  }

  override begin(): void {
    super.begin();

    const vmobject = this.mobject;
    this._groupLeafStates = null;

    if (needsLeafPairing(vmobject) && needsLeafPairing(this.target)) {
      // Container (VGroup, MathTex, ...): pair the two leaf families
      // and morph leaf-by-leaf, like PointMorphStrategy's VGroup path.
      // The old path aligned the live tree in place against a copy of
      // the target (what Manim CE's Transform.begin does with
      // align_points): alignPoints padded and resampled the live
      // children permanently, and finish() could then only install
      // the aligned points + the root color — per-part target colors
      // and the target's own per-leaf geometry were lost.
      vmobject.normalizeTransform();
      const normalizedTarget = this.target.copy();
      normalizedTarget.normalizeTransform();
      this._groupStartPosition.copy(vmobject.position);
      this._groupTargetPosition.copy(normalizedTarget.position);
      this._groupLeafStates = pairLeafSnapshotsByIndex(vmobject, normalizedTarget).map((pair) =>
        buildFadeLeafState(vmobject, pair),
      );
      this._alignedSubpathLengths = undefined;
    } else {
      const aligned = alignVmobjectPair(vmobject, this.target);
      this._startPoints = aligned.startPoints;
      this._targetPoints = aligned.targetPoints;
      this._alignedSubpathLengths = aligned.alignedSubpathLengths;
      vmobject.setPoints(this._startPoints);
      vmobject.setTransformSubpathLengths(this._alignedSubpathLengths);
    }
    this._startOpacity = vmobject.opacity;
    this._targetOpacity = this.target.opacity;
  }

  interpolate(alpha: number): void {
    const vmobject = this.mobject;

    if (this._groupLeafStates) {
      for (const leaf of this._groupLeafStates) {
        interpolateFadeLeaf(leaf, alpha);
      }
      return;
    }

    // Interpolate points
    const interpolatedPoints: number[][] = [];
    for (let i = 0; i < this._startPoints.length; i++) {
      interpolatedPoints.push(lerpPoint(this._startPoints[i], this._targetPoints[i], alpha));
    }
    vmobject.setPoints(interpolatedPoints);

    // Fade effect: fade out in first half, fade in in second half
    if (alpha < 0.5) {
      // Fading out
      vmobject.opacity = this._startOpacity * (1 - 2 * alpha);
    } else {
      // Fading in
      vmobject.opacity = this._targetOpacity * (2 * alpha - 1);
    }
  }

  override finish(): void {
    const vmobject = this.mobject;

    if (this._groupLeafStates) {
      // Install each target leaf's own final state, then move the
      // group root to the target root's position (leaf target
      // positions are re-expressed into the root's local frame by
      // subtracting the root's own displacement — the same accounting
      // PointMorphStrategy.finish() does for its VGroup path).
      const posOffset = new THREE.Vector3().subVectors(
        this._groupTargetPosition,
        this._groupStartPosition,
      );
      for (const leaf of this._groupLeafStates) {
        finishFadeLeaf(leaf, posOffset);
      }
      vmobject.position.copy(this._groupTargetPosition);
      vmobject.opacity = this._targetOpacity;
      vmobject.color = this.target.color;
      vmobject._markDirty();
      super.finish();
      return;
    }

    vmobject.setPoints(this._targetPoints);
    vmobject.setTransformSubpathLengths(undefined);
    vmobject.opacity = this._targetOpacity;
    vmobject.color = this.target.color;
    super.finish();
  }
}

/**
 * Create a FadeTransform animation.
 * @param mobject The VMobject to transform
 * @param target The target VMobject
 * @param options Animation options
 */
export function fadeTransform(
  mobject: VMobject,
  target: VMobject,
  options?: FadeTransformOptions,
): FadeTransform {
  return new FadeTransform(mobject, target, options);
}

// ============================================================================
// FadeTransformPieces
// ============================================================================

export type FadeTransformPiecesOptions = AnimationOptions;

/**
 * FadeTransformPieces animation - transforms pieces (submobjects) with fade effect.
 * Each submobject fades and transforms independently.
 */
export class FadeTransformPieces extends Animation<VMobject> {
  /** The target mobject to transform into */
  readonly target: VMobject;

  /** Starting state for each piece */
  private _pieceStates: Array<{
    startPoints: number[][];
    targetPoints: number[][];
    /** The target piece's own (unaligned) points, installed by finish() */
    finalTargetPoints: number[][];
    finalTargetSubpathLengths?: number[];
    startOpacity: number;
    targetOpacity: number;
    /** The target piece's own style, installed by finish() (flat pieces) */
    targetStyle?: FadeLeafStyle;
    alignedSubpathLengths?: number[];
    /** Per-leaf morph states for a container piece (see buildFadeLeafState) */
    leaves?: FadeLeafState[];
  }> = [];

  constructor(mobject: VMobject, target: VMobject, options: FadeTransformPiecesOptions = {}) {
    super(mobject, options);
    this.target = target;
  }

  override begin(): void {
    super.begin();
    this._pieceStates = [];

    const source = this.mobject;
    // cast: fade pieces are always VMobjects; base `children` is Mobject[].
    const sourceChildren = source.children as VMobject[];
    const targetChildren = this.target.children as VMobject[];

    // Handle case where we have submobjects
    if (sourceChildren.length > 0 && targetChildren.length > 0) {
      // Make the pairing well-defined BEFORE any per-piece alignment:
      // Manim CE's FadeTransformPieces.begin() first calls
      // mobject.align_submobjects(target), which pads the shorter
      // side's submobject structure (add_n_more_submobjects) so the
      // pieces pair by index over EQUAL lists. Mirror that: pad the
      // live source in place (a padded duplicate is a real piece,
      // pruned again by reset's begin() bookkeeping); pad a COPY of
      // the target, never the caller's mobject. The previous code
      // instead clamped indices (Math.min(i, len - 1)), so with
      // differing counts one live child served two pieces and was
      // aligned a second time — invalidating the first piece's stored
      // partition ("VGroup.setPoints: expected 134, got 98").
      let srcList = sourceChildren;
      let tgtList = targetChildren;
      const count = Math.max(sourceChildren.length, targetChildren.length);
      if (sourceChildren.length < count) {
        srcList = source._padVmobjectChildrenToCount(count);
      }
      if (targetChildren.length < count) {
        tgtList = this.target.copy()._padVmobjectChildrenToCount(count);
      }
      if (srcList.length !== tgtList.length) {
        throw new Error(
          `FadeTransformPieces: cannot pair ${sourceChildren.length} source pieces with ` +
            `${targetChildren.length} target pieces.`,
        );
      }

      for (let i = 0; i < count; i++) {
        const srcChild = srcList[i];
        const tgtChild = tgtList[i];

        if (needsLeafPairing(srcChild) || needsLeafPairing(tgtChild)) {
          // Container piece (e.g. one part of a multi-part MathTex):
          // morph it leaf-by-leaf, like FadeTransform's group path.
          // The old code aligned the live child in place against a
          // copy of the target child, resampling it permanently, and
          // finish() installed only the aligned points — the target
          // piece's per-leaf colors and own geometry were lost. (The
          // old dispatch also required BOTH sides to be containers; a
          // container paired with a plain leaf fell through to the
          // flat arrays, whose partition across the live child's
          // current counts is the same defect. Leaf pairing handles
          // either side delegating.)
          const tgtCopy = tgtChild.copy();
          const leaves = pairLeafSnapshotsByIndex(srcChild, tgtCopy).map((pair) =>
            buildFadeLeafState(srcChild, pair),
          );
          this._pieceStates.push({
            startPoints: [],
            targetPoints: [],
            finalTargetPoints: [],
            startOpacity: srcChild.opacity,
            targetOpacity: tgtChild.opacity,
            alignedSubpathLengths: undefined,
            leaves,
          });
          continue;
        }

        const aligned = alignVmobjectPair(srcChild, tgtChild);
        this._pieceStates.push({
          startPoints: aligned.startPoints,
          targetPoints: aligned.targetPoints,
          finalTargetPoints: aligned.finalTargetPoints,
          finalTargetSubpathLengths: aligned.finalTargetSubpathLengths,
          startOpacity: srcChild.opacity,
          targetOpacity: tgtChild.opacity,
          targetStyle: captureFadeStyle(tgtChild),
          alignedSubpathLengths: aligned.alignedSubpathLengths,
        });
      }
    } else {
      // No submobjects, treat as single piece
      const aligned = alignVmobjectPair(source, this.target);
      this._pieceStates.push({
        startPoints: aligned.startPoints,
        targetPoints: aligned.targetPoints,
        finalTargetPoints: aligned.finalTargetPoints,
        finalTargetSubpathLengths: aligned.finalTargetSubpathLengths,
        startOpacity: source.opacity,
        targetOpacity: this.target.opacity,
        targetStyle: captureFadeStyle(this.target),
        alignedSubpathLengths: aligned.alignedSubpathLengths,
      });
    }
  }

  interpolate(alpha: number): void {
    const source = this.mobject;
    const sourceChildren = source.children as VMobject[];

    if (sourceChildren.length > 0 && this._pieceStates.length > 0) {
      for (let i = 0; i < sourceChildren.length; i++) {
        const child = sourceChildren[i];
        const state = this._pieceStates[i];

        if (state.leaves) {
          for (const leaf of state.leaves) {
            interpolateFadeLeaf(leaf, alpha);
          }
          continue;
        }

        const points: number[][] = [];
        for (let j = 0; j < state.startPoints.length; j++) {
          points.push(lerpPoint(state.startPoints[j], state.targetPoints[j], alpha));
        }
        child.setPoints(points);
        child.setTransformSubpathLengths(state.alignedSubpathLengths);

        // Fade effect
        if (alpha < 0.5) {
          child.opacity = state.startOpacity * (1 - 2 * alpha);
        } else {
          child.opacity = state.targetOpacity * (2 * alpha - 1);
          // The piece is fading back in as the target: show the target
          // piece's style from the (invisible) midpoint on, so the end
          // of the fade does not pop from the source's colors at
          // finish().
          if (state.targetStyle) {
            child.fillOpacity = state.targetStyle.fillOpacity;
            child.strokeWidth = state.targetStyle.strokeWidth;
            child.color = state.targetStyle.color;
            child.fillColor = state.targetStyle.fillColor;
          }
        }
      }
    } else if (this._pieceStates.length > 0) {
      // Single piece
      const state = this._pieceStates[0];
      const points: number[][] = [];
      for (let j = 0; j < state.startPoints.length; j++) {
        points.push(lerpPoint(state.startPoints[j], state.targetPoints[j], alpha));
      }
      source.setPoints(points);
      source.setTransformSubpathLengths(state.alignedSubpathLengths);

      if (alpha < 0.5) {
        source.opacity = state.startOpacity * (1 - 2 * alpha);
      } else {
        source.opacity = state.targetOpacity * (2 * alpha - 1);
      }
    }
  }

  override finish(): void {
    const source = this.mobject;
    const sourceChildren = source.children as VMobject[];

    if (sourceChildren.length > 0 && this._pieceStates.length > 0) {
      for (let i = 0; i < sourceChildren.length; i++) {
        const child = sourceChildren[i];
        const state = this._pieceStates[i];

        if (state.leaves) {
          // The piece child itself never moves, so leaf target
          // positions install as captured (no root offset).
          for (const leaf of state.leaves) {
            finishFadeLeaf(leaf, ZERO_POS_OFFSET);
          }
          child.opacity = state.targetOpacity;
          continue;
        }

        // Install the target piece's OWN final state — its unaligned
        // points, topology, and style. The old finish() installed the
        // aligned (resampled) points and no style at all, so a piece
        // ended in the source piece's colors on resampled geometry.
        child.setPoints(state.finalTargetPoints);
        child.setTransformSubpathLengths(state.finalTargetSubpathLengths);
        child.opacity = state.targetOpacity;
        if (state.targetStyle) {
          child.fillOpacity = state.targetStyle.fillOpacity;
          child.strokeWidth = state.targetStyle.strokeWidth;
          child.color = state.targetStyle.color;
          child.fillColor = state.targetStyle.fillColor;
        }
        child._markDirty();
      }
    } else if (this._pieceStates.length > 0) {
      const state = this._pieceStates[0];
      source.setPoints(state.targetPoints);
      source.setTransformSubpathLengths(undefined);
      source.opacity = state.targetOpacity;
    }

    super.finish();
  }
}

/**
 * Create a FadeTransformPieces animation.
 * @param mobject The VMobject to transform
 * @param target The target VMobject
 * @param options Animation options
 */
export function fadeTransformPieces(
  mobject: VMobject,
  target: VMobject,
  options?: FadeTransformPiecesOptions,
): FadeTransformPieces {
  return new FadeTransformPieces(mobject, target, options);
}

// ============================================================================
// TransformFromCopy
// ============================================================================

export type TransformFromCopyOptions = AnimationOptions;

/**
 * TransformFromCopy animation - transforms from a copy of the source to target.
 * Useful when you want to show a transformation while keeping the original.
 */
export class TransformFromCopy extends Transform {
  /** The original source mobject (kept unchanged) */
  readonly originalSource: VMobject;

  constructor(source: VMobject, target: VMobject, options: TransformFromCopyOptions = {}) {
    // Create a copy of the source to animate
    const sourceCopy = source.copy();
    super(sourceCopy, target, options);
    this.originalSource = source;
  }
}

/**
 * Create a TransformFromCopy animation.
 * @param source The source VMobject (will be copied)
 * @param target The target VMobject
 * @param options Animation options
 */
export function transformFromCopy(
  source: VMobject,
  target: VMobject,
  options?: TransformFromCopyOptions,
): TransformFromCopy {
  return new TransformFromCopy(source, target, options);
}
