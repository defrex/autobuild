---
name: ab-setup
description: Configure Autobuild for this repository after deterministic installation. Inspect the repository, ask the user for choices code cannot answer, and leave a dispatch-ready setup.
---

# Autobuild setup

You are configuring Autobuild outside the build pipeline. This conversation is
not a build or phase. Work directly in the repository and involve the user in
choices that cannot be derived from source.

1. Inspect the repository's manifests, documentation, CI, test layout, and
   conventions. Read `.agents/skills/ab-guide/SKILL.md` for Autobuild's complete
   configuration and ticket surfaces.
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
6. Validate the resulting configuration with the available `ab` commands and
   repository checks. Explain the final setup to the user.
7. Use the installed grooming and ticket skills to create one groomed,
   dispatchable ticket, so the user can run `ab dispatch` immediately.

Ask focused questions rather than constraining the user to a fixed list. Do not
create an Autobuild build, session, event, transcript, or other BuildStore
record as part of setup.
