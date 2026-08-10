---
title: Session handoff and reconstruction
description: Load for exact session lineage, resume, handoff, takeover, source-less artifacts, and multi-artifact session work.
---

# Session handoff and reconstruction

Load this reference for resume, handoff, end, fetch, takeover, or multiple artifacts within one
session. Workspace export/restore is a different route.

Sessions are immutable lineage facts. Work, comments, chat, revisions, attached artifacts, and
questions are derived fresh when inspected. Durable status is not live presence or a claim lease.

## Find the exact lineage

```bash
tweak session list --document <artifact-id-or-source-path> --json
tweak session show <sessionId> --json
```

`session show` is the takeover packet: exact document identity; origin/current agent; goal and
summary; predecessor/successor lineage; base/head/session revisions; correlated work and typed
intents; complete correlated chat/questions; and mentioned artifacts. If session, agent, process,
or artifact identity is ambiguous, stop instead of selecting the newest-looking record.

## Fetch browser-opened bytes without changing identity

When a receipt has `sourcePath: null`, choose a fresh destination that does not exist:

```bash
tweak session fetch <sessionId> <artifactId> <fresh-destination> --json
```

Edit those bytes, but publish to the original durable identity:

```bash
tweak publish <fresh-destination> --artifact <artifactId> --session <sessionId> --json
```

The fresh path is an editing location, never a new document identity.

## Hand off or resume

```bash
tweak session handoff <sessionId> --agent agent:<current> \
  --to-agent agent:<next> --summary "Done, remaining, evidence, and blockers" --json
tweak session resume <sessionId> --agent agent:<next> \
  --process <new-stable-process-nonce> --json
```

Resume creates a successor instead of rewriting its predecessor and returns the exact review URL.
A handoff never steals a live work claim; the receiving agent uses finite `next` or explicitly
claims exact open work. When ending a collaboration, use the command returned by the current
session receipt rather than inferring state from an old snapshot.

For a session that starts without an artifact:

```bash
tweak session start --empty --agent agent:<name> \
  --title "<high-signal title>" --goal "<collaboration goal>" --json
tweak next --session <sessionId> --wait --timeout 300000 --json
```

Human-added files become durable session facts; inspect their exact artifact identities before
fetching or editing them.
