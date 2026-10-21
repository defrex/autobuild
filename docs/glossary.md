---
title: Glossary
group: reference
order: 12
description: "Definitions for tickets, integration, execution boundaries, and agent roles."
---

# Glossary

The [architecture reference](architecture.md) maps these terms to code.

## Build

One execution for a claimed ticket, identified by an immutable slug and recorded in a durable event stream. Work builds run the [fixed pipeline](builds.md); node builds collect, verify, and land contributions.

## Ticket

A source-tracked unit of proposed work or a finite integration point. It becomes eligible for dispatch after meeting configured readiness and dependency gates; see [Tickets](tickets.md).

## Spec

The build's contract: observable intent, rationale, acceptance criteria, scope limits, and evidence. Grooming establishes it before dispatch under the [spec standard](spec-standard.md).

## Node

A finite integration build that collects child contributions, verifies its exact head and parent, and lands into its parent. It can nest and closes when complete; see [integration trees](integration-tree.md).

## Target

A ticket's integration destination: a node ticket, or the configured root when omitted. Targets decide where work lands; blockers separately decide when it can start.

## Seam

A narrow interface separating the kernel from infrastructure such as ticket sources, stores, or runtimes. See [Seams](seams.md).

## Adapter

An implementation of a seam for a particular provider or environment. Adapters supply infrastructure behavior while the kernel retains lifecycle decisions.

## Verifier

A configured deterministic check or evidence-judging agent that tests whether a build meets its contract. Verifiers report typed outcomes; code owns subsequent transitions.

## Escalation

A durable question or failure requiring an external answer before work proceeds. Your operator agent records authorized guidance or retry through the [answer interface](answering-blocked-builds.md).

## Landing

The guarded integration of a ready contribution into its destination. Authorization follows [landing policy](landing-policy.md) and remains subject to verification and forge gates.

## Restack

A kernel-owned replay of a leaf's net change or a node's ordered contributions onto a refreshed destination. Clean replay needs no agent; see [restacking](restacking.md).

## Reconcile

The agent phase resolving conflicts in a kernel-prepared replay against a frozen refreshed base. The kernel publishes the result and runs required verification.

## Operator agent

Your external agent role that writes specs, files and grooms tickets, watches the dispatcher, answers escalations, and manages authorized landing. It works outside the hosted build pipeline through the CLI or connected tools; you are the human supplying intent and authority.
