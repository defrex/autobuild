---
version: 1
slug: "app-dashboard-dashboardclient-tsx"
primary_target: "app/dashboard/DashboardClient.tsx"
related_targets: ["app/dashboard/BuildsView.tsx","app/sign-in/SignIn.tsx","app/sign-in/page.tsx","app/connect/Connection.tsx","app/connect/page.tsx","app/layout.tsx","app/globals.css","app/members/MembersClient.tsx","app/members/MembersView.tsx","app/organizations/OrganizationsClient.tsx","app/organizations/OrganizationsView.tsx","app/projects/ProjectsClient.tsx","app/projects/ProjectsView.tsx","app/access/Frame.tsx","app/access/AccountMenu.tsx"]
---

# Operator web app

Scope: the whole operator web app (shell, Builds, sign-in, connect, and the organization pages: Members, Organizations, Projects). Mode: Operate.

Audience and job: anyone who builds (engineers, product managers, designers), glancing from a second monitor or a phone, often with teammates in the same organization. On Builds, one question: does anything need me? Signals in priority order: BLOCKED on a human, FAILED or unhealthy, PR READY or MERGED. Then act on one row, answer an escalation, or inspect a trail. The organization pages are visited rarely and read, not glanced: add a person by email, see who is PENDING, know who can reach which projects.

Content: live operator API data only. Loading shows a diagnostic, never zeros. Vocabulary is binding and matches SPEC.md and the terminal dashboard; a newcomer meeting a pipeline term is told what it means.

Constraints: keep the Builds API client, view-model, parity projection, event vocabulary, and control names. Light and dark grounds are both first-class, following the system preference with an override in the account menu. Colors as tokens; every state color passes contrast on both grounds. Organization pages are separate single-column pages reached from the account menu, never panelled into Builds. Destructive steps confirm inline, never in a modal. Projects supports permanent deletion for super users and organization owners, with counts and a warning about data and credential loss; Move and Assign remain super-user operations. Page numbers and the app's title remain undecided.

Memorable moment: a calm page where the only color is state, so a red word is found from across the room.

## Direction contract

THESIS: ANSI. The terminal's colors are the app's only signals, on a calm light or dark ground, with plain-language captions so anyone who builds can read a build. Refuses the SaaS admin of sidebars and pill badges, and the costume terminal of all-mono jargon.

OWN-WORLD: Calm ground. Hues only as state: green done or running, amber in progress or retried, teal the current step alone, blue identity, red blocked or failed, grey pending. JetBrains Mono for machine values; Atkinson Hyperlegible Next for captions, titles, help. Mark-off steps [x] [>] [~] [ ], ruled rows, a sign-off box only where a human acts. No shadows, gradients, cards, emoji.

STORY: Glance, find the red word, act on one row, leave. Visit Members rarely; leave sure who can see what.

FIRST VIEWPORT: Builds: project selector left, account menu right; control line; ruled rows of blue id, sans ticket title, mono slug, status word right, steps beneath; a blocked row shows its red question over an ANSWER sign-off box.

FORM: user-steered hybrid of grounded candidate 5 and pick 1 on the terminal palette; seed key c4eff9b1.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
