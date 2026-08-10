---
title: Ordinary durable review trace
description: Positive specimen showing the exact decisions and receipts a Tweakloop agent preserves.
---

# Ordinary durable review trace

The assignment is to revise `/workspace/plan.html` after a human review. The repository is a
Tweakloop source checkout, so the agent builds once and pins the absolute local CLI plus the
absolute workspace root. A PATH-installed binary is deliberately ignored.

Before editing, the agent lists artifacts and sessions for the exact intended path. The result maps
the path to `artifact_plan` and `session_review_7`; therefore the agent keeps that identity and does
not create a second proposal. It then receives `work_plan_12` through finite `next`, preserves its
claim receipt, and accounts for each typed intent in the revision.

The agent publishes only the intended file through the claim-derived compound command returned by
the skill route. The receipt binds `work_plan_12` to the newly returned immutable revision. The
summary names only satisfied intent IDs. If publication returns partial recovery, the agent stops
and executes the exact returned recovery command instead of reconstructing a claim, revision, or
session identifier.

Finally, the agent waits for the next durable decision. It reports “ready for review” after its own
publication. It does not report human acceptance until a human Accept fact appears. This specimen is
positive because executable, identity, work authority, intended bytes, and acceptance stay separate;
a trace that authors before artifact discovery or calls agent completion “accepted” fails the bar.

## Recorded fixture and observed effect

The observed effect is a new immutable revision whose receipt binds `work_plan_12` to the intended
bytes while human acceptance remains absent. Exit 0 alone does not satisfy this fixture. On failure
or partial publication, the operator runs the exact returned recovery command; without one, the
agent escalates and never reconstructs durable IDs.
