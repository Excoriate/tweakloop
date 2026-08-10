# Native hook adapter v2

The canonical source tree for Tweakloop's optional public native hook adapter is
`.agents/hooks/v2/`; `hooks/v2/` is its byte-for-byte public package projection. The standalone
`scripts/sync-hooks.mjs` projector does not read contributor-specific orchestration, repository
task state, or client configuration.

`continue-on-inbound.mjs` adapts a documented client Stop payload to the finite public command:

```text
tweak --workspace <native-cwd> --json native-hook observe \
  --client <claude-code|codex|cursor> \
  --profile <profile-id> \
  --conversation <native-conversation-id>
```

The non-secret profile locator is supplied by generated configuration as `--profile <id>`; direct
invocations may continue to use `TWEAKLOOP_NATIVE_PROFILE_ID`. An optional absolute
`TWEAKLOOP_HOOK_CLI` selects the executable; otherwise the adapter resolves `tweak` from `PATH`. The
binding bearer is never supplied to this adapter: the CLI loads it from private state-root custody.

The adapter fails closed with `{}` when the native contract does not match, the native conversation
identity is missing, a recursion guard is active, no profile/binding exists, or the observation is
`kind:none`. Only the closed `tweakloop.native-hook-observation/v1` `kind:continue` response is
translated into a client continuation response.

This adapter observes only. It does not list workspace events, acquire inbound delivery, claim
work, or write presence/progress. It asks an already-running client to continue at least once; it
does not launch a stopped client and cannot prove exactly-once native acceptance.

Generate one opt-in project configuration only at an explicitly named, previously absent path:

```text
node hooks/v2/configure-client.mjs \
  --client <claude-code|codex|cursor> \
  --profile <non-secret-profile-id> \
  --output <project>/.claude/settings.json|<project>/.codex/hooks.json|<project>/.cursor/hooks.json
```

The configurator refuses existing settings instead of merging or overwriting them. Its finite JSON
receipt names the generated file, configuration hash, adjacent packaged adapter, and the explicit
`native-hook bind` command template required after the native conversation exists. Generation does
not activate trust, bind authority, or prove client invocation; review the file, use the client's
native trust/configuration UI, bind the exact active conversation, and remove the single generated
file to roll back. Each installed client still needs a version-pinned activation check.

## Activation checks

Treat configuration generation and native invocation as separate proof layers:

- Claude Code: load the generated project settings, start a real conversation, bind that exact
  session ID, and prove a Stop callback reaches `native-hook observe`. A second Stop must terminate
  through the recursion guard.
- Codex: use the normal configuration stack, then trust the project and exact hook command (or use
  Codex's one-invocation hook-trust bypass). Bind the exact thread ID and prove the callback. Do not
  use `--ignore-user-config` as the activation check because it can omit the project hook layer.
- Cursor: trust and reload the workspace, bind the exact conversation ID, and verify the callback
  in Cursor's Hook Execution Log plus the adapter receipt. Absence of a callback is unsupported or
  disabled activation, never success.

Do not bind a guessed or copied conversation ID. Activate only after the client exposes the native
identity used by the observed callback. These checks require only the packaged `hooks/v2` adapter
and Tweakloop CLI; contributor-specific harnesses are neither required nor accepted as evidence.
