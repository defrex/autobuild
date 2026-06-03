---
name: spec
description: Design a feature through conversation, producing a design doc at build/[feature]/design.md. Right-sizes the doc to the task — a few lines for something simple, a fuller structured spec for something larger. Infers the feature directory from the conversation — no argument needed. Stops after the design is written — switch to plan mode for implementation planning.
argument-hint: "[feature-name] (optional)"
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(mkdir *)
---

# /spec

Produce a feature design at `build/[feature]/design.md`. Stop when the design is satisfactory — do not plan or implement. The user will switch to plan mode next.

**Level the detail to the task.** A design doc is a tool, not a ceremony — its job is to capture exactly enough for someone (or `/build`) to implement the feature well, and no more. Prefer the smallest doc that does that. A simple, well-understood change might need only a couple of sentences and a short bullet list; a large or subtle feature with real architectural decisions warrants the fuller structure below. Match the doc to the nature of the task so this process stays worth using for small work as well as large.

The `[feature]` directory name is normally **inferred from the conversation**, not supplied as an argument. An argument, when given, is an explicit override.

## Step 1: Resolve the feature directory

- **If an argument is provided**, use it (kebab-cased) as the feature directory name. If `build/[feature]/design.md` already exists, read it, give a brief summary, and ask the user what they'd like to change — then iterate (Step 5). Otherwise proceed to Step 2.
- **If no argument is provided**, don't pick a name yet — you'll infer it from the conversation in Step 3. Do not create any directory. Proceed to Step 2.

## Step 2: Discuss

Ask the user to explain what they're looking for. Have a conversation to understand requirements, constraints, and goals before writing anything.

Do NOT explore the codebase, draft the design doc, or create any directory yet. Wait for the user to explain and for any discussion to resolve.

## Step 3: Name the feature and check for an existing design

Once you understand what the user wants:

1. **Settle the directory name** (if it wasn't given as an argument). Derive a short, descriptive kebab-case name from the task description — e.g. "add a snooze button to todos" → `todo-snooze`. State the name you've chosen in one line so the user can correct it before you write anything.
2. **Check for an existing design** at `build/[feature]/design.md`. If it exists, read it, summarize what's in it, and ask what they'd like to change — then iterate (Step 5) rather than drafting fresh.

## Step 4: Explore and draft

This step is for a **fresh** design. If `build/[feature]/design.md` already existed (found in Step 1 or 3), skip it — the directory and doc are already there; go straight to Step 5 and iterate.

Once you understand what the user wants and have a name:

1. **Judge how much design the task actually needs.** Explore the codebase enough to be concrete, but scale that effort to the work: a small, well-understood change needs only a quick look to ground it; a large or subtle feature warrants real investigation of architecture, patterns, and relevant code.
2. Create the `build/[feature]/` directory and draft a design doc at `build/[feature]/design.md`, **sized to the task**:
   - **Small / well-understood change** → keep it short. A sentence or two of intent plus a short bullet list of the concrete changes is often the whole doc. Don't force in sections you have nothing to say under.
   - **Larger / architectural feature** → use the fuller structure:
     - **Overview**: what the feature does and why
     - **Design**: how it works — architecture, data flow, key components
     - **Open Questions**: anything that needs user input or further thought
   - Most tasks land in between — include the sections that earn their place and drop the rest.

Whatever the size, make it concrete: reference actual files, functions, and patterns from the existing code as `path/to/file.ts:42` so the user (and `/build`) can navigate.

### Format notes

The file is Markdown. Use standard Markdown — headings, lists, fenced code blocks, tables — and lean on it freely (tables for side-by-side comparisons, `<details>` for collapsible sections, fenced blocks for diagrams or code) when it clarifies the design. Don't add structure for its own sake; plain prose and lists are fine when that's all the content needs.

A short design might be as little as:

```md
# todo-snooze

Add a snooze action to todos that hides them until a chosen time.

- New `snoozedUntil` field on the `todos` table (`convex/schema.ts`)
- Snooze button + time picker on the todo row (`_components/todo-row.tsx`)
- Filter snoozed todos out of the active list until `snoozedUntil` passes
```

A fuller design uses headed sections:

```md
# [feature]

## Overview

...

## Design

...

## Open Questions

- ...
```

## Step 5: Iterate

Tell the user what you've drafted and ask for feedback. As they request changes, update `build/[feature]/design.md` accordingly.

When the user is satisfied, stop. Suggest they switch to plan mode to continue.
