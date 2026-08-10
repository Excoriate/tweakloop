---
title: Golden service-topology specimen
description: Positive semantic plan and coherence grade for a browser, API, and database topology.
---

# Golden service-topology specimen

The request says: “Show a browser calling an API. The API reads a database. The API and database
belong to the service runtime; the browser does not.” The agent first confirms the semantic scene
capability from current help. It plans three stable components: Browser, API, and Database. It plans
two directed relationships: Browser calls API, and API reads Database. The Service Runtime group
contains API and Database only. Concise labels describe roles without duplicating the prose.

After `tweak whiteboard scene --help` lists all seven leaves, the executable specimen is:

```bash
# If this succeeds, preserve the returned semantic scene as the before-state.
# If and only if it returns error.code=whiteboard.draft-missing for this published board in the
# active session, the first add-node below initializes the managed draft.
tweak whiteboard scene inspect <document> --json
tweak whiteboard scene add-node <document> browser --session <session-id> --idempotency-key service-topology-node-browser --shape rectangle --label "Browser"
tweak whiteboard scene inspect <document> --json
tweak whiteboard scene add-node <document> api --session <session-id> --idempotency-key service-topology-node-api --shape rectangle
tweak whiteboard scene set-label <document> api --session <session-id> --idempotency-key service-topology-label-api --text "API"
tweak whiteboard scene add-node <document> database --session <session-id> --idempotency-key service-topology-node-database --shape rectangle --label "Database"
tweak whiteboard scene add-edge <document> browser-calls-api --session <session-id> --idempotency-key service-topology-edge-browser-api --from browser --to api --label "calls"
tweak whiteboard scene add-edge <document> api-reads-database --session <session-id> --idempotency-key service-topology-edge-api-database --from api --to database --label "reads"
tweak whiteboard scene group <document> service-runtime --session <session-id> --idempotency-key service-topology-group-runtime --members api database
tweak whiteboard scene layout <document> --session <session-id> --idempotency-key service-topology-layout-main --direction lr --gap 96
tweak whiteboard scene inspect <document> --json
tweak whiteboard scene publish <document> --idempotency-key service-topology-publish --agent <agent-id>
tweak session url <session-id> --document <document> --json
```

The stable business keys are visible and reusable only for exact retries of their named command.
There are no manual coordinates; deterministic layout owns placement. The leaf commands map to
`node.upsert`, `label.set`, `edge.upsert`, `group.set`, and `layout.apply` while the server retains
the request envelope and renderer fields.

The key ledger is frozen as nodes `browser`, `api`, `database`; edges `browser-calls-api`,
`api-reads-database`; and group `service-runtime`. `set-label` uses the exact active node key `api`.
The group has membership but no public label field, so the specimen MUST NOT call `set-label` for
`service-runtime` or a near-name such as `service`. The renderer draws one locked, unlabeled
enclosure around `api` and `database`; its descriptive semantic key carries the durable boundary
identity. A request that requires visible text naming the container exceeds this capability.

For cold start, the first accepted receipt and the immediately successful one-node inspect are the
initialization witness; any other initial inspect failure blocks. The artifact oracle requires all
accepted mutation receipts, a final inspect result matching the semantic plan, and a publication
receipt retaining the intended scene identity. The coherence oracle
then reads each arrow aloud and confirms the browser is outside the Service Runtime boundary. The
negative control reverses the reads edge. It is still graph-shaped and may still render attractively,
but now states that the database reads the API, so the coherence grade fails. The final `session
url` command mints the private one-use human-review handoff without another revision or session; the
agent does not open that URL itself. Publication is not called human-accepted until a distinct human
review fact exists.
