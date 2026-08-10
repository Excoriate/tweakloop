---
title: Identity-preserving board mutation
description: Positive specimen for capability selection, managed synchronization, and immutable publication.
---

# Identity-preserving board mutation

The user asks to move an existing service box and relabel its outbound arrow. Both elements already
carry review comments. The agent first identifies the board artifact, session, assigned work, target
element IDs, and `customData.tweakloop.anchorId` values. A native Excalidraw editor is available but
the live Tweakloop canvas is not, so the agent selects the managed checkout route.

Checkout records the target identities in its opaque sync state. The agent opens the exact returned
scene path in the native editor, makes the smallest visual change, and saves. It does not inspect or
edit the sidecar and never constructs an element object. The outgoing arrow remains bound to the
same semantic target; unrelated shapes and camera state are preserved.

Managed sync returns accepted with the expected target identities intact. Only then does managed
publish return an immutable revision. The claimed work is completed against that exact revision and
the summary accounts for each intent. A browser render shows the moved box and relabeled arrow, and
locating either original comment still resolves to its intended element.

This is a positive specimen because editable scene authority, target identity, native-editor
ownership, accepted sync, immutable publication, and rendered effect all agree. A scene that merely
looks right but changes an anchor, a save with no accepted sync, or a flattened PNG fails the bar.
