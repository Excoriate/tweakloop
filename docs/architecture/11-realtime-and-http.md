# Real-time updates, projections, HTTP surface and security

Covers sections 17, 18, 21 and 22 of the authoritative architecture. Back to the [index](README.md).

## 17. Real-time update model

Use ordinary command POSTs from the shell to the daemon.

Use one server-sent event connection from the shell for committed updates:

```text
GET /api/v1/events?after=<seq>
```

SSE is a one-way server-to-browser channel, which matches committed-domain-event delivery without introducing full-duplex socket state. It is broadly available in browsers.

Use SSE event IDs equal to durable database sequences.

On reconnect:

1. browser sends its last observed sequence;
2. daemon replays later committed events;
3. browser reducers update projections;
4. if the gap is too large or incompatible, browser fetches a fresh projection snapshot.

Use one SSE connection for the shell, not one connection per artifact iframe.

Do not introduce WebSockets until there is a proven bidirectional streaming requirement that POST plus SSE cannot satisfy.

## 18. Projection architecture

The event log is canonical.

The browser and CLI read materialized projections.

Initial projections:

| Projection | Answers |
|---|---|
| Artifact catalog | What artifacts exist? |
| Revision graph | What revisions and branches exist? |
| Current presentation | What revision is currently shown? |
| Intent inbox | What has the human requested? |
| Claimable work | What can an agent claim now? |
| Work progress | What was claimed or addressed? |
| Verification view | What passed or failed? |
| Decision view | What did the human accept or reopen? |
| Timeline | What happened, in order? |
| Anchor health | Which feedback targets remain valid? |

Projection reducers must be deterministic.

Given the same ordered events, they must produce the same values.

Provide:

```bash
tweak repair --rebuild-projections
```

This command:

1. backs up projection tables;
2. clears them;
3. replays the event log;
4. compares invariants;
5. replaces the old projections only when successful.

Event migrations should be avoided. Support old event schema versions through readers/upcasters used by projection code.

## 21. HTTP surface

Keep the public daemon HTTP surface small.

Recommended shell-origin routes:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Process nonce and protocol health |
| `GET` | `/bootstrap/:token` | One-time browser authentication |
| `GET` | `/app/*` | Trusted browser shell |
| `POST` | `/api/v1/commands` | Durable command submission |
| `GET` | `/api/v1/snapshot` | Current projection snapshot |
| `GET` | `/api/v1/events` | SSE committed-event stream |
| `GET` | `/api/v1/artifacts/:id` | Artifact projection |
| `GET` | `/api/v1/revisions/:id` | Revision manifest |
| `GET` | `/api/v1/diffs/:before/:after` | Semantic diff |
| `GET` | `/api/v1/blobs/:hash` | Authorized shell evidence access |

Recommended artifact-origin routes:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/r/:revisionId/*` | Immutable revision files |
| `GET` | `/bridge/:version.js` | Versioned bridge |
| `GET` | `/health` | Artifact listener health |

The artifact origin has no POST routes.

## 22. Browser authentication and request security

Opening the browser should use a one-time bootstrap capability:

```text
http://127.0.0.1:<shell-port>/bootstrap/<256-bit-random-token>
```

The daemon:

1. validates and consumes the token;
2. sets an HttpOnly, SameSite=Strict shell cookie;
3. redirects to a tokenless application URL.

Mutation requests must additionally validate:

- exact `Origin`;
- expected `Host`;
- CSRF token or equivalent same-origin request token;
- command schema;
- workspace identity.

The artifact origin receives no shell cookie.

Prevent DNS rebinding by validating allowed hostnames.

Default allowed hosts:

```text
127.0.0.1
localhost
[::1]
```

Do not support LAN or public binding without an explicit future security design.
