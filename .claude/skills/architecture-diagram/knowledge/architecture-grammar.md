---
title: Architecture graph grammar
description: Compact semantic rules for components, relationships, boundaries, labels, and layout.
---

# Architecture graph grammar

A component is a responsibility-bearing thing, not every noun in the prompt. A relationship must
state source, meaning, and target; direction is part of the claim. A group is justified only by a
boundary such as ownership, trust, runtime, or lifecycle. A label clarifies role or relationship but
does not repair an ambiguous graph. Layout communicates reading order and hierarchy, so it is a
semantic projection rather than decoration.

Prefer the smallest graph that preserves the decision-relevant claim. Merge aliases. Split a box
only when the resulting components have different responsibilities or boundaries. Keep uncertain
relationships visibly uncertain. Apply layout only after nodes, edges, labels, and groups stabilize;
then read every arrow aloud and inspect what group membership implies.
