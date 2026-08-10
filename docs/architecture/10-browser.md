# Browser architecture and interaction model

Covers sections 15 and 16 of the authoritative architecture. Back to the [index](README.md).

## 15. Browser architecture

### 15.1 Two loopback origins

Run two HTTP listeners in the same daemon process:

| Origin | Responsibility |
|---|---|
| Shell origin | Trusted Tweakloop UI, API, authentication, event stream |
| Artifact origin | Read-only immutable artifact revisions and bridge script |

Example:

```text
http://127.0.0.1:49152
http://127.0.0.1:49153
```

Ports are assigned dynamically.

The artifact origin exposes no mutation API and receives no shell authentication cookie.

The shell origin is also the human-authority boundary. Human decisions, comments, default-human
chat, and accepted-work reopening derive their principal from the authenticated browser transport.
An agent identity string, CLI bearer, or semantic automation token cannot manufacture or redeem
that authority. A CLI handoff may print the `session url` command, but it does not mint or export the
single-use browser token while handling the gated action.

### 15.2 Why two origins

Agent-generated HTML must be treated as untrusted application content.

It may contain:

- arbitrary JavaScript;
- third-party libraries;
- forms;
- links;
- media;
- interactive controls;
- malformed markup;
- accidental or intentional requests.

Keeping it on a distinct origin prevents it from reading the shell DOM or using shell credentials.

### 15.3 Artifact iframe

Recommended iframe policy:

```html
<iframe
  sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
  referrerpolicy="no-referrer"
></iframe>
```

`allow-same-origin` is acceptable only because the artifact and shell use separate origins, and the artifact server has no privileged mutation endpoints.

The exact sandbox permissions should be capability-driven and minimized per artifact.

### 15.4 Bridge using `MessageChannel`

The shell creates a `MessageChannel` after the artifact loads and transfers one port to the artifact bridge.

The transferred port is the communication capability.

Use `window.postMessage` only for the initial exact-origin handshake. Validate:

- `event.origin`;
- `event.source`;
- protocol version;
- message type;
- payload schema.

Always send to an exact target origin, never `"*"`.

Subsequent bridge traffic uses the transferred `MessagePort`.

### 15.5 Bridge responsibilities

The bridge may:

- discover semantic nodes;
- report text selections;
- report clicked target metadata;
- provide rendered text snapshots;
- provide source-map hints;
- highlight selected nodes;
- switch interaction modes;
- capture structured answers;
- notify the shell of artifact navigation;
- report load failures.

The bridge may not:

- mutate daemon state directly;
- receive shell cookies;
- read repository files;
- execute agent commands;
- mark work accepted;
- silently modify the artifact source.

### 15.6 Bridge message envelope

```json
{
  "protocol": "tweakloop.bridge/v1",
  "type": "selection.changed",
  "revisionId": "rev_...",
  "sequence": 14,
  "payload": {
    "semanticId": "architecture.data-storage",
    "textQuote": {
      "exact": "PostgreSQL Flexible Server"
    }
  }
}
```

Reject unknown protocol major versions.

Ignore duplicate or out-of-order bridge sequences where ordering matters.

## 16. Interaction model

HTML interactivity is primary, not an exception.

Use three explicit modes:

| Mode | Artifact behavior | Tweakloop behavior |
|---|---|---|
| Interact | Normal page operation | Minimal shell overlay |
| Inspect | Artifact interaction suppressed for selected click | Reveal semantic/source metadata |
| Annotate | Selection and target capture | Create feedback draft |

Default to **Interact**.

The current mode must always be visually obvious.

Provide a keyboard shortcut and persistent toolbar control.

Do not require every interactive element to be annotated with a special attribute merely to function.

`data-tweak-interaction` is only for exceptional subtree policy:

```text
native
freeze-during-annotation
frame-target
disabled
```

The system must never present a normal-looking interactive control that is silently inert.
