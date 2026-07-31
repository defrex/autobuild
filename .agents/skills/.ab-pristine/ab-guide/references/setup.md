# Repository setup

Configure Autobuild outside the build pipeline. This conversation is not a
build or phase. Work directly in the repository and involve the user in choices
that cannot be derived from source.

1. Inspect the repository's manifests, documentation, CI, test layout, and
   conventions. Read the installed sibling `../SKILL.md` for Autobuild's
   complete configuration and ticket surfaces.
2. Configure real `[commands]` and ordered `[verify]` steps from the toolchain
   this repository actually uses. Do not invent commands or retain placeholders.
3. Decide the runtime and model arrangement for all pipeline roles. The runtime
   that launched this setup conversation and the temporary
   `[roles.default].runtime` in a fresh skeleton exist only to make setup
   possible and do **not** constrain the final arrangement.
4. Choose and configure the repository's ticket source and workflow states. Ask
   the user for team-specific facts you cannot inspect. Secrets belong in the
   environment (a local `.env` is acceptable), never in `autobuild.toml`.
5. Arrange repository-appropriate end-to-end verification. Include whatever
   this repository needs to make a running application available to the tests;
   describe and configure the goal using its actual tooling and conventions.
   When that verification requires agent judgment, author a repository-owned
   agent-verify skill and name it from the appropriate `[verify.<step>]` table.
   Autobuild does not ship a generic sample verifier to edit.
6. Validate the resulting configuration with the available `ab` commands and
   repository checks. Explain the final setup to the user.
7. Use the installed grooming and ticket skills to create one groomed,
   dispatchable ticket, so the user can run `ab dispatch` immediately.

Ask focused questions rather than constraining the user to a fixed list. Do not
create an Autobuild build, session, event, transcript, or other BuildStore
record as part of setup.

## Authoring an agent verifier

A repository-owned agent-verify skill is a verifier, not a reviewer: it drives
the running application and observes whether the spec's acceptance criteria
hold. It does not inspect the diff for style or edit product code.

Its session instructions must preserve this contract:

1. Run `ab context`. The verifier receives `.ab/spec.md`, the configured step,
   the commit range, and, after its own escalation is answered,
   `.ab/guidance.json`. Treat that answer as authoritative input for the rerun.
2. Exercise the real behavior for each applicable acceptance criterion using
   the repository's application lifecycle and tooling. Prefer the narrowest
   honest flow that would catch a regression.
3. For an applicable run, write a criterion-oriented report: criterion, action,
   observation, and pass/fail. A failure report must include exact reproduction
   details, inputs, expected versus observed behavior, and relevant
   repository-native logs so the implementer can act on it.
4. Explicitly deposit exact review evidence with
   `ab artifact put <kind> <file> --attach`. Attach only evidence from a passing
   run, never failed or partial output, and use stable kinds so a retry replaces
   the prior designation.
5. Finish with exactly one terminal:

   ```text
   ab verdict pass --notes <report-file>
   ab verdict fail --report <report-file>
   ab verdict skip --reason "Why this entire step does not apply"
   ```

An applicable behavior that cannot be exercised is a failure with an
explanation, never a skip or silent pass. Use `skip` only when the entire
configured step genuinely does not apply. If `.ab/guidance.json` still does not
make a verdict possible, escalate again and explain what remains unresolved.
The verifier reports build defects to the implementer and records out-of-scope
work with `ab observe`; it does not fix either itself.
