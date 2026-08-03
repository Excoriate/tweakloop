# Security Policy

## Scope

Tweakloop is a **local-first** tool. The daemon binds to loopback (`127.0.0.1`) only, uses OS-assigned dynamic ports, authenticates the CLI with a file-permission-protected bearer token, and authenticates browsers through single-use bootstrap tokens exchanged for `HttpOnly` session cookies. The artifact origin is isolated from the shell origin and exposes no mutation routes. Agent-generated HTML is treated as untrusted content.

Security-relevant design details live in [docs/architecture/11-realtime-and-http.md](docs/architecture/11-realtime-and-http.md) and [docs/architecture/10-browser.md](docs/architecture/10-browser.md).

## Reporting a vulnerability

Please report vulnerabilities **privately** via [GitHub Security Advisories](../../security/advisories/new) ("Report a vulnerability" on the repository's Security tab). Do not open public issues for security reports.

Include: affected version (`tweak --version`), platform, a reproduction, and impact assessment (e.g. cross-origin access from artifact content, token leakage, non-loopback exposure).

You can expect an acknowledgment within a few days. Fixes are released as patch versions; reporters are credited unless they prefer otherwise.

## Out of scope

- Attacks requiring an already-compromised local user account (the trust boundary is the OS user).
- Denial of service against your own local daemon.
