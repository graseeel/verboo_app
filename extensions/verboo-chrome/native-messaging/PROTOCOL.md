# Verboo in Chrome bridge protocol

The packaged Rust helper implements both the stdio MCP server and Chrome Native Messaging host. The desktop app installs and diagnoses it, but is not part of the runtime path.

## Reserved contract

- Host name: `com.verboo.code.browser_extension`
- Protocol version: `1`
- Envelope: `{ version, id, kind, secret?, payload }`
- Kinds: `hello`, `toolRequest`, `toolResponse`, `error`
- Host to Chrome maximum: 1 MiB
- Chrome to host maximum: 64 MiB

The MCP process discovers a live Native Host through a private, per-user record. Each record contains a random session secret. Local requests are authenticated with that secret, while the secret is removed before the request reaches the extension.

The extension remains the browser controller. Every relayed tool request passes through the canonical catalog, policy gate, and shared approval executor. If an approval is required while the side panel is closed, the extension returns `approval_ui_unavailable` and executes nothing. Disconnected in-flight requests are not replayed.

The bridge never receives or forwards CLI or extension OAuth tokens. Standalone extension chat and CLI authentication remain separate.

The runtime implementation ships atomically with:

1. the Rust Native Messaging host and MCP server;
2. per-user manifest installation for Google Chrome on macOS, Windows, and Linux;
3. a configured production extension ID plus an explicit development ID;
4. version checks, authenticated per-session local transport, and bounded framing;
5. extension tests proving protocol mismatch, malformed-envelope, disconnect, and no-replay behavior.

The per-user installer writes `allowed_origins` for exactly one configured production or development extension ID.
