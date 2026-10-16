# FIX_NOTES — Player-recorded MathTex throws "VGroup.setPoints: expected N points, got 2N"

> **Chronological lab notebook.** This file records the fix stack in the
> order it happened; later sections supersede earlier ones wherever they
> overlap. It is kept on the fork for our own reference — per-fix PR
> descriptions are distilled from it, and it is not itself submitted
> upstream.

## Summary

Playing `Create`, `Write`, or `FadeIn` on a vector `MathTex` inside a
Player-recorded scene (`player.sequence(...)`) threw:

```
VGroup.setPoints: expected 158 points (sum of children's point counts), got 316.
A VGroup holds no points of its own; the array must partition across its children.
```

(158 = points of `MathTex('x^2')` at fontSize 1 in the test env; the count is
always exactly 2× the true value.) Plain shapes and `MathTexImage` were
unaffected. Fixed at source level; see "Fix" below.

## Repo / environment

- Repo: fork `youth-civic-engagement/manim-web` (upstream `maloyan/manim-web`),
  working copy `~/manim-web` on thinkpad.
- Commit: `c633e8356b9221afa724c7c2c35319bd9009e094` (v0.37.0, `main`).
- Node v20.20.2, npm 10.8.2. Nothing committed, nothing pushed.

## Baseline vs after (full vitest suite, `npm test`)

| Run | Test files | Tests | Failures |
|---|---|---|---|
| Baseline (unmodified c633e83) | 301 passed / 1 failed (302) | 8278 passed / 1 failed (8279) | see below |
| With fix + regression tests | 302 passed / 1 failed (303) | 8286 passed / 1 failed (8287) | same single pre-existing failure |

Pre-existing failure (present before and after, unrelated to this change):
`src/build/browser-bundle.test.ts > Browser bundle > should export key symbols`
— `ReferenceError: navigator is not defined` when the test loads
`dist/manim-web.browser.js` in a Node environment.

The +8 tests after are the new regression file; every baseline-passing test
still passes. Rest of the project gauntlet (`AGENTS.md`) with the fix applied:
`npm run typecheck` ✓, `npm run lint` ✓ (0 errors), `npm run format:check` ✓,
`npm run lint:no-disable` ✓, `npm run knip` ✓ (pre-existing config hint only),
`npm run build` ✓.

## Repro

Minimal, in the project's own test idiom (headless Player + RecordingScene):

```ts
const player = new Player(container, { width: 800, height: 450, headless: true });
const tex = new MathTex({ latex: 'x^2', fontSize: 1 });
await tex.waitForRender();
await player.sequence(async (scene) => {
  await scene.play(new Create(tex)); // Write / FadeIn throw identically
});
```

On unmodified source all three throw with the message above. Stack:
`VGroup.setPoints` (src/core/VGroup.ts) ← `Animation.reset()`
(src/animation/Animation.ts) ← `MasterTimeline.seek()`
(src/animation/MasterTimeline.ts) ← `Player.sequence()` (src/player/Player.ts).

## Root cause

`MathTex.copy()` (src/mobjects/text/MathTex.ts) built the copy's children
**twice**:

1. `new MathTex({...})` — the constructor starts an **async** render
   (`_startRender()` → `_render()` / `_renderMultiPart()`), which, when it
   lands, does `this.add(child)` for every freshly rendered glyph
   (or, multi-part, builds and adds new part groups).
2. `_copyBaseAttributesInto(copy, { copyChildren: true })` — synchronously
   deep-copies the source's already-rendered glyph children into the copy.

Net effect: a copy of a rendered MathTex has the correct children
immediately after `copy()` returns, then **gains a duplicate of every glyph**
when its own render lands (verified by probe: copy goes from 2 children /
158 points to 4 children / 316 points within ~50 ms; multi-part: 3 children /
200 points → 6 / 400).

The Player path trips over this because `Animation.begin()` snapshots the
animated mobject with `mobject.copy()` (`_preAnimationState`), and
`Player.sequence()` ends with `MasterTimeline.seek(0)`, which calls
`anim.reset()`; `reset()` restores points from the snapshot —
`saved.getLocalPoints()` (now 2N) → `liveMobject.setPoints(pts)` — and
`VGroup.setPoints` correctly rejects the 2N array because the live group's
children sum to N. The doubling also silently corrupted any other
`copy()`-based state capture (e.g. `saveState()`/`Restore`,
`PointMorphStrategy` targets) and made plain `tex.copy()` render every
glyph twice (overdraw).

Note the sibling class got this right: `Tex.copy()` passes
`{ copyChildren: false }` (self-building composite convention documented on
`Mobject.copy()`). MathTex could not simply copy that choice: transform
strategies (e.g. `PointMorphStrategy._beginVGroup`) read a copy's leaf
points **synchronously** in `begin()`, so MathTex's copy must stay
synchronously populated — the deep copy has to remain, and the redundant
render is the part that must go.

## Fix (src/mobjects/text/MathTex.ts only, +42/−1)

- New flag `MathTex._discardRenderResult` (default false).
- `MathTex.copy()`: after the deep copy, if the source had already rendered
  (`this.children.length > 0`), set the flag on the copy — its deep-copied
  children are authoritative. If the source had **not** rendered yet, the
  flag stays off: the copy's own render is then the only source of glyphs
  (copy-before-render behavior preserved).

  **Superseded (review repairs, A3):** the decision no longer keys on
  `children.length > 0`; it uses a real `_renderCompleted` flag.
- `_render()` and `_renderMultiPart()`: return immediately after the render
  await when the flag is set, before touching children/`_parts`/scaling.
- `_startRender()`'s catch: a discarded render's failure is not recorded as
  the copy's render error.
- Multi-part support: `_PartGroup` gains a `copy()` override (preserves
  `_latex`/`_color`, returns a real part group; its constructor's unused
  parent parameter is now optional), and `MathTex.copy()` rebinds
  `copy._parts` to the copied part groups, since the discarded render will
  not rebuild them. Before this, multi-part copies were doubly broken:
  glyphs duplicated *and* `_parts` pointed at the redundant render's groups.

No other files changed. Invariant honored: a VGroup's points come from its
leaf children exactly once — the copy now has exactly one population path.

Deliberately left as-is: a *discarded multi-part* render that itself rejects
would still surface through the copy's `waitForRender()` (single-part is
guarded in `_startRender`'s catch). Same latex/options rendered successfully
for the source moments earlier, so this is a theoretical path only.

**Superseded (review repairs, A2):** the multi-part constructor promise now
mirrors `_startRender`'s rejection handling — this path is closed.

## Regression tests

`src/player/recorded-mathtex.test.ts` (8 tests, happy-dom, project style):

- Recorded `Create` / `Write` / `FadeIn` on `MathTex('x^2')` complete
  without throwing; timeline duration > 0; point counts unchanged.
- Seek round-trip (end → 0) keeps point counts stable (exercises
  `Animation.reset()` restore path).
- Root-cause pins: copy of a rendered MathTex keeps children/point counts
  after its render settles; multi-part copy keeps parts (`getPart(0/2)`
  counts) and totals; copy of a not-yet-rendered MathTex still gets glyphs
  from its own render.
- Verified against unmodified source: 7 of 8 fail there (the
  copy-before-render test passes on both, as that path was never broken).

## wb scenario check (against the fixed build)

Covered programmatically by the regression test "records a mixed scene:
Write on MathTex + Create/Transform on shapes" in
`src/player/recorded-mathtex.test.ts`:

- Player scene records `Write` on vector `MathTex('x^2')` (not MathTexImage),
  `Create` on a `Square`, and `Transform` of the square to a `Circle`.
- Result: records and seeks without throwing, timeline duration > 0,
  MathTex point count stable across seek(0) / seek(end).

## Working tree

Left uncommitted for review: `git diff` = `src/mobjects/text/MathTex.ts`
(+42/−1); new untracked file `src/player/recorded-mathtex.test.ts`;
this `FIX_NOTES.md`. No pushes, no issues/PRs (upstreaming is a separate
decision).

---

# Addendum 2026-10-13 — F1: Transform/FadeTransform between VGroups (MathTex morphs)

Committed locally as `fbbc112` on branch `fix/group-alignment-transforms`
(stacked on `686b2a2`, the copy fix above — which was committed after the
notes above were written; nothing pushed).

## Summary

Player-recorded `Transform` between any two `MathTex` threw
`VGroup.setPoints: expected <target>, got <unaligned>` (x^2→x^3: expected
173, got 158; x^2→x^2+1: expected 316, got 158), and `FadeTransform` threw
`alignVmobjectPair: alignPoints fallback produced mismatched point counts`
on every pair tried. Single-mobject morphs (Square→Circle) worked. Fixed
in the generic group-alignment path; no MathTex special-casing.

## Root cause

Two compounding defects:

1. **Group alignment was a no-op.** `VMobject.getEffectiveSubpathLengths()`
   returns `undefined` for a leaf-less group (its own `_points3D` is empty),
   so `VMobject.alignPoints()` — whose compound path requires lengths from
   both sides — returned both mobjects unchanged, and morph setup fell back
   to the raw, mismatched flat point arrays. Python Manim instead aligns
   groups RECURSIVELY: pad the shorter submobject list (repeat-index
   duplication, `add_n_more_submobjects`) and align pairwise per leaf.
2. **Reset flattened through the live group.** `PointMorphStrategy`'s
   VGroup path mutates live leaf point counts during `begin()` (and
   `alignPointsWithPathFunc` appends duplicate children), but
   `Animation.reset()` restored state with one flat
   `setPoints(snapshotPoints)` on the group, which partitions by the
   children's CURRENT counts — guaranteed mismatch after any begin-time
   mutation.

## Fix (3 generic pieces)

- `src/core/VMobject.ts` — `alignPoints()` gains a recursive group branch:
  when neither side has own points and both have VMobject children, pad the
  shorter child list by duplicating its own children (CE repeat-index
  selection `floor(i * n / L)`), then recurse pairwise. Mixed leaf↔group
  pairs keep existing behavior.

  **Correction (review repairs, B4):** the selection formula is CE's, but
  as shipped the indices were computed over the SOURCE range, so for a
  2→4 pad the duplicates landed at the END (`[A,B,B′,B″]`) instead of
  interleaved after their sources (`[A,A,B,B]`, CE's actual distribution
  and this library's own `TransformPairing.padByDuplication`). The claim
  above was therefore wrong as shipped; B4 below fixes the range and the
  child-list insertion order.
- `src/animation/transform/FadeTransforms.ts` — `FadeTransform.begin()`:
  when both sides need leaf pairing, align the LIVE mobject against
  `target.copy()` (CE `Transform.begin` semantics — the live object is
  aligned so its reset snapshot matches the interpolation start) and take
  flat start/target points from that aligned pair; otherwise the previous
  `alignVmobjectPair` path is used unchanged.
- `src/animation/Animation.ts` — `reset()` restores via a new
  structure-aware `restorePointsFromSnapshot(live, saved)`: leaf →
  `setPoints(saved)`; container → recurse children pairwise by index; if a
  level's child count diverged during the animation, replace that level's
  live VMobject children with copies of the snapshot's.

Assertion note for future group-morph tests: exact flat-point equality
after a morph is only valid when no padding was involved AND no
normalization re-anchoring offsets exist (MathTex point arrays are
font-local; morphs interpolate in world space). The tests assert
world-space leaf correspondence instead (`expectLeavesOnTarget` over
`collectLeafVMobjectSnapshots`).

## Regression tests

`src/player/recorded-group-transform.test.ts` (9 tests): recursive
alignment unit tests (equal child counts zero-pad; padding by duplicating
the smaller side's own children; nested subgroups), recorded Transform
x^2→x^3 with exact end-state equality, Transform with different child
counts (x^2→x^2+1), recorded FadeTransform on MathTex, nested-VGroup
morph, FadeTransform between plain VGroups, Square→Circle guard.

## Test counts

| Stage | Tests |
|---|---|
| Baseline (copy-fix branch) | 8286 passed / 1 failed |
| After F1 | 8295 passed / 1 failed (+9 new) |

The 1 failure is the same pre-existing, unrelated
`src/build/browser-bundle.test.ts` (`navigator is not defined`).
Gauntlet: typecheck ✓, lint ✓ (0 errors), format:check ✓,
lint:no-disable ✓, knip ✓, build ✓.

## Known leftovers (same pattern, out of scope here)

- `ClockwiseTransform` / MovementTransforms construct a PointMorphStrategy
  that flattens groups the same way; their `reset()` now benefits from the
  structure-aware restore, but their begin-time leaf handling was not
  exercised by the battery.
- Mixed leaf↔group `Transform` takes a flat path in PointMorphStrategy
  that can still mismatch counts in edge cases.
- `restoreMobjectStateImpl` (`src/core/MobjectState.ts`) uses the same
  flat-setPoints-on-group pattern for SaveState/Restore.

---

# Addendum 2026-10-13 — F2: seek() blanking mobjects first animated inside animation groups

Committed locally as `bd313e1` on branch `fix/laggedstart-seek` (stacked
on `fbbc112`).

## Summary

`player.seek(t)` into or after a segment whose animations are grouped
(`LaggedStart` of three `Write`s in the repro scene) rendered a blank
canvas, even though the grouped animations' own state at time t was
correct (verified by instrumentation: dash-reveal fractions after seek
were 0.82/0.87/0.11 at t=1.2 — mid-Write, exactly right).

## Root cause

`MasterTimeline.addSegment()` (src/animation/MasterTimeline.ts) recorded
first-appearance tracking — `_mobjectFirstSegment` and
`_savedMobjectOpacities`, which `seek()`/`update()` use to hide mobjects
"not introduced yet" — only for TOP-LEVEL animations. A mobject whose
first animation was nested inside a `LaggedStart` was never attributed to
that segment; it was attributed to the first later segment where it
appeared at top level — in the repro, the parallel-`FadeOut` segment at
t=2.6s. `seek()` therefore set all three formulas' root opacity to 0 for
every t < 2.6s, and the Player rendered the (correctly revealed but fully
transparent) state. `RecordingScene` already flattens groups for scene
membership (`_collectAll`); `addSegment` just never received the
flattened list.

## Fix (src/animation/MasterTimeline.ts only)

`addSegment()` now flattens grouped animations (new module-level
`flattenAnimations()` — recursive over `AnimationGroup.animations`, which
covers `LaggedStart` and `Succession`) when populating the two tracking
maps. Scheduling is untouched: children are NOT passed to
`addParallel`/segment animations — the group still drives them.

## Regression tests

`src/player/recorded-lagged-seek.test.ts` (5 tests): seek state equals
stepped-playback state (root opacity + stroke-reveal fraction) at
t = 1.2 / 2.2 / 3.1 across two independent Player instances; visibility
inside and after the LaggedStart segment; guard that a mobject first
animated in a later segment stays hidden before it; group-only mobjects
in a later LaggedStart are hidden before their segment; Succession
children attributed to the Succession segment. Note: a Write's reveal
fraction plateaus below 1 until its group finishes (two-phase
stroke/fill) — identical under seek and playback; tests assert the
seek≡playback invariant rather than the plateau value.

## Test counts

| Stage | Tests |
|---|---|
| After F1 | 8295 passed / 1 failed |
| After F2 | 8300 passed / 1 failed (+5 new) |

Same single pre-existing failure as above. Gauntlet all ✓ (as F1).

## wb integration (F1 and F2)

After each fix: fresh `*.bak-f1-*` / `*.bak-f2-*` backups in `~/wb/app`,
`npm pack` on the fix branch, reinstall into `~/wb/app`, vite build,
`systemctl --user restart wb`, CDP verification
(`~/wb/verify-manim/verify-f1.cjs`, `verify-f2.cjs`). Gotcha recorded:
npm may silently reinstall the CACHED old tarball — if the built chunk
hash does not change, remove `node_modules/manim-web`, delete the
`packages: "node_modules/manim-web"` entry from `package-lock.json`
(stale integrity pin), `npm cache clean --force`, reinstall, and confirm
`diff -rq` of the two `dist` trees is empty.

Board evidence: Stress Lab step 2 (Write ∫x²dx → Transform to x³/3 + C →
FadeTransform to d/dx(x³/3) = x²) plays end-to-end with no error block;
mid-morph, exact-end-state, and fade frames captured and inspected.
Stress Lab step 3 seeks to 30% (t=1.2) and 55% (t=2.2) now render all
three identities (previously blank); FadeOut region also correct.
Anim Lab and VS1b pages unaffected; zero console errors throughout.

---

# Review repairs (branch `fix/review-repairs`)

Three adversarial reviewers confirmed every headline claim above but
judged all three fixes defective on sibling paths. This round fixes
every finding; each item landed test-first (the new test failed on the
pre-repair code, then passed) — with four exceptions, noted where the
tests are listed: two in Block C ("nested groups attribute children to
the outer segment (C2/C3)" and "seeks at segment boundaries and
backward seeks are consistent") and two in Block A ("multi-part copy
of a copy keeps its parts and point count", and the single-part A2
guard test "single-part: a discarded copy resolves waitForRender when
its redundant render rejects", which pins the original `686b2a2`
guard) are regression pins that also pass on the pre-repair code.
Commits: `f8271af` (Block A), `02fb278`
(Block B), `41d5ee7` (Block C).

## Block A — MathTex.copy() multi-part holes (`src/mobjects/text/MathTex.ts`)

- **A1 — pre-render multi-part copies were silently empty.** `copy()`
  rebuilt the copy's LaTeX from `_parts`, which is empty until
  `_renderMultiPart()` lands. Fix: the constructor retains the original
  split strings in `_latexParts`; `copy()` rebuilds from them. (Round 2
  removed the `?? _parts` fallback this originally shipped with: the
  constructor sets `_latexParts` in the same branch that sets
  `_isMultiPart`, so the fallback was unreachable.)
- **A2 — the discarded-render error guard covered only single-part.**
  A discarded multi-part copy's constructor render promise had no
  rejection handler (unhandled rejection / spurious `waitForRender()`
  failure). Fix: the multi-part promise now mirrors `_startRender`'s
  handling — failures are swallowed for discarded copies, otherwise
  logged and recorded as `_renderError`.
- **A3 — discard keyed on a proxy.** The discard decision used
  `children.length > 0`; it now uses a real `_renderCompleted` flag set
  at the end of `_render()`/`_renderMultiPart()` (and propagated to
  copies, so copy-of-copy works). Bundled rider in the same commit: the
  multi-part constructor's render chain gained a `.then(_markDirty)`
  for parity with the single-part path (`_startRender` already marked
  dirty), so a multi-part MathTex re-renders its mesh when its first
  render lands.
- Tests (`src/player/recorded-mathtex.test.ts`): "copy of a
  not-yet-rendered multi-part MathTex keeps its parts and points after
  settle", "multi-part copy of a copy keeps its parts and point count"
  (a regression pin — it also passes on the pre-repair code).
  New file `src/player/recorded-mathtex-render-error.test.ts`:
  "multi-part: a discarded copy resolves waitForRender when its
  redundant render rejects", "single-part: a discarded copy resolves
  waitForRender when its redundant render rejects" (a regression pin —
  it guards the original `686b2a2` behavior and also passes on the
  pre-repair code), "a NON-discarded
  multi-part render failure still surfaces via waitForRender".

## Block B — F1 alignment repairs

- **B1 — snapshot restore detached identity.** On child-count
  divergence, `restorePointsFromSnapshot` replaced the live children
  with copies of the snapshot's — after any padded morph + seek/reset,
  `MathTex._parts` no longer pointed at the live children and
  `setColorByTex` silently no-oped. The only divergence producers
  APPEND duplicate leaves, so: growth now drops exactly the fabricated
  extras (`alignPoints` records its interleaved duplicates on the owner
  via `_alignmentPaddedChildren`; unrecorded extras come off the end)
  and restores survivors pairwise; copy-replacement remains only for
  shrinkage. (Round 2 replaced this bookkeeping wholesale — the
  single-slot `_alignmentPaddedChildren` record broke on any second
  morph; see "Repair round 2".) Tests
  (`src/player/recorded-group-transform.test.ts`):
  "Transform begin/reset restores the exact pre-animation children
  (B1)", "recorded Transform + seek(0) keeps the original children in
  place (B1)", "Transform + seek(0) preserves MathTex parts;
  setColorByTex recolors live (B1)".
- **B2 — FadeTransformPieces kept the original crash for group
  children** (it aligned copies, then applied the flat arrays to
  unaligned live children). Fix: per child pair it now aligns the live
  source child against a copy of the target child (the FadeTransform
  root treatment) and validates the combined totals. Tests:
  "records FadeTransformPieces between multi-part MathTex, one part
  (B2)", "records FadeTransformPieces between multi-part MathTex, two
  parts (B2)".
- **B3 — FadeTransform's group branch dropped length validation** (a
  (nonempty, empty) subgroup pair passed `begin()` and threw a raw
  TypeError mid-animation). Fix: `begin()` throws a descriptive
  `FadeTransform: alignPoints produced mismatched point counts (X vs Y)`
  when post-alignment totals diverge. Test: "FadeTransform fails at
  begin() when a subgroup is empty on one side (B3)".
- **B4 — padding distribution** (see the correction in the F1 section):
  `_padChildrenToCount` now uses the repeat-index rule over the FULL
  target range and inserts each duplicate immediately after its source
  in the child list — one rule, shared in spirit with
  `TransformPairing.padByDuplication` (which pads point lists, not
  child lists, so the two cannot literally share code). Tests:
  "alignPoints distributes padding duplicates immediately after their
  source (B4)", "alignPoints padding pairs the same leaves as
  pairLeafSnapshotsByIndex (B4)".
- **B5 — containers gained phantom points.** `alignPoints` wrote
  interpolated origin points into container nodes (empty VGroup vs
  Square), which then survived reset as a phantom rendered leaf. Fix:
  a point-less mobject that delegates points to children (VGroup class
  flag, or any mobject with VMobject children) returns from
  `alignPoints` untouched. Tests: "alignPoints never writes own points
  into a container (B5)".
- Block B test delta: `recorded-group-transform.test.ts` 9 → 18 tests.

## Block C — F2 seek repairs

- **C1 — `createdAtBeginning` regression (introduced by F2).** F2's
  flattening enrolled group children into MasterTimeline's tracking
  maps, but `seek()`'s hide loop lacked the exemption `update()` has
  always honored: mobjects added via `scene.add()` (visible from t=0)
  first animated inside a group were hidden by seek for the whole span
  before their segment. Fix: the hide loop skips
  `createdAtBeginning` mobjects (covers the top-level case too — same
  loop). Tests (`src/player/recorded-lagged-seek.test.ts`): "pre-added
  mobjects first animated inside a LaggedStart stay visible under seek
  (C1)", "pre-added mobjects first animated at top level stay visible
  under seek (C1)".
- **C2/C3 — one shared flattening walk.** `flattenAnimations` existed
  in THREE verbatim copies (MasterTimeline, RecordingScene, Scene),
  all AnimationGroup-only — so `ChangeSpeed` (which wraps a single
  `.animation`) reproduced F2 exactly. Fix: new
  `src/animation/flattenAnimations.ts` exports `childAnimationsOf`
  (AnimationGroup → `.animations`; ChangeSpeed → `[.animation]`; else
  null) and `flattenAnimations` (self-first DFS); all three consumers
  use it, private copies deleted. RecordingScene/Scene results for
  AnimationGroup trees are unchanged (same order). Tests:
  "ChangeSpeed-wrapped animations are attributed to their own segment
  (C2)", "nested groups attribute children to the outer segment
  (C2/C3)", "seeks at segment boundaries and backward seeks are
  consistent". Of these, the last two also pass on the pre-repair code
  — they are regression pins, not sensitive tests (correcting the
  test-first claim in this section's introduction).
- **Stretch:** container animations no longer enter MasterTimeline's
  tracking maps at all (their mobjects are dummy placeholders).
- **Disclosed side effect (found in re-review, pinned in round 2):**
  converting `Scene._collectAllAnimations` to the shared walk also
  changed LIVE `Scene.play` semantics for ChangeSpeed — at any
  nesting depth (wrapper around groups, groups containing wrappers,
  nested wrappers): the wrapped
  animation's mobject now joins the scene (previously Scene saw only
  the wrapper's dummy mobject), and a wrapped remover is honored by
  `cleanUpFromScene`. Both are deliberate and Manim-consistent (CE's
  ChangeSpeed is transparent to scene membership). Pinned by tests in
  `src/core/Scene-add-render.test.ts`: "live ChangeSpeed(FadeIn) adds
  the wrapped mobject to the scene", "live ChangeSpeed(FadeOut)
  honors the wrapped remover" — both fail on the pre-C code
  (`75b87bf`), pass after.
- **Known issue (pre-existing, OUT of this stack's scope):**
  `seek(end)` then `seek(0)` leaves not-yet-begun `Write` animations
  fully revealed instead of dash-masked — `Animation.reset()` /
  `Timeline.seek` never re-applies Write's begin-time dash masking for
  animations not re-begun at the target time. Visible for pre-added
  mobjects. Verified present at `75b87bf` (this stack's tip before the
  C repairs); NOT claimed identical on upstream — probes at real
  upstream `c633e83` show different behavior (upstream seek hides the
  pre-added form outright, and the single-segment form re-masks
  correctly). Follow-up,
  not fixed here.

## Test counts

| Stage | Tests |
|---|---|
| After F2 (baseline) | 8300 passed / 1 failed |
| After review repairs | 8319 passed / 1 failed (+19 new tests, all passing) |

Same single pre-existing failure (`src/build/browser-bundle.test.ts`,
`navigator is not defined`). Gauntlet all ✓: typecheck, typecheck:tests,
lint (0 errors; 93 warnings — identical to the unmodified stack),
format:check, lint:no-disable, knip, build.

## wb integration (review repairs)

Backups `*.bak-repairs-20261013-142059` in `~/wb/app` (board-state,
package.json, package-lock.json). `npm pack` from the repairs worktree,
reinstall with the cache remedy above, `diff -rq` of the dist trees
empty, vite build, `systemctl --user restart wb`. Two probe steps were
added to the Manim Stress Lab page (scene sources in `~/wb/manim-demo/`):

- **Probe R1 — Morph then recolor (step 6):** `Transform` of a 1-part
  `x^2` into 2-part `x^2+1`. After a seek(0) → seek(0.95) cycle, in-page
  state: `getPart(0) === children[0]`, both live leaves recolor
  `#FFFFFF` → `#FC6255` via `setColorByTex('x^2', RED)` (pre-repair this
  silently no-opped). Frames captured (`repairs-recolor*.png`).
- **Probe R2 — Pre-added + LaggedStart seek (step 7):** `scene.add()`
  formulas first animated in segment 2's LaggedStart read opacity 1
  under seek at t=0.5 (before the segment) and t=1.75 (inside it);
  frames show all formulas on stage at both times
  (`repairs-preadded-*.png`).

Full verification (`~/wb/verify-manim/verify-repairs.cjs`): Stress Lab
steps 1–5 replay clean, both probes pass, Anim Lab demo and VS1b
unaffected, zero console errors — 21/21 PASS. Board left healthy with
Anim Lab active.

# Repair round 2 (branch `fix/review-repairs-2`)

A second adversarial re-review judged Block A and Block C READY AFTER
NITS and Block B NOT READY (three blockers). This round fixes the
blockers and the nits. Commits: `e305092` (Block B), `0fb65b8`
(Block A), plus the Block C test/docs commit. Governing rule: clean,
minimal, obviously-correct — delete fragile machinery rather than add
more.

## B1 redesign — per-animation restore bookkeeping

- Round 1's `_alignmentPaddedChildren` was a single slot ON THE
  MOBJECT, overwritten by every `alignPoints` call: any SECOND morph
  of the same formula corrupted it, and MasterTimeline's forward-order
  resets consumed the shared record, fell into the copy-rebuild
  shrinkage branch, and detached the original parts.
- Replacement: `Animation.begin()` also captures the mobject's child
  identity lists per subtree node (`captureChildIdentities`);
  `restorePointsFromSnapshot` removes exactly the children its own
  begin() did not record and restores the recorded survivors pairwise
  by begin index. The mobject field, its `_take` accessor, and the
  recording in `_padChildrenToCount` are DELETED, as is the shrinkage
  copy-rebuild branch (no begin()-time producer removes children; it
  was reachable only via the reset-ordering artifact). If the
  snapshot's child count ever disagrees with the record, restore
  throws descriptively instead of installing copies. A recorded child
  already pruned by an earlier animation's reset is skipped (playback
  re-begins that animation and rebuilds it).
- Contract, stated precisely (round 1 overclaimed): after a morph +
  seek(0), the original children keep their identity — at their
  INDICES for `Transform` (its strategy appends duplicates at the
  root end), as MEMBERS for `FadeTransform` (its alignment interleaves
  duplicates after their sources, so an original can sit at
  children[2], not children[1]).
- Reset contract — swap semantics: restore returns subtree membership
  to the begin() set. A child REPLACED mid-flight is pruned, not
  restored, and the original is not resurrected (pure additions are
  pruned the same way). Unreachable with any shipped animation:
  nothing in `src/animation` adds or removes children inside its own
  mobject's subtree during begin()/interpolate — wrappers and
  indication animations add to parents, outside the animated subtree.
- Tests (`recorded-group-transform.test.ts`): "two sequential
  Transforms + seek(0) keep the original parts in place (B1
  redesign)", "two sequential FadeTransforms + seek(0) keep the
  original parts as members (B1 redesign)", "Transform + repeated seek
  cycles keep the original children in place (B1 redesign)". The first
  two FAIL on the pre-fix code (part detached / copy installed); the
  third passes pre-fix too — it is a pin.

## B2 residual — FadeTransformPieces with differing part counts

- The piece loop clamped indices (`Math.min(i, len - 1)`), so with
  differing counts one live child served two pieces and was aligned
  twice, invalidating the first piece's stored partition: the
  original crash returned verbatim ("VGroup.setPoints: expected 134,
  got 98" inside `interpolate`).
- Fix mirrors Manim CE: CE's `FadeTransformPieces.begin()` first
  calls `mobject.align_submobjects(target)` — the shorter side's
  submobject structure is padded (`add_n_more_submobjects`) so pieces
  pair by index over EQUAL lists. Here: begin() pads the live source
  in place via `VMobject._padVmobjectChildrenToCount` (the same
  operation `alignPoints` uses), pads a COPY of the target, throws
  descriptively if the lists still differ, and `_pieceStates` is
  cleared per begin. All `Math.min` clamps removed (begin /
  interpolate / finish now index directly).
- Tests: "records FadeTransformPieces with differing part counts,
  2 -> 3 (B2 residual)" (FAILS pre-fix with the verbatim crash),
  "records FadeTransformPieces with differing part counts, 3 -> 2
  (B2 residual)" (passes pre-fix — a pin). The two shipped
  equal-count B2 tests now assert per-leaf centroid geometry instead
  of point-TOTAL equality, which held only coincidentally (B-wording).
- Note — `begin()` is not atomic on the validation-throw path: the
  descriptive throw can fire after the root padding and earlier
  pieces' live alignment, leaving the source padded/part-aligned
  until a reset repairs it (the same shape as `FadeTransform`'s
  validation). Error-path only — never a wrong frame.

## B-mixed — sequential mixed morphs

- `Transform` then `FadeTransform` on one multi-part MathTex threw at
  the second begin() ("alignPoints produced mismatched point counts
  (448 vs 585)"): Transform leaves fabricated duplicate LEAVES at the
  root, so the next alignment's level-by-level pairing matched leaves
  against the target's part GROUPS, aligned nothing for those pairs,
  and the totals diverged.
- Fix: `alignPoints`' container branch first checks whether the
  padded child sequences pair like-with-like (`_childClassesAlign`,
  the same repeat-index rule). If any pair is mixed, it falls back to
  `_alignLeafFamilies`: pad the shorter side's point-leaf family by
  duplicating its own leaves (inserted after their sources, Manim
  CE's family-level `add_n_more_submobjects`), then align pairwise —
  flat point arrays partition in family order, so the pairing is
  sound. Every input that worked before takes the identical code
  path; only the previously-diverging shape changes behavior.
- Tests: "Transform then FadeTransform on one multi-part MathTex
  plays end-to-end (B-mixed)" (FAILS pre-fix: throws at the second
  begin), "FadeTransform then Transform on one multi-part MathTex
  plays end-to-end (B-mixed)" (FAILS pre-fix: parts detached after
  seek(0)). Final states assert the last target's geometry (per-leaf
  points for Transform, per-leaf centroids for FadeTransformPieces /
  FadeTransform finishes); seek(0) asserts the B1 contract per kind.

## Block A nits

- A-T1: the discriminating A3 test the shipped one lacked — a child
  added by hand to an UNRENDERED MathTex, then `copy()`: the copy
  must end with the manual child AND its rendered glyphs. Tests:
  "copy of an unrendered MathTex with a manually added child keeps
  the child AND the glyphs (A3)" and its multi-part variant.
  Sensitivity: scratch-reverting the discard decision to the pre-A3
  `children.length > 0` proxy makes exactly these two tests fail.
- A-T2: Block A's quoted test titles above are now the real shipped
  ones; the `_markDirty` parity rider in `f8271af` is disclosed in
  the A3 bullet; the `_renderCompleted` comment now states that a
  copy carries the flag with no render applied (it "presents as
  rendered"); the unreachable `?? this._parts.map(...)` fallback in
  `copy()` is removed (the constructor sets `_latexParts` in the
  same branch that sets `_isMultiPart`; nothing else sets either).

## Block C nits

- C-T1: the live `Scene.play` ChangeSpeed behavior change is
  disclosed in Block C above and pinned by "live ChangeSpeed(FadeIn)
  adds the wrapped mobject to the scene" and "live
  ChangeSpeed(FadeOut) honors the wrapped remover"
  (`src/core/Scene-add-render.test.ts`). Sensitivity: both FAIL on
  the pre-C code (`75b87bf`, scratch worktree), pass after.
- C-T2: the test-first claim is corrected in the introduction and
  the C2/C3 bullet: two of the five C tests are regression pins.
- C-T3: the pre-existing Write-dash seek wart is documented in
  Block C as a known issue, explicitly out of this stack's scope.
  Not fixed.

## Test counts

| Stage | Tests |
|---|---|
| After review repairs (round 1) | 8319 passed / 1 failed |
| After repair round 2 | 8330 passed / 1 failed (+11 new tests) |

Same single pre-existing failure (`src/build/browser-bundle.test.ts`,
`navigator is not defined`; the file skips in unbuilt trees).
Gauntlet all ✓: typecheck, typecheck:tests, lint (0 errors; 93
warnings — identical to round 1), format:check, lint:no-disable,
knip, build.

## wb integration (repair round 2)

Backups `*.bak-rr2-20261013-165804` in `~/wb/app` (board-state,
package.json, package-lock.json). `npm pack` from the round-2
worktree; the app's `manim-web` dependency now points at
`file:/home/binliu/manim-web-rr2/manim-web-0.37.0.tgz`; reinstall with
the cache remedy, `diff -rq` of the dist trees empty, vite build,
`systemctl --user restart wb`. New Stress Lab step 8, **"Double
morph"** (scene `~/workspace/wb/manim-demo/stress8-double-morph.js`):
one multi-part MathTex (`['x^2','+1']`) morphed TWICE in one recorded
scene — `Transform` to `['x^3','+1','+y']`, then `FadeTransform` to
`['z^2','-1']`.

Verification (`~/wb/verify-manim/verify-rr2-v3.cjs`, camera-framed
stage identification — DOM-index matching proved unreliable across
player rebuilds): 23/23 PASS — all 8 Stress Lab steps build + play
with no error blocks and no console errors; step 8 (duration 4.7s)
frame-verified —
seek(0) shows `x^2 + 1` with parts intact after the full double
morph, mid shows `x^3 + 1 + y`, end shows `z^2 - 1`, seek cycle
deterministic (end frames byte-identical), two focus replays pass.
Stress 3 frame-verified separately (its stage at 55% shows all three
identities, matching round 1's frames; round 2 did not touch the
F2/MasterTimeline code). Anim Lab demo unaffected; board left
healthy with Anim Lab active.

## Repair round 3 — copy() starts no render (supersedes the discard mechanism)

The copy fix landed in 686b2a2 and was repaired twice (A2/A3), but its
mechanism was the stack's one remaining indirection: the copy's
constructor started a full MathJax→SVG render, and copy() then set
`_discardRenderResult` so that render threw its result away when it
landed. Two costs: (1) every `Animation.begin()` snapshot of a rendered
MathTex — the recorded path copies constantly — paid for a complete
render whose only fate was the bin; (2) "start, then discard" states
the rule backwards, and the flag's semantics misled two rounds of
review comments (the decision is "the deep copy is this copy's
geometry", and it belongs at construction time). Per the standing bar
— clean, minimal, obviously correct — the mechanism, not just its
comments, was replaced. Branch `fix/copy-skip-render` (from ed951ee).

What changed (`src/mobjects/text/MathTex.ts` only):

- copy() now decides BEFORE constructing: if the source's render has
  completed (`_renderCompleted`, unchanged), it marks the options with
  a module-private symbol token (`SKIP_RENDER`); the constructor reads
  the token and does not start a render — single-part and multi-part
  alike. The copy's `_renderPromise` stays null; `waitForRender()`
  already tolerates null and resolves at once. The deep copy, the
  `_renderCompleted` marking, and the multi-part `_parts` rebinding
  are exactly as before.
- The token is a symbol key on the options object: it never enters
  the public `MathTexOptions` type and never appears in the built
  typings (the dist `MathTex.d.ts` diff vs the round-2 build shows
  only the removal below plus a comment rewording; the constructor
  signature is unchanged), and only code in this module can set it.
  Tex — the one subclass — is untouched and unaffected: its copy()
  passes `copyChildren: false`, so its constructor-started render is
  its only glyph source and still runs.
- A copy of an UNRENDERED source is unchanged: no token, its own
  render starts, and a failure surfaces via waitForRender() exactly
  like a plain instance's.
- Removed completely (each existed solely for discarded copies):
  the `_discardRenderResult` field; the early returns keyed on it in
  `_render()` and `_renderMultiPart()`; and the discard checks in the
  two render-failure catches (the constructor's multi-part chain and
  `_startRender`). For non-copy instances the flag was always false,
  so normal render-error behavior is semantically unchanged.
  `_PartGroup.copy()` was checked: it builds a plain VGroup and never
  renders — left alone.

Tests (`src/player/recorded-mathtex-render-error.test.ts`, rewritten;
the mock now counts `renderLatexToSVG` invocations):

- Replaced — they pinned the removed mechanism (a discarded render
  whose failure is forgiven): "multi-part: a discarded copy resolves
  waitForRender when its redundant render rejects" and its single-part
  twin → "multi-part / single-part: copy of a rendered MathTex starts
  no render and keeps parts and points". The renderer is set to FAIL
  and asserted never invoked; waitForRender() resolves, the render
  error is null, parts/points are exact. The guarantee the A2 tests
  protected — a rendered-source copy can never fail waitForRender()
  over a copy-side render — now holds by construction.
- Added: "multi-part: copy of a copy of a rendered MathTex starts no
  render either" (zero invocations at both generations).
- Added (preservation pin): "copy of an unrendered MathTex starts
  exactly one render" — passes on the old implementation too.
- Added (replacement guarantee): "copy of an unrendered MathTex
  surfaces a render failure via waitForRender".
- Kept: "a NON-discarded multi-part render failure still surfaces via
  waitForRender" — unchanged except the mock's error string
  ("boom-redundant-render" → "boom-render": no render in this file is
  redundant anymore).
- `recorded-mathtex.test.ts`: assertions untouched; comments that
  described the discard mechanism updated to the new one.

Sensitivity (test-first discipline): the two test files, run against
the pre-rework tree (ed951ee, the discard implementation), fail in
EXACTLY the three zero-render tests and pass the other 15 — both
preservation/guarantee pins and all 12 real-renderer tests included.
On this branch: 18/18.

Suite: 8333 passed / 1 failed in a built tree (8334 tests) — +3 net
new tests over round 2's 8330/1; the one failure is the same
pre-existing `src/build/browser-bundle.test.ts` (`navigator is not
defined`; the file skips in unbuilt trees). Gauntlet all ✓:
typecheck, typecheck:tests, lint (0 errors; 93 warnings — identical
to rounds 1–2), format:check, lint:no-disable, knip, build.

## wb integration (repair round 3)

Backups `*.bak-rr3-20261013-2052` in `~/wb/app` (package.json,
package-lock.json, and the previous node_modules/manim-web tree at
`node_modules-manim-web.bak-rr3-20261013-2052`). `npm pack` from the
round-3 worktree; the app's `manim-web` dependency now points at
`file:/home/binliu/manim-web-rr3/manim-web-0.37.0.tgz`; reinstall
with the cache remedy. The installed dist differs from the round-2
backup in exactly the bundle files + `MathTex.d.ts` (chunk hash
changed; `_discardRenderResult` absent from the installed dist, the
skip token present); vite build; `systemctl --user restart wb`;
health ok (4 pages, Manim Stress Lab active, 8 steps).

Verification (`~/wb/verify-manim/verify-rr2-v3.cjs`): the first run
scored 22/23 — Stress 1's player was not yet built inside the
harness's settle window on the cold first load of the rebuilt bundle
(no error blocks, no console errors); the warm re-run scored 23/23
PASS — all 8 Stress Lab steps build + play, both double-morph focus
replays restart, the Anim Lab demo plays, zero console errors.
Step 8 frames re-captured (`frames8-rr3.cjs`, a copy of debug8.cjs
with rr3 output names; shots `rr3-dbg-*.png` in ~/wb/verify-manim):
seek(0) shows `x^2 + 1`, seek(mid) shows `x^3 + 1 + y`, seek(end)
shows `z^2 - 1`; the two end frames are byte-identical (5010 bytes),
so the seek cycle is deterministic.

---

## Block D — `\mathbb` and the NewCM font's dynamic character files

**Found by**: the VS2 whiteboard field test (2026-10-13). Any scene
whose MathTex contains `\mathbb` failed to build, the error surfacing
as a MathJax "retry" exception from the render. The field test's first
read ("the amsfonts TeX package is not loaded") is WRONG — corrected
here:

**Root cause.** `\mathbb` is defined in MathJax's *base* TeX package
(`BaseMappings`: `mathbb: [BaseMethods.MathFont, VARIANT.DOUBLESTRUCK]`)
and parses fine; there is no amsfonts TeX package in MathJax 4 at all.
The failure is on the output side: the SVG output's font
(MathJaxNewcmFont, `@mathjax/mathjax-newcm-font`) keeps most of its
character data in 40 per-range "dynamic" files that MathJax loads on
demand through `mathjax.asyncLoad`. manim-web's bundled setup never
installs `asyncLoad`, so the first glyph from a dynamic range
(double-struck for `\mathbb`/`\Bbbk`, fraktur for `\mathfrak`, script
for `\mathcal`; dynamic delimiters take the same path) makes
`FontData.getChar` throw "MathJax retry" — and the synchronous
`html.convert()` in `renderLatexToSVG` cannot absorb it. The CDN
strategy (`tex-svg-full`) is unaffected: the component build wires
its own loader.

**Dead end (recorded so nobody retries it).** Statically importing
the dynamic files DOES register their data (`dynamicSetup` replaces
each file entry's `setup`), but declaring the loader synchronous
(`mathjax.asyncIsSynchronous = true` — the `util/asyncLoad/node`
pattern) only works for the FIRST font instance:
`loadDynamicFileSync` applies `setup(this)` inside its
`if (!dynamic.promise)` guard, and `promise` lives on the class-level
file entry shared by every instance. manim-web's renderer creates a
fresh SVG jax (fresh font) per render, so the second render of the
same formula recursed in `getChar` until the stack overflowed
(RangeError, reproduced with a two-render probe). The async
`loadDynamicFile` applies `setup` per instance, outside the guard —
the retry path is the one that fits a per-render-font renderer.

**Fix** (branch `fix/mathjax-amsfonts`):

1. `MathJaxBundle.ts`: side-effect imports of all 40 dynamic files —
   the font's own declared set (`MathJaxNewcmFont.dynamicFiles`),
   registered through the same single-surface module as the TeX
   configurations (the PR #412 singleton discipline). No command or
   range is special-cased.
2. `package.json`: `@mathjax/mathjax-newcm-font` declared as a direct
   dependency, pinned exactly `4.1.3` — the version `@mathjax/src`
   itself depends on, so npm keeps exactly one copy of the font
   package (a `^` range could install a second font class whose
   registrations our imports would silently miss). Lockfile delta:
   1 line.
3. `MathJaxRenderer.ts`: `loadMathJax` installs
   `mathjax.asyncLoad = () => undefined` (nothing left to fetch — the
   files are already in the bundle), and the npm branch of
   `renderLatexToSVG` converts via `mathjax.handleRetriesFor(...)`:
   the first dynamic glyph pauses the conversion, FontData applies
   the registered data to that font instance, and the conversion
   restarts and completes.

**Tests** — `src/mobjects/text/mathjax-dynamic-font.test.ts` (real
MathJax pipeline, happy-dom, following the mathjax-render-regression
conventions): `\mathbb{R}^n` via `renderLatexToSVG`; siblings
`\mathfrak{g}` / `\mathcal{L}` / `\Bbbk` (three different dynamic
files); a MathTex containing `\mathbb`; a 3-part MathTex with
`\mathbb` in one part (all parts render); a plain-formula pin.
Sensitivity: on bd34574 (pre-fix) the four dynamic tests FAIL (retry
throw / swallowed render error), the pin passes; after the fix all 5
pass. Non-regression: a 7-formula probe set (plain, `\mathbf`,
fraction+sqrt, pmatrix, `\cdots`+`\Longrightarrow`, `\text`+span, sum)
produces byte-identical SVG (sha + point counts + viewBox) before and
after. Suite 8333/1 → 8338/1 (the 1 = the pre-existing browser-bundle
`navigator is not defined` failure); typecheck clean; lint 93
warnings (baseline); knip clean; bundle-shape test green (still
exactly one MathJax chunk).

**Bundle impact (honest).** The MathJax chunk grows 1,547,823 →
12,119,091 bytes (+10,571,268): the font's complete dynamic glyph
data (~10.4 MB raw across the 40 files) now ships inside the single
lazy MathJax chunk instead of being fetched per range. dist total
(on-disk, `du -sb`) 11,266,798 → 21,839,127 B; the chunk delta above
is the load-bearing number. The chunk stays lazy (fetched only when a
MathTex renders), and splitting it into per-range chunks would
violate the project's own bundle-shape rules. Registering only the
ranges a page needs would require a new public API; not attempted.

## Block F — text mobjects ignore the active theme (white text on the light theme)

**Found by**: the whiteboard light-theme integration (2026-10-14).
With `setTheme('light')` the scene background flips to white and the
geometry defaults flip to black, but every MathTex formula still
rendered WHITE — white-on-white, invisible on the board. Reproduced
headlessly: under the light theme a default MathTex's glyph colors
report '#FFFFFF' (the new tests below fail on the unfixed tree with
exactly that assertion).

**Root cause.** ThemeManager seeds defaults in exactly two places:
the `Mobject` constructor (stroke/fill from the active theme) and
`Scene` (its background). The text mobjects keep their OWN color for
rendering and bypass both. `MathTex`'s constructor destructured
`color = WHITE` (the option doc promised "Default: WHITE"), stored it
in `_color`, and everything downstream colors from `_color`:
`renderLatexToSVG({ color })`, `_restyleChildren`, and the per-part
assignment in `_renderMultiPart`. `Text` carried the same defect as a
literal, `color = '#ffffff'`. The `setTheme({ scene })` re-skin is
not a substitute: it recolors every family member of every mobject in
the scene, clobbering explicit semantic colors — defaults have to be
right at construction, which is what the theme system is for.

**Fix** (branch `fix/theme-text-defaults`): an unspecified color now
defaults to `getActiveTheme().fillColor` at construction — the same
source the `Mobject` constructor seeds from. Explicit `color=`
always wins; `setColor`/`setColorByTex` are untouched; under the
`default` theme the seeded fill is WHITE, so unthemed scenes are
unchanged.

1. `MathTex.ts`: constructor default
   `color = getActiveTheme().fillColor`; the option doc says so; the
   now-unused `WHITE` import is removed.
2. `MathTex.ts`, `_PartGroup`: the part class's field default
   `_color = WHITE` → `getActiveTheme().fillColor`. The parent in
   practice overwrites it from its own resolved `_color` before any
   glyph lands (`_renderMultiPart`), so this removes the last
   hardcoded text default in the file rather than changing behavior.
3. `Text.ts`: `color = '#ffffff'` → `getActiveTheme().fillColor`;
   option doc updated. Representation nit: the palette's WHITE is
   '#FFFFFF' where the old literal was '#ffffff' — the same color;
   `text.test.ts`'s default-color assertion now compares
   case-insensitively, the convention core tests already use for
   themed defaults.

**Audit of the same pattern** (the brief's list; verdict per file):

- `Tex.ts` — no defect of its own: it is an alias. Its constructor
  forwards the options to `MathTex` and its `copy()` passes the
  resolved `_color` explicitly. Fixed transitively; unchanged.
- `MarkupText.ts` — no independent default: it extends `Text`,
  passes options to `super()`, and unstyled segments carry
  `color: null` and fall back to `this.color` at draw time. Fixed
  transitively via `Text`; unchanged.
- `Text.ts` — defect present (the literal above); fixed.
- `MathTex._PartGroup` — defect present (field default); fixed.

**Tests** — `src/mobjects/text/theme-text-defaults.test.ts` (real
MathJax pipeline, happy-dom; the `Text` cases use text.test.ts's
canvas-mock convention): light-theme MathTex glyphs BLACK;
light-theme multi-part parts and their glyphs BLACK; light-theme
`Text` BLACK; `setColorByTex` under the light theme recolors the
matched part and leaves the others at the theme fill (BLACK, not
WHITE). Pins: default-theme MathTex glyphs stay WHITE, default-theme
`Text` stays white, explicit `color=` wins under both themes.
Sensitivity: with the fix stashed, the 4 light-theme tests FAIL
('#FFFFFF' / '#ffffff' where BLACK is expected) and the 5 pins pass;
with the fix, all 9 pass. Suite (built tree) 8338/1 → 8347/1 — the 1
is the same pre-existing browser-bundle `navigator is not defined`
failure; typecheck clean.

**Noticed, left alone** (the same literal-default pattern outside
this block's audited set; each takes the same one-line seeding when a
wider sweep is wanted): `DecimalNumber.ts` (`color = '#ffffff'`;
canvas-drawn digits, extends VMobject directly), `MathTexImage.ts`
(`color = '#ffffff'`; the raster sibling — glyphs are always rendered
white into the texture and this color is the material-tint default, a
different mechanism), `Variable.ts` (`labelColor`/`valueColor`
'#ffffff'; a composite of DecimalNumber + MathTexImage, downstream
of their defaults), `Typst.ts` (`color = WHITE`; the parallel Typst
renderer class), and `MathJaxRenderer.ts`'s `renderLatexToSVG`
fallback (`color = '#ffffff'` — a utility-layer default that mobject
callers always override with their resolved color; defaults belong at
the mobject layer). Chart/axis color defaults (NumberLine, BarChart,
…) are axis colors, not text, and are not this pattern's complaint.


# Addendum 2026-10-14 — Block E: GrowArrow on an Arrow renders nothing in the recording Player

## Summary

In a recorded (Player) scene, `play(new GrowArrow(arrow))` drew
nothing — invisible during live play, at the segment end, at rest,
and at every seeked time. The same Arrow rendered correctly via
`scene.add`, `FadeIn`, and `Create`, and GrowArrow worked on the
live (non-recorded) path. Found in the VS1 whiteboard performance
2026-10-14 (see ~/workspace/wb/WAVE2_QUEUE.md's Error Log). The
defect is GrowArrow's: it re-captured its target state from the live
mobject on every `begin()`, including the re-begins the recording
Player performs after `Animation.reset()`, when the arrow still sits
in the collapsed state the first `begin()` installed.

## Repro

`src/player/recorded-growarrow.test.ts` (new): one Arrow
(0,0,0)→(2,0,0), one GrowArrow, recorded via `Player.sequence`.
Headless state dumps on the unfixed tree: after recording, after
seek(0), after playing to the segment end, and after seek(0.5) and
seek(1), both children sit at position (0,0) with scaleVector (0,0)
— arrow width 0 at every time. Playing without any seek also ends
at width 0 (`Player.sequence()` itself finishes with
`MasterTimeline.seek(0)`, Player.ts:208, so every recorded scene
passes through the reset/re-begin cycle before first playback). The
live path (begin/interpolate/finish, no recorder) ends at width 2.

## Root cause

1. `RecordingScene.play()` calls `anim.begin()` during recording.
   `GrowArrow.begin()` calls `super.begin()` (which snapshots the
   arrow via `copy()`), captures its target state — shaft/tip end
   positions, end scaleVectors, end centers — from the live arrow,
   then applies `interpolate(0)`: shaft/tip scaleVectors set to
   (0,0,0), centers shifted onto the arrow's start point.
2. The Player then resets: `MasterTimeline.seek()` calls
   `anim.reset()` on EVERY animation before re-applying state at the
   target time. `Animation.reset()` restores the ROOT mobject's
   position/rotation/scale/color/opacity and the subtree's POINTS
   (structure-aware, Block B) — but not child transforms. The
   shaft/tip keep scaleVector (0,0,0) and their collapsed positions.
3. Re-application re-begins the animation (reset cleared
   `_hasBegun`; Timeline re-application → `Animation.update()` →
   `begin()`). `GrowArrow.begin()` unconditionally RE-captured its
   "end" state — now reading end scales (0,0,0) and end centers both
   equal to the start point. Every later `interpolate(alpha)` and
   `finish()` targeted that collapsed state: the arrow is a single
   point at its start at every time, and the bad capture is
   self-perpetuating across further seeks.

Why the siblings survive: GrowFromEdge / GrowFromPoint /
SpinInFromNothing (same file) also capture their target in
`begin()`, but they animate the mobject's OWN position/scaleVector
— exactly what `reset()` restores — so a post-reset re-capture
reads the pristine state. GrowArrow is the only animation that both
animates state `reset()` does not restore (its children's
transforms) and re-reads its target from live state in `begin()`.
The base class sets the contract: `_preAnimationState` is captured
on the first `begin()` call and never refreshed, precisely because
reset/re-begin is a designed cycle an animation must survive.

Investigated, not causal: `Animation.begin()`'s snapshot calls
`Arrow.copy()` (src/mobjects/geometry/Arrow.ts), which calls
`this.normalizeTransform()` in place — the source's local points
and child transforms are rewritten (world geometry preserved)
before the snapshot is taken. GrowArrow's first-begin capture
reads correct world targets from either representation (probed end
centers (0.85,0)/(1.85,0) for a (0,0,0)→(2,0,0) arrow), and the
collapse happens in the reset/re-begin cycle regardless. Left
alone: the Transform machinery depends on normalized snapshots
(see the `copy()` contract in src/core/Mobject.ts).

## Fix (src/animation/growing/index.ts only, +33/−14)

GrowArrow captures its end state on the FIRST `begin()` only: the
capture block is guarded by a new `_endStateCaptured` flag; every
`begin()` still validates the shaft/tip children and applies
`interpolate(0)`, so a re-begin after reset re-establishes the
animation's start state against the ORIGINAL target.
`interpolate()`/`finish()` are unchanged. No recorder, Arrow, or
base-class changes; no Arrow special-casing in generic machinery —
the generic contract (reset restores root transform + points;
begin may be re-entered after reset) is untouched, and the one
animation that animated outside the restored state now follows
the base class's capture-once idiom. Live-path behavior is
identical (a live play performs exactly one begin, whose capture
is unchanged).

## Regression tests

`src/player/recorded-growarrow.test.ts` (new, 6 tests).
Recorded path (Player, happy-dom): the end state after seek(0) +
play equals a plainly authored Arrow's child points point-for-point,
with the tip non-degenerate (x-span 0.3 = tipLength, y-span 0.2 =
2·tipWidth); seek(1) directly lands on the same end state;
mid-segment seek(0.5) is half-grown (width 1, center x 0.5) and
seek(0) collapses onto the start point; repeated seek/play cycles
do not degrade the end state. Without the recorder: a pin that
begin/interpolate(1)/finish ends at the authored points, and the
unit-level form of the bug — begin → reset() → re-begin →
interpolate(1)/finish ends at the authored points.

Sensitivity (fix stashed, tests kept): 5 fail / 1 pass — all four
recorded tests and the reset/re-begin test fail on the unfixed
tree; the live-path pin passes, as a pin should. With the fix:
6/6 pass.

## Test counts

Full suite in this (unbuilt) tree: 8350 passed / 0 failed / 3
skipped, exit 0 (309 files). The rr5 baseline (8347 passed / 1
failed / 3 skipped) was measured on a built tree; its one failure
is the pre-existing `src/build/browser-bundle.test.ts`
(`navigator is not defined`), which does not execute in an unbuilt
tree. Typecheck clean (`tsc --noEmit` and the test-config variant);
the touched source file is eslint-clean.

## Noticed, left alone

- A second GrowArrow instance on the same arrow in a LATER
  recorded segment still captures at its recording-time `begin()`,
  while the arrow sits in the earlier segment's begin state: the
  recorder runs every segment's `begin()` during recording without
  finishing earlier segments, so any begin()-capturing animation
  sees begin-state, not end-state, in later segments
  (MasterTimeline mitigates this for opacity only, via
  `_savedMobjectOpacities`). Pre-existing recorder semantics
  affecting all state-capturing animations, not this defect; the
  repro and these tests use one GrowArrow.
- `Arrow.copy()`'s in-place `normalizeTransform()` (above):
  world-preserving but rewrites the source's local representation;
  load-bearing for Transform snapshots. Not this defect.

# Addendum 2026-10-14 — Block F follow-up: Axes/NumberLine ignore the active theme

## Summary

Same defect family as Block F, one class over: `Axes` and
`NumberLine` hardcoded a WHITE default axis color, bypassing the
active theme. Under `setTheme('light')` (the whiteboard's white
stage) an unpinned `Axes`/`NumberLine` rendered white-on-white; the
wb lesson scenes worked around it by pinning BLACK by hand (found in
VS4b, Error Log line 52). The defaults are now seeded from
`getActiveTheme().fillColor`, exactly as Block F did for
MathTex/Text.

## Fix (src/mobjects/graphing/Axes.ts, src/mobjects/graphing/NumberLine.ts)

- `NumberLine` constructor: `color = getActiveTheme().fillColor`
  (was `'#ffffff'`). Ticks and number labels already derive from
  `this.color`, so the whole line follows.
- `UnitInterval` (NumberLine subclass, same file): same seeding for
  its own destructured default, which it forwards to `super(...)`.
- `Axes` constructor: `color = getActiveTheme().fillColor`. The
  value already flows to both NumberLines and the arrow tips, and
  per-axis config (`xAxisConfig`/`axisConfig`) still overrides it —
  explicit color wins at every level.
- `Axes.getVerticalLine` / `getHorizontalLine`: their destructured
  `color` defaults seeded the same way.
- Under the `default` theme the seeded fill is WHITE (`'#FFFFFF'`),
  so unthemed behavior is unchanged. One pre-existing test asserted
  the old lowercase literal (`graphing.test.ts`: "should have
  default color #ffffff"); it now asserts the theme's WHITE constant
  — same intent (the default is white), new source.

## Audit (same sweep, `grep '#ffffff'` over src/)

Fixed: only the Axes/NumberLine class above, per plan. Left alone,
with reasons:

- Chart classes that auto-build axes (`Histogram`, `AreaChart`,
  `BoxPlot`, `ScatterPlot`, `ViolinPlot`, `StepChart` — each has an
  `axisColor = '#ffffff'` option default; `BarChart` documents the
  same): the same defect family, but separate classes with their own
  option surface. Follow-up candidates, not this commit.
- `Axes.getAxisLabels` passes an explicit `color: '#ffffff'` to
  `MathTexImage`: that class's tint mechanism was left alone in
  Block F; changing its call sites is a separate decision. (Known
  consequence: axis labels created this way stay white under the
  light theme.)
- `Axes` graph-vertex dot fallback (`vertexDotStyle.color ??
  '#ffffff'`, Axes.ts): a graph-styling fallback, not an axis
  default.
- `Mobject`'s base `_color = '#ffffff'` field: the universal
  fallback every mobject starts from. Block F deliberately seeded
  at the mobject-class level, not the base; retheming the base
  would change every geometry default in the library.
- `VectorScene`'s local `axisColor = '#ffffff'`: a scene helper,
  not the graphing classes.
- `Lighting` (THREE light colors — white light is the neutral
  physical default), `BezierRenderer` parameter fallbacks,
  `MathJaxRenderer`'s option default, `GlyphVMobject`'s glyph tint,
  `Variable`'s label/value defaults (already left alone in
  Block F), `MathTexImage` (Block F), and `|| '#ffffff'`
  current-color fallbacks in Create/TypeWithCursor: renderer or
  text internals, not geometry ink defaults.
- `NumberPlane`'s grid-line colors (e.g. `#29ABCA`): deliberate
  accent colors in CE's palette, not white ink defaults. The
  plane's axes are Axes/NumberLine children and now follow the
  theme through the fix above.

## Regression tests

`src/mobjects/graphing/theme-axes-defaults.test.ts` (11 tests,
mirroring Block F's theme-text-defaults.test.ts): under the light
theme, NumberLine (line + every family member incl. ticks),
UnitInterval, Axes (both axes, tips, every family member,
getVerticalLine/getHorizontalLine), and NumberPlane's axes default
to BLACK; explicit `color=` and per-axis config win under both
themes; default-theme WHITE pins. Sensitivity: on the unfixed tree
9 of 11 fail — the 7 light-theme tests on substance, the 2
default-theme pins only on hex case (old literal '#ffffff' vs the
palette's '#FFFFFF'); the 2 explicit-color tests pass on both. All
11 pass with the fix; the existing graphing.test.ts (70 tests)
passes unchanged in behavior.
# Addendum 2026-10-14 — Block G: recorder/Transform reconstruction fidelity

Three symptom classes from the wb wave-2 conversions, one per
mechanism. This section is written per commit: (i) the terminal
finish() gate (S1), (ii) the reset() restore walk (S2 + S3). The
Block F follow-up for Axes/NumberLine lives on its own branch
(`fix/theme-axes-defaults`, commit fb26934) with its own section.

## (i) S1 — a Transform's end state is the morph product, not the target render

### Summary

A part-count/glyph-structure-changing Transform's terminal state —
in playback and on seek — was the morphed mobject (aligned /
resampled point arrays), not the target's own rendered state: the
VS2 span morph's "(a+c)" glyph ended up carrying two overplotted
outlines, and a settle Transform in VS1p2 rendered bold. Structure-
preserving Transforms recorded clean, and the same scene could
settle crisp or blobbed depending on its segment layout — the
signature of the actual mechanism:

### Root cause (src/animation/Animation.ts, `update()`)

Segment start/end times are accumulated floats. With a 1.0s Write
followed by a 0.3s wait, the Transform segment starts at
1.2999999999999998, so at the segment's end `update()` computed
`elapsed = 0.9999999999999998 < duration = 1` and `rawAlpha`
stalled at 1 - epsilon: `finish()` — the only place
PointMorphStrategy installs the target's exact `finalTargetPoints`
and per-leaf styles — never ran. The terminal frame stayed
`interpolate(1 - epsilon)` over the morph's aligned arrays: every
glyph drawn from the resample of its (flat-index-paired) target,
with compound-path padding duplicating subpaths — the visible
overplot. Proven by controlled experiment pre-fix: the identical
scene with a 0.5s wait (binary-exact sums) settled visually exact,
with a 0.3s wait it did not; direct instrumentation showed
`rawAlpha=0.9999999999999998` and no `finish()` call at seek(end).
This also explains the field reports' inconsistency (VS4b's morph
"needed no settle-replace": its segment sums subtracted exactly)
and why a settle Transform only sometimes helped (the settle is
itself a Transform subject to the same gate).

### Fix (src/animation/Animation.ts only, +13/-2)

`update()` snaps the final sliver of elapsed time to the full
duration (`elapsed > duration - 1e-9` => treat as `duration`)
before computing rawAlpha, so a terminal update always
interpolates at alpha 1 and finishes. 1e-9s is far above the
accumulated float error (~1e-13 at these magnitudes) and far below
any frame time; no other behavior changes (mid-animation updates
are untouched — a guard test pins that `duration - 1e-6` does not
finish). The fix is in `Animation.update()` because that is the
single funnel that owns begin/interpolate/finish semantics for
every animation, on both the play and seek paths (a Timeline- or
MasterTimeline-level snap would have missed direct/grouped
updates, and a seek-only fix would have left playback — which the
probes showed equally affected — broken).

### Regression tests

`src/player/recorded-transform-end-state.test.ts` (4 tests):
a mechanism test driving `Animation.update()` with the exact
accumulated start/end floats (finish must fire, final alpha 1)
plus the no-early-finish guard; and the faithful VS2 scene
(Write + wait(0.3) + the 10-part -> 5-part colored span morph,
shifted) asserting the seek(end) and played-to-end states are
visually exact against a fresh target render (every rendered leaf
matches a target leaf exactly, and vice versa; CE padding
duplicates overplot exactly and are admitted). Sensitivity:
mechanism + both scene tests fail on the parent tree, pass with
the fix; the guard passes on both. (Identity-settle variants of
the scene pass on both trees — for identical pairs the aligned
arrays are the glyphs' own points, so interpolate(1 - epsilon) is
already exact; the settle's real-world failures came through
morph products, which the scene tests cover. No non-sensitive
test is shipped as regression proof.)

## (ii) S2 + S3 — reset() restores only part of the recorded state

### Symptoms

S2 (parked-state corruption): a multi-part MathTex colored via
setColorByTex, used as a Transform source, reconstructs at its
pre-Transform parked state with the TARGET's per-part colors (VS4
under seek; VS4b in both parts after play), points exact. An
uncolored multi-part source parked perfectly (in-lesson control).

S3 (ApplyMatrix x nested subtree): a recorded ApplyMatrix over a
group containing a NumberPlane left the plane's grid lines
transformed after a seek to 0; re-applying then started from the
corrupted points, so scrub cycles compounded the error (VS3:
path-dependent, doubled/shifted lattice lines). Flat groups and
direct children restored exactly.

### Root cause (src/animation/Animation.ts — one restore walk, two gaps)

Both are the same walk enumerating only part of the recorded
state:

1. `reset()` restored the ROOT's transform/style and per-node
   POINTS (via `restorePointsFromSnapshot`), but no per-node
   styles and no child transforms. PointMorphStrategy's
   interpolate()/finish() writes the target's per-leaf styles onto
   the source's leaves, and nothing ever wrote the authored ones
   back — any play or end-seek polluted the parked state
   permanently (S2; points were exact because points WERE in the
   enumeration).
2. The child bookkeeping (`captureChildIdentities` and the old
   restore) descended only through `instanceof VMobject`
   children. A NumberPlane's 18 grid lines sit under a plain
   `Group`; that subtree was silently skipped by both capture and
   restore — counts "matched" because both sides filtered
   identically, so no error was raised while the lines were never
   restored (S3, isolated without the Player: bare
   begin/interpolate(1)/finish/reset leaves the lines at their end
   values). The next begin() then captured the corrupted points
   as its start state — the compounding. Animations rooted at a
   plain (non-VMobject) mobject got no point restore at all (the
   old capture/restore gates required a VMobject root).

### Fix (src/animation/Animation.ts only)

The restore machinery now covers the recorded subtree in full:

- `captureChildIdentities` records EVERY node's full child list
  (no VMobject filter), for any animation root (the capture gate
  is now just "the snapshot is a real Mobject", so the minimal-
  state fallback path is unchanged).
- The restore (renamed `restoreSubtreeFromSnapshot`) visits every
  recorded node and restores, from its paired snapshot node: its
  transform (position/rotation/scaleVector), its style (color,
  fillColor, opacity, fillOpacity, strokeWidth), and — for
  VMobject nodes that own points — its points (the existing
  early-return semantics for points-owning nodes is unchanged).
  Containers pair/prune/recurse over full child lists; the
  count-mismatch throw and the skip-missing-child rule are kept.

This is the layer that owns the defect: the snapshot machinery's
contract is "reset() returns the mobject to its begin() state",
and it was the enumeration — not any caller — that was partial.
No Transform/ApplyMatrix code changes: both animations were
writing legitimate state that reset() failed to put back.

### Regression tests

`src/player/recorded-restore-state.test.ts` (4 tests):
(S2) the colored 3-part source + orange target scene — after a
full play AND after a seek to the end, seeking back to the parked
state returns the authored per-leaf points/colors/fills/positions
exactly; (S3) the recorded NumberPlane ApplyMatrix scrub cycle
(seek(end) equals a live application byte-exact, seek(0) equals
pristine byte-exact, a second seek(end) equals the first), the
same cycle bare (begin/finish/reset, no Player), and a hand-built
plain-Group nesting (Group > Group > Lines, plain-Group root).
Sensitivity: all 4 fail on the parent commit (1ccfabf), all 4
pass with the fix. The src/player + src/animation suites (1997
tests, incl. the Blocks A–F recorded-path tests) pass unchanged.

### Noticed, left alone

- Points-owning nodes with children (e.g. an Arrow: own shaft
  points + a tip child) still take the early return: their flat
  points are restored, their children's own state is not recursed
  into. Pre-existing semantics — the flat setPoints repartitions
  the children — and no field symptom maps to it; changing it is
  a separate decision.
- `MasterTimeline._savedMobjectOpacities` (root opacities across
  seeks) is now partially redundant with the per-node opacity
  restore, but it also covers mobjects whose first segment has
  not begun and the update()-time re-hide loop; left untouched.

### Test counts (Block G branch tip, b75bbe2)

Full suite in this (unbuilt) tree: 8357 passed / 1 failed / 3
skipped at the default 5000ms test timeout; the one failure is
`mathjax-dynamic-font.test.ts` (Block D's real-renderer \mathbb
test) timing out on the 4-vCPU thinkpad — it passes in isolation
at --testTimeout=20000 (5/5), the same timeout-marginal character
seen before on this box, in a file Block G does not touch. True
state: 8358 passed / 0 failed / 3 skipped (rr6 baseline 8350/0/3
+ 8 new tests). Typecheck clean (both `tsc --noEmit` and the
test-config variant). Theme branch tip (fb26934): 8361/0/3.

### Noticed, left alone (Block G)

- FadeTransform / FadeTransformPieces group paths: their
  finish() installs only the aligned (resampled) target points
  and the ROOT color, and their begin() aligns the LIVE tree in
  place via alignPoints — on the VS2 span scene the live leaf
  count goes 15 -> 32 at begin() and stays there, with per-leaf
  colors left as the source's (bare repro, no recorder: bare
  Transform on the same pair ends at 15 leaves with the target's
  state installed per leaf). This is the mechanism behind the
  VS2 authoring note ("FadeTransform did not settle on the
  target's true state — custom colors lost"). It is NOT one of
  the three recorded-path symptom classes: it reproduces with no
  recorder involved, in plain live animation. Block G's (i) does
  improve it incidentally — its finish() now reliably runs. The
  clean fix is to rebuild the two group paths on
  `pairLeafSnapshotsByIndex` + per-leaf final-state install,
  like PointMorphStrategy's VGroup path, with the fade curve
  layered on top: a self-contained rewrite of FadeTransforms.ts
  (~200 lines) with its own regression surface. Recommended as
  a follow-up block rather than folded into this one.
- The Write-dash wart (seek(end) -> seek(0) leaves unbegun
  Writes revealed; intra-segment scrub unfaithful) is unchanged:
  segment gating and end states are correct, and neither S1/S2/S3
  implicated the Create/Write path.

# Addendum 2026-10-14 — Block G round 2: the terminal state was exact; its topology was not

S1's snap fix (1ccfabf) is correct as far as it goes — finish() does
run at segment ends — but the merged tree still failed integration
probe P1: the original VS2 span scene ended with the "(a+c)" glyph as
a filled blob on the live board, played-end byte-identical to
seek-end, while P2/P3/P4 passed. Round 2 found the second mechanism.

## What the headless tests missed, and why

The shipped S1 scene tests assert per-leaf point SIGNATURES (point
count + weighted coordinate sum + colors, compared as a set) in
happy-dom. Post-snap, the terminal state's points, colors, positions,
and structure ARE exactly the target's — every signature legitimately
passed. The divergence lived in a channel no assertion read: each
leaf's SUBPATH TOPOLOGY (`getEffectiveSubpathLengths()`), the
metadata that partitions a leaf's points into outer rings and holes
for the fill builder. Nothing in the suite rendered a pixel — or
even built a fill triangle — from the end state.

## True mechanism

1. Glyph leaves publish their intrinsic topology at construction via
   `setBaseSubpathLengths` (`src/mobjects/text/GlyphVMobject.ts`,
   `src/mobjects/text/svgPathParser.ts`) into `_baseSubpathLengths`
   (e.g. the target "a" is 80 points partitioned [49, 31]: outer
   ring + counter).
2. `VMobject._copyBaseAttributesInto` (`src/core/VMobject.ts`)
   copied `_points3D`, `_visiblePointCount`, and
   `_transformSubpathLengths` — but NOT `_baseSubpathLengths`. Every
   `copy()` of a glyph mobject silently dropped its topology
   (verified in a real browser: a fresh MathTex's copy reports
   base/effective subpath lengths undefined on all 13 leaves).
3. The leaf-pairing morph path pre-copies its target:
   `PointMorphStrategy._beginVGroup` pairs leaves against
   `target.copy()` snapshots (the normalized target). In
   `alignVmobjectPair` (`src/animation/transform/TransformPairing.ts`),
   `finalTargetSubpathLengths` is read from that copy — undefined,
   and the `?? target.getEffectiveSubpathLengths()` fallback reads
   the same copy, so it cannot rescue it.
4. `finish()` (PointMorphStrategy) installs the target's exact
   points/styles per leaf and calls
   `setTransformSubpathLengths(leaf.finalTargetSubpathLengths)` =
   undefined, CLEARING the aligned-lengths override begin() had set.
5. Each terminal leaf then renders the target's exact points
   partitioned by its own stale source-glyph base lengths. Where the
   sums mismatch (index-pairing mates different glyphs), the
   stale-metadata guard in `getEffectiveSubpathLengths()` returns
   undefined and `buildEarcutFillGeometry` falls back to treating
   all points as ONE ring — the counters of "a" ([49,31]) and "b"
   ([43,28]) fill solid: the blob. "d" survived because its source
   partner shared its topology ([61,31]); single-ring glyphs are
   insensitive — hence exactly one conspicuous blob, exact state
   dumps at every level the tests (and the round-1 board dump) read,
   and seek == play (both funnel through finish()).

This also corrects two round-1 readings: the board zoom shows a
FILLED counter, not "two outlines offset by ~2%"; and hypothesis (2)
of the integration note is answered — finish() IS reached in the
Player path and DOES install the target's points; what it could not
install was topology it never had. The single-VMobject morph path
was immune throughout: it aligns against the REAL target, so the
fallback reads true lengths. Only leaf-pairing (MathTex/VGroup
morphs) pre-copies.

## Fix (src/core/VMobject.ts only, +8 lines)

`_copyBaseAttributesInto` now copies `_baseSubpathLengths` alongside
the transform override, with a comment stating the invariant:
subpath lengths partition the copied points, so they must travel
with them. This is the owning layer — copy()'s contract is to
preserve the mobject's point state, and every consumer of copy()
(morph pairing, snapshot machinery, FadeTransforms' target copies)
inherits the correction; no caller changes, and the stale-metadata
sum guard is untouched.

## Regression tests (6 new, all fail pre-fix / pass post-fix)

`src/player/recorded-transform-end-state.test.ts`:
- Full-recursive-state tests (seek(end) and played-to-end) on the
  board-faithful construction (BEFORE/AFTER part arrays at DEFAULT
  font size, Write -> wait(0.3) -> Transform -> wait(0.3) through
  player.sequence): every end leaf must match a fresh target leaf on
  world points, style, AND effective subpath lengths; every fresh
  leaf must be rendered. On 0a2f598 the divergences print exactly
  the mechanism: 9 end leaves with `subpathLengths end=undefined`
  vs fresh [49,31] / [43,28] / [49] / [55] / [58].
- A fill-geometry test that builds each compound glyph's world-space
  fill triangles the way VMobjectRendering does and asserts area
  equality (1e-6 rel.), hole-centroid uncovered, and probe-grid
  coverage agreement vs the fresh render. Pre-fix it fails on area:
  the "a" leaf's fill exceeds the target's by 0.0266 (tolerance
  2e-8) — the filled counter.
- A MathTex copy() test: a copy keeps every leaf's subpath lengths.

`src/animation/transform/transform-stale-subpath-lengths.test.ts`:
- Two VMobject-level copy() tests (base lengths carried; base +
  transform override carried independently).

The 4 original S1 tests pass on both trees, as before.

## In-browser verification (standalone rig; the board was not touched)

Rebuilt the browser bundle from the fixed tree and re-ran the
original VS2 span scene in real Chrome on the scratch rig
(/tmp/r2srv): every end leaf's effective subpath lengths now equal
the fresh target's per leaf ("a" [49,31], "b" [43,28], "d" [61,31]),
and the played-end and parked-after-morph frames are clean — the
"a" renders as a crisp italic glyph with an open counter
(~/workspace/wb/frames-blockg/r2-fixed-{played-end,parked}.png; the
pre-fix r2-full-*.png from the same rig show the blob).

## Test counts (fixed tree)

Full suite at --testTimeout=20000: 8378 passed / 1 failed / 3
skipped. The one failure is `src/build/browser-bundle.test.ts`
("should export key symbols": `navigator is not defined` while
loading a freshly built dist bundle in the node test env). It
reproduces identically with a bundle built from PRISTINE 0a2f598
sources — a fresh-build artifact of this box, unrelated to the fix
(dist/ is gitignored; the dist shipped in the tree passed the
merged-baseline run). At the default 5000ms timeout the heavy
MathJax files (recorded-group-transform, mathtex-animation) flake
on timeouts under load and pass in isolation — the same documented
character as the Block D test. Typecheck and typecheck:tests clean.

## What remains unproven

Only a board re-probe (re-integrate a build of this tree, re-run
P1–P4) closes S1; settle-replace remains the required authoring
pattern until then. Noted in passing: the copy() fix also repairs
the same topology loss in FadeTransforms' target copies, but Block
H's per-part target-color loss is a separate mechanism (begin()
aligns the live tree in place) and stands as scheduled.

# Addendum 2026-10-14 — Block G round 3: the begin state kept the end state's topology

Round 2's tree passed board probes P1/P2/P4 but failed P3 on
GEOMETRY (P3's original verdict had read colors only): at the
pre-Transform PARKED state of the VS4b status-line pattern — a
multi-part MathTex whose one part changes glyph (e₁→v₁) used as a
Transform source — the changed glyph rendered with a FILLED counter
under seek, while the same pattern's parked frame on the
pre-round-2 engine was crisp. Rounds 1–2 had each repaired one
direction of a single contract: a recorded animation's begin state
and end state must each reconstruct exactly, in every state
channel. Round 3 is the remaining direction of the remaining
channel.

## Mechanism

1. `PointMorphStrategy.finish()` installs the target's partition
   on the source's leaves:
   `setTransformSubpathLengths(pair.finalTargetSubpathLengths)`
   (`src/animation/transform/PointMorphStrategy.ts`, VGroup and
   single-VMobject paths), where `finalTargetSubpathLengths` is the
   target leaf's own effective lengths
   (`src/animation/transform/TransformPairing.ts`). Post round 2
   these are the REAL target lengths — correct for the end state,
   whose points are the target's. In the P3 scene the changed leaf
   ends with override [58] (the "v") over the target's 58 points.
2. `Animation.reset()` restores from the begin() snapshot via
   `restoreSubtreeFromSnapshot` (`src/animation/Animation.ts`):
   every node's transform + style, and for points-owning nodes the
   points themselves — but not the subpath-length state. The
   snapshot itself is pristine: `Transform.begin()` calls
   `super.begin()` (which captures it) before the strategy aligns
   anything, and post-round-2 `copy()` carries both length fields,
   so the snapshot leaf holds the authored override (none). The
   restore simply never read it. (This refutes the integrator's
   first hypothesis — the snapshot is NOT taken after begin()
   mutated the source; the restore is incomplete, not the capture.)
3. `MasterTimeline.seek()` resets every animation, then
   re-applies only the segments up to the target time, so the
   parked state is exactly what reset() restored: the source leaf
   gets its own 47 points and its own blue back, but keeps
   finish()'s [58] override. The sum guard in
   `getEffectiveSubpathLengths()` (58 ≠ 47) returns undefined —
   no topology — and the fill builder draws the glyph as one
   ring: the "e" counter fills solid. Probe-verified headlessly
   on 127db2d: parked leaf n=47, base [34,13], override [58],
   effective undefined; every other leaf's points, styles and
   topology exact. (Where a stale partition happened to sum to
   the restored point count it would mis-partition silently
   instead — the restore below fixes that case too, by putting
   back the snapshot's override wholesale.)
4. Why the pre-round-2 engine parked crisp: finish() then
   installed `setTransformSubpathLengths(undefined)` — the
   lengths it read had been dropped by copy() — which CLEARED
   the override, so the parked state fell back to the leaf's own
   base lengths [34,13]. Round 2 repaired the end state by
   making finish() install real lengths; those lengths then
   leaked into the begin state through the restore walk's one
   unrestored channel.

The owning layer is the restore walk: its contract since round 1
(ii) is "reset() returns the mobject to its begin() state", and
the points' topology is part of the point state. (`setPoints()`
cannot clear the override instead: `_interpolateVGroup` relies on
the override persisting across per-frame `setPoints()` calls.)
Base lengths are NOT restored: they are construction-time /
intrinsic (two subclasses compute them from private fields) and
are never mutated on a live node, so snapshot and live node
already agree on them. The transform override is the one
animation-written channel, and it is snapshot state like any
other.

## Fix (2 files, +10 lines each)

- `src/core/VMobject.ts`: a `getTransformSubpathLengths()`
  getter, symmetric with the existing setter and with
  `getSubpathLengths()`.
- `src/animation/Animation.ts`: in `restoreSubtreeFromSnapshot`'s
  points-owning branch, after restoring the points, restore the
  override from the snapshot node:
  `live.setTransformSubpathLengths(saved.getTransformSubpathLengths())`.

No strategy, pairing, or copy() changes; the end-state contract
is untouched (finish() still installs the target partition;
reset() now removes it again on the way back). Chained morphs
stay correct: a later Transform's snapshot captures the previous
morph's installed override as its begin state, and restoring it
reproduces that state exactly.

## Regression tests (3 new, all fail on 127db2d / pass with the fix)

`src/player/recorded-restore-state.test.ts`, new describe
"recorded restore -- parked-state topology (Block G round 3)".
The file's S2 tests asserted parked points/colors; these are the
parked-TOPOLOGY counterpart, on the board probe's own scene
(default font size; parts ['\\{','\\mathbf{e}_1',', ',
'\\mathbf{e}_2',', ','\\mathbf{s}','\\}'] → the v₁ variant;
e-parts BLUE, v₁ ORANGE; Write(1.0) → wait(0.6) →
Transform(1.2) → wait(0.6); parked t=1.3):

- Full recursive parked state — ordered per-leaf world points +
  style + effective subpath lengths — equals a fresh authored
  build, after play-to-end + seek(1.3) and again after seek(end)
  + seek(1.3). On 127db2d the ONLY divergence across all 9 leaves
  is the changed leaf's topology: [34,13] expected, undefined
  received.
- Fill geometry at the parked state: every compound authored
  glyph's world-space fill equals its fresh fill (area to 1e-6
  relative, counter centroid uncovered).
- Bare-Transform isolation (no Player): finish() installs the
  target partition on the changed leaf ([58]); reset() returns
  every leaf's override to its begin-state value (undefined) and
  its effective lengths to its own base lengths.

## Test counts

Guard suites on the fixed tree: all recorded-* files plus
transform-stale-subpath-lengths and TransformPairing — 91 tests,
all pass (end-state exactness incl. round 2's full-state and
fill-geometry tests, parked colors S2, NumberPlane scrub S3,
group transforms, lagged seek, GrowArrow). Full suite, same tree
state both runs: pristine 127db2d = 8377 passed / 2 failed /
8379; fixed tree = 8381 passed / 1 failed / 8382 (+3 = the new
tests; one baseline "failure" was a 5000 ms timeout flake in
recorded-transform-end-state under load — it passes in isolation
on both trees and passed in the fixed full run). The remaining
failure on both trees is `src/build/browser-bundle.test.ts`
("navigator is not defined" loading dist/): the round-2-rebuilt
dist in this worktree triggers the fresh-build artifact round 2
already documented as reproducing from pristine sources; it is
untouched by this change. Typecheck and typecheck:tests clean.

## In-browser verification (standalone rig; the board was not touched)

Rebuilt the browser bundle from the fixed tree and re-ran the
P3 scene in real Chrome on a standalone rig (/tmp/r3srv; the
board was not touched). After seek(end) then seek(1.3), every
parked leaf's point count, base lengths, effective lengths and
color equal the fresh authored build's -- the changed leaf is
n=47, effective [34,13], BLUE -- and the zoomed parked frame
shows the e1 "e" crisp with its counter open
(~/workspace/wb/frames-blockg/round3/p3-zoom-parked-fixed.png;
contrast round2/p3-zoom-parked.png: the same leaf filled solid
on the round-2 tip).

## What remains unproven

Only a board re-probe (re-integrate a build of this tree, re-run
P1–P4 with P3's verdict read from the parked frame's GEOMETRY)
closes Block G; settle-replace remains the required authoring
pattern until then. VS5 stays gated on that re-probe.

# Addendum 2026-10-14 — Block H: FadeTransform group paths keep per-part target colors

Block G's declared remainder. FadeTransform and FadeTransformPieces
on a GROUP mobject (a VGroup, a multi-part MathTex — anything whose
root delegates its geometry to leaves) lost the target's per-part
colors, and more: the end state was not the target's render in any
channel.

### Mechanism

Both group paths aligned the LIVE tree in place with alignPoints()
— FadeTransform at the root, FadeTransformPieces inside each
container piece (and only when BOTH piece sides were containers; a
container paired with a plain leaf fell through to flat arrays whose
partition across the live child's current counts is the same
defect). alignPoints pads and resamples the live children, so the
tree grew permanently: on the VS2 span pair (BEFORE 11 parts / 15
glyph leaves, AFTER 5 parts / 13 glyph leaves) the live leaf count
went 15 -> 32 at begin() and stayed there. finish() then installed
only the aligned (resampled) point arrays — plus, for FadeTransform,
the root color; for FadeTransformPieces, no style at all. Measured
on 1433dae with per-leaf world signatures (point count + weighted
coordinate sum + color/fillColor, compared as sets against a fresh
target render): geometry-only signatures diverge AND full
signatures diverge, for both classes; bare Transform on the same
pair is exact (15 end leaves, all matching).

Root cause, one line: the fade group paths never captured the
target's per-leaf final state — there was nothing in their state
that finish() could have installed.

### Fix (FadeTransforms.ts only; no recorder changes)

The two group paths are rebuilt on pairLeafSnapshotsByIndex — the
leaf-pairing primitive PointMorphStrategy's VGroup path already
uses — with the fade curve layered on top. Shared module-private
machinery (buildFadeLeafState / interpolateFadeLeaf /
finishFadeLeaf) mirrors PointMorphStrategy._build/finish:

- begin(): FadeTransform normalizes the source root and a copy of
  the target (never the caller's target) and pairs the leaf
  families; padded duplicates join the tree as real siblings
  (reset()'s bookkeeping prunes them on seek, membership contract
  as before); placeholders cover a side with zero leaves.
  FadeTransformPieces keeps its piece-index pairing/padding
  skeleton; a piece pair where either side delegates its geometry
  now leaf-pairs within the piece instead of aligning the live
  child in place.
- interpolate(): per leaf — points and position lerp; opacity
  follows the fade V-curve from the leaf's own start/target
  opacities; the other style channels (color, fillColor,
  fillOpacity, strokeWidth) switch from the source leaf's to the
  target leaf's at alpha = 0.5, where the leaf is fully faded
  out, so the switch is never visible.
- finish(): per leaf — the target leaf's OWN points, subpath
  topology (finalTargetSubpathLengths), style, and position are
  installed, exactly like PointMorphStrategy.finish(); the
  FadeTransform root additionally moves to the target root's
  position and keeps its root opacity/color installs. A flat
  (non-container) FadeTransformPieces piece likewise installs its
  target piece's own final points/topology/style instead of the
  aligned arrays and no style.
- The single-object paths (FadeTransform's non-pairing branch,
  FadeTransformPieces' no-submobjects fallback) are byte-for-byte
  the old code.

One contract change, deliberate: the B3 case (a subgroup empty on
one side) no longer throws at begin(). Family-wide leaf pairing
handles it — Manim CE semantics, the same as Transform. The
descriptive begin() failure survives for a target with no leaves
at all (alignVmobjectPair's error, via the flat path). The B3
test in recorded-group-transform.test.ts was updated to pin the
new behavior plus the surviving throw.

### Tests

New file src/player/recorded-fadetransform-group-colors.test.ts
(8 tests): bare FadeTransform end-state exactness + no permanent
tree growth (15 leaves in, 15 out); bare per-leaf fade-curve pin;
bare FadeTransformPieces end-state exactness; bare VGroup-of-
colored-leaves and flat-colored-pieces color survival; recorded
(Write -> wait(0.3) -> fade -> wait(0.3), the VS7 segment shape)
seek(end) exact + seek(parked) ordered-equality with the authored
source, for both classes; recorded played-to-end exactness.
Sensitivity: 7 of 8 FAIL on 1433dae (the fade-curve pin passes on
both — the old root fade also dipped leaf opacities via the root
cascade; it pins the layering, not the defect). All 8 pass on the
fix. Guard suites: src/player/ in full — 13 files / 296 tests
pass (every recorded-* suite, incl. the B1/B2/B-mixed fade
contracts); animation-transform-extra + TransformPairing +
transform-stale-subpath-lengths pass. Full suite on this branch
(dist freshly built): 8390 passed / 1 failed / 8391 total — the
total reconciles exactly against the round-3 dist-state A/B
(8382) + 8 new + 1 B3 split; the single failure is
browser-bundle.test.ts "should export key symbols" (navigator is
not defined loading the fresh dist), the documented pre-existing
fresh-dist artifact, reproduced in isolation on this tree.
Typecheck + typecheck:tests clean.

In-browser proof (standalone rig: the branch's fresh dist served
to real headless Chrome, Player + setTheme('light'), no board
contact): a Write -> wait -> FadeTransform -> wait scene whose
source is the uncolored span pair and whose target colors u BLUE
/ v ORANGE. Seek(end) frame: "(a+c)" dark, u BLUE, "(b+d)" dark,
v ORANGE, glyphs crisp — with a per-leaf programmatic dump to
match (15 leaves; u #58C4DD, v #FF862F, rest #000000). Seek(1.15)
parked frame: the authored source, all dark, crisp, counts exact.

### What remains unproven

Only the board re-probe: integrate this branch into wb by the
usual tarball swap and run the VS7-pattern probe (a colored
multi-part FadeTransform's end AND parked states on the live
board, read from frames) — the same gate Blocks E/F/G went
through. VS7's normal-equations scene (three-morph chain incl.
FadeTransform) is the consumer. The round-4 candidate from the
Block G round-3 review (chained-Transform parked-state point
resampling) is a different mechanism in the Transform/seek
machinery and is untouched by this block.

# Addendum 2026-10-14 — Block G round 4: the parked state was the next morph's begin state

The round-3 reviewer's leftover (§6 of that review, logged in the wb
queue as the round-4 candidate): a recorded scene with TWO chained
Transforms — seek back to the pre-first-Transform parked state and
compound glyph leaves come back with points resampled and subpaths
reordered (the e₁ "e": [13,58] over 71 points where the authored
glyph is [34,13] over 47; even the UNCHANGED e₂ gets its subpaths
swapped, [13,34]). Colors/styles exact; recorded end and middle
(post-T1) states exact; a single morph's recorded parked state exact
(round 3); bare chained morphs exact. Reproduced identically at
0a2f598 / 127db2d / 1433dae — pre-existing, not a round 2/3
regression. This round found the mechanism: TWO coupled defects,
one in the recording driver, one in the seek undo.

## (alpha) Recording began animations it never ran

`RecordingScene.play()`'s own header says it captures play() calls
"without actually running animations" — but it called
`anim.begin()` on every segment at record time. begin() is not a
pure setup hook:

1. `Animation.begin()` captures `_preAnimationState = mobject.copy()`
   — the state `reset()` will later restore — from the CURRENT tree.
2. `Transform.begin()` then runs its strategy, whose VGroup path
   aligns the LIVE tree in place: per leaf it installs the aligned
   start points (`child.setPoints(aligned.startPoints)`) and the
   aligned subpath override. The live mobject is left sitting in
   the morph's ALIGNED START state — resampled points, compound
   subpaths reordered by the compound-path matcher, the source's
   styles untouched.

Recording T1 therefore left the tree in T1's aligned start state,
and T2's record-time begin() captured exactly that as T2's "begin
state" — never T1's end state, which recording never computed.
Probe-verified on 8f0807c: T1's own snapshot stays pristine at every
checkpoint, while T2's snapshot's leaves are bit-identical to the
corrupted parked state (leaf 1: 71 points, partition [13,58], A's
blue; the unchanged e₂ subpath-swapped with its point multiset
intact); a bare `t2.begin()` issued after a REAL T1 run captures
the true B. This also explains the exact symptom bounds: colors
survive because the aligned start state carries the source's
styles; the corruption is in the points/topology channels only.

## (beta) The seek undo ran in schedule order

Both undo cascades reset in schedule order: `MasterTimeline.seek()`
reset ALL animations segment by segment, and `Timeline.seek()`'s
backward pass reset the future animations in insertion order.
`reset()` installs the animation's OWN begin state, and seek's
re-application only covers segments at or before the target time —
so at the pre-T1 parked time, T2's reset ran last and nothing
overwrote it: the parked state WAS T2's snapshot, whatever it held.
Proven independent of (alpha): a hand-driven MasterTimeline whose
snapshots are all true (T2's = B exactly, captured during real
playback) still reconstructs **B** at the pre-T1 parked time.
End and middle states were exact only because re-application
re-runs the earlier morphs to completion and overwrites the bad
restore; a single morph is immune because its reset is the last
(and only) one in its cascade and its snapshot is pristine.

## Fix (3 files)

1. `src/player/RecordingScene.ts` — play() no longer calls
   `anim.begin()`. Recording is a pure capture again (segments,
   scene membership, and the pre-animation opacity addSegment
   records — taken from the untouched mobject, so the old
   "record before begin so opacity is correct" concern inverts:
   nothing has run, so the recorded opacity is the authored one).
   begin() — and with it snapshot capture — now happens at the
   animation's first playback/seek `update()`, when the preceding
   segments have actually run to completion and the tree holds the
   state the animation truly starts from. (`Player.sequence()`
   seeks to 0 right after recording, which begins segment 0
   against the authored tree as before.)
2. `src/animation/Timeline.ts` — the backward-seek undo is
   extracted as `protected _resetAnimationsAfter(time)` and
   unwinds in REVERSE schedule order (LIFO, like any undo stack:
   each reset lands on a state the next, earlier reset fully
   overwrites, ending at the earliest animation's begin state).
   `Timeline.reset()` unwinds latest-first the same way.
3. `src/animation/MasterTimeline.ts` — seek()'s reset-all loop
   unwinds in reverse segment order, and `_resetAnimationsAfter`
   is overridden as a no-op: MasterTimeline's seek already
   performs the complete undo, so the base pass re-resetting only
   the future subset afterwards could only reinstall later begin
   states over the start state just produced — and poison the
   re-begin of an earlier segment when a seek lands inside it.

Single-morph behavior is unchanged in substance: with one morph on
a mobject every cascade order coincides, and record-time vs
playback-time begin captures the same authored state — the full
recorded-* guard surface (below) is the evidence.

Considered, left alone: `AnimationGroup.reset()` still resets its
children in order. A group's children run in PARALLEL, not as a
chain — the defect needs a sequence of animations whose begin
states are causally ordered — and no symptom maps to it. If a
group ever hosts a deliberate same-mobject chain, it wants the
same LIFO treatment; that is a separate decision.

## Regression tests

`src/player/recorded-restore-state.test.ts`, new describe
"recorded restore -- chained Transforms (Block G round 4)" — the
round-3 status-line scene extended to a chain (Write → wait →
T1: e₁→v₁ → wait → T2: s→t → wait; parked t=1.3, mid t=3.1),
asserting full recursive per-leaf state (ordered world points +
style + effective subpath lengths — the channels that render):

- SENSITIVE: seek(parked) after the chain equals the fresh
  authored source, via play-to-end and via seek(end) first —
  fails on 8f0807c (leaf 1 [13,58]/71, leaf 4 swapped).
- SENSITIVE: a plain `Timeline` (no MasterTimeline) playing the
  same chain and seeking backward to the parked time returns the
  source — fails on 8f0807c (returns B), pinning (beta) in the
  base class alone.
- Pins (pass on both trees): seek(mid) = the first target's full
  state; seek(end) and played-end = the second target's; a scrub
  into the first morph equals a bare reference morph at the same
  in-segment time (insensitive pre-fix because the record-time
  aligned state is a fixed point of re-alignment — it pins the
  re-begin path against regressions of the fix itself).

`src/player/Player.test.ts`: the RecordingScene contract test
pinned the record-time `begin()` itself — the (alpha) defect — and
now pins the new contract (play() records the segment and adds the
mobject WITHOUT beginning the animation); the dirty-sync test is
retitled accordingly. This mirrors Block H's B3 rewrite: a test
that encoded the defective behavior is updated in the same commit,
with the reason recorded inline.

## Test counts

Guard surface `src/player` + `src/animation` on the fixed tree:
2020 passed / 0 failed. Full suite at `--testTimeout=20000`:
**8395 passed / 1 failed / 8396 total** (Block H branch baseline
8390/1/8391; +5 = the new tests). The one failure is
`src/build/browser-bundle.test.ts` (`navigator is not defined`
loading a freshly built dist) — the documented fresh-dist
artifact, reproduced from pristine sources in rounds 2–3 and
untouched here. At the default 5000 ms timeout the same run shows
one additional failure, the S2 parked-colors test timing out under
load (the documented timeout class on this 4-vCPU box; it passes
in isolation and at 20000 ms). Typecheck and typecheck:tests
clean; prettier clean.

## In-browser verification (standalone rig; the board was not touched)

Rebuilt the browser bundle from the fixed tree and re-ran the
chain scene in real Chrome on the scratch rig (/tmp/r4srv). After
playing to the end and seeking to the parked time (1.3): the
programmatic per-leaf dump equals a fresh authored build on every
channel (world points at 1e-9, effective subpath lengths, colors);
the parked stage frame renders "{e₁, e₂, s}" with e₁/e₂ blue,
glyphs crisp, counters open; a pixel compare of the stage region
against a fresh-authored reference page differs on 40 of 395,200
pixels by at most 3/255 (anti-aliasing-level residue) — the only
larger difference is the player progress bar, whose total-duration
differs by construction. Frames:
~/workspace/wb/frames-blockg/round4/{chain-parked-stage,
fresh-authored-stage}.png.

## What remains unproven

Only a board re-probe (re-integrate a build of this tree and run
VS7's normal-equations scene — a THREE-morph chain — through the
live Player) closes round 4 end-to-end; VS7's performance is that
check. The vitest chain covers two morphs; the mechanism (snapshot
timing + LIFO undo) is count-independent, and the three-morph
case adds no new interaction — each additional link is one more
LIFO frame and one more playback-time begin.
