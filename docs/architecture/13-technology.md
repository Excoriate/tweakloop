# Technology selection, source layout and dependency direction

Covers sections 23, 24 and 25 of the authoritative architecture. Back to the [index](README.md).

## 23. Technology selection

### 23.1 Recommended stack

| Concern | Recommendation |
|---|---|
| Runtime | Node.js with TypeScript |
| Domain style | Pure functions, readonly data, discriminated unions |
| Storage | SQLite through `better-sqlite3` adapter |
| HTTP | Native `node:http` with a small explicit route table |
| Protocol validation | JSON Schema with a runtime validator |
| HTML parsing | `parse5` or equivalent standards-oriented parser |
| Markdown | `mdast`/`remark` ecosystem with source positions |
| Browser UI | React used only as a rendering adapter |
| UI state | Reducers over immutable snapshots and events |
| Build | `pnpm` workspace plus a conventional bundler |
| Unit tests | `node:test` or a similarly minimal runner |
| Browser tests | Playwright |
| IDs | Random UUIDs; database `seq` provides ordering |
| Hashes | Node cryptography SHA-256 |
| Logging | Structured JSON logs to file/stderr |

### 23.2 Why TypeScript rather than Clojure

Do not choose Clojure merely to imitate Rich Hickey.

The important choices are:

- immutable information;
- explicit effects;
- data protocols;
- functions over data;
- temporal history;
- serialized consistency;
- independent dimensions.

TypeScript lowers adoption and contribution friction for an OSS browser/CLI project.

Enforce the design through module boundaries and tests rather than expecting the language to enforce it automatically.

### 23.3 Domain coding constraints

Inside `src/domain`:

- no classes;
- no mutable module-level variables;
- no framework imports;
- no database imports;
- no filesystem imports;
- no timestamps generated internally;
- no random IDs generated internally;
- no environment access;
- no implicit singletons.

Time, IDs, actors and current facts arrive as inputs.

Infrastructure modules may use controlled mutation where the runtime requires it.

## 24. Source layout

Begin as one package with strong module boundaries rather than prematurely publishing many packages:

```text
src/
  domain/
    commands/
    events/
    decisions/
    projections/
    policies/
    invariants/

  protocol/
    schemas/
    validation/
    versions/

  storage/
    sqlite/
    object-store/
    migrations/

  artifacts/
    common/
    html/
    markdown/
    semantic-index/
    diff/

  daemon/
    transactor/
    workspace/
    runtime/
    watchers/
    http/
    event-stream/

  cli/
    commands/
    output/
    daemon-client/

  bridge/
    protocol/
    runtime/
    selection/
    highlighting/

web/
  shell/
  inspector/
  timeline/
  feedback/
  diff/
  work/
  reducers/

test/
  domain/
  protocol/
  storage/
  artifacts/
  concurrency/
  browser/
  crash/
  fixtures/
```

Split publishable packages only when a real consumer needs a stable independent dependency.

## 25. Dependency direction

Allowed dependency direction:

```text
web → protocol
cli → protocol
daemon → domain + protocol + storage + artifacts
storage → protocol primitives
artifacts → protocol primitives
domain → protocol value types
```

Forbidden:

```text
domain → daemon
domain → storage
domain → web
domain → CLI
artifact adapter → agent implementation
bridge → shell implementation
```

The domain must remain executable in an in-memory test with plain values.
