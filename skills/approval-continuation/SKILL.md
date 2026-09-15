---
name: approval-continuation
description: Keep agent work moving through narrow approval prompts and premature stops while learning repository-specific verification procedures. Use for repeated safe approvals, failed verification invocations, recurring procedures, or an agent that stops while clearly scoped work remains.
---

# Approval & Continuation Policy

Use the installed event hooks (small Node.js programs invoked by the agent
runtime) as the enforcement and observation mechanism. This skill explains
their decisions; it does not grant permissions by itself.

All supported agents discover this same canonical directory through symbolic
links. Do not create editor-specific copies.

## Live settings

Read `~/.agents/skills/approval-continuation/config.json` when a task depends on
the current policy. The hook reads it again for every event, so a settings
change applies without restarting active agents.

The runtime may cache `SKILL.md` for one session. A changed skill document can
therefore require a new session even though the JSON settings do not.

## Approval handling

- Automatically allow only an explicitly enabled class whose command shape is
  validated by the hook.
- Leave unknown requests undecided so the user sees the normal prompt.
- Never treat an arbitrary package script as safe merely because it is named
  `test`, `lint`, or `check`.
- Permission for one command never grants broader authority, secret access,
  external communication, or a global policy change.

## Continuation handling

The `Stop` event may request one more pass only when settings enable it, the
last message explicitly says work remains, and the message does not ask the
user for a decision. The hook atomically limits this to one continuation per
session by default (`maxAutomaticContinuationsPerSession: 1`). The runtime loop
marker and the per-session marker both stop repeated continuation. An explicit
completion sentence such as «дальше ничего менять не нужно» always suppresses
the request. If the event has no session identifier, the hook fails closed.

Do not continue automatically when work requires a product choice, new
authority, an ambiguous destructive target, a production mutation, or missing
user data.

## Project observations

Verification results live under:

```text
~/.agents/skills/approval-continuation/projects/<readable-project-alias>/observations.json
```

The shared `ai-agents-library` project-location module maps the canonical path
to this readable directory. Observations are hints, not policy. Never record
full output, prompts, credentials, environment values, or environment files.

Before widening persistent behavior, show what changes, where it is stored,
when it triggers, the risks, and how to undo it. Never promote an observation
into policy automatically.
