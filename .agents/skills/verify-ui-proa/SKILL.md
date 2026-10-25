---
name: verify-ui-proa
description: Inspect real Proa experiment frames against the immutable ANSI reference. Repository-local agent verify step; takes only the build slug.
disable-model-invocation: true
---

# /verify-ui-proa <build>

The kernel has selected this step. Do not inspect Git or decide applicability.

1. Run `ab context`. Read the printed manifest and resolve its materialized spec
   and optional guidance relative to contextDir. Follow allocated manifest paths
   verbatim. Read pinned assets when present; apply answered guidance first.
2. Read `experiments/proa-server/tools/README.md` and the committed visual authority
   `experiments/proa-server/design/ansi/README.md`, reference HTML, screenshots and
   product briefs. The experiment's ANSI authority overrides root DESIGN.md.
3. Run `bun experiments/proa-server/tools/capture.ts`. It prints the isolated
   `.ab/proa-frames-*/` evidence directory. Read its inventory.json and
   verify-report.md. A nonzero exit, missing inventory/probes, incomplete route or
   state matrix, or missing/empty PNG is a failure. Do not skip or reinterpret it.
   Dependencies must already be provisioned locally; capture resolves offline.
   The shared CARGO_TARGET_DIR reuses ordinary Cargo dependencies across worktrees.
   Pinned Proa 0.1.3 hashes absolute package paths, so linked targets rebuild in
   new worktrees (about 20–26 seconds per measured stage). Operator guidance
   accepts partial reuse; retain linked builds and revisit on a Proa upgrade.
   See experiments/proa-server/FIELD-NOTES.md for measurements and cause.
   Today database=none and auth=none. When data reading exists, require an explicit
   adapter seeding a dedicated loopback PostgreSQL database from the existing
   prepareHappyScenario/prepareScenario producers BEFORE starting Rust. When
   authentication exists, require a server-issued development session guarded by
   development mode, loopback binding AND loopback peer checks, refusal tests for
   production/non-loopback, and explicit signed-in cases. Fail if either
   capability exists without its capture support. Never use GitHub, forge, live
   agent runners, browser-only auth stubs or shared default development databases.
4. Open EVERY inventory PNG with the image-capable tool as a color image. Compare
   to corresponding committed Builds/menu reference screenshots at desktop/phone
   in both grounds. Inspect actual pixels for hierarchy, typography, shell/menu
   composition, spacing, clipping and missing content. Check palette tokens,
   Atkinson Hyperlegible Next and JetBrains Mono only, no horizontal overflow at
   390px, and required route/state content. The approved scaffold intentionally
   has neutral proa/server identity and placeholder paragraphs instead of the
   reference's synthetic accounts/build rows; do not demand fake data.
5. Append criterion-by-criterion observations and explicit visual PASS or FAIL to
   verify-report.md, naming every frame inspected and any guidance applied.
   On ANY probe/capture/visual failure run `ab verdict fail --report <report>`;
   create a failure report in context scratch if capture failed before producing
   one. Never attach passing evidence on failure.
6. Only after every criterion passes, attach EVERY inventory PNG using
   `ab artifact put proa-frame:<id>:png <png> --attach` with unique inventory ids.
   Check every attachment succeeds. Then run `ab verdict pass --notes <report>`.
   Missing attachment is not a completed passing session.
