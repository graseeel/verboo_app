# Verboo in Chrome bridge protocol

This directory currently contains the contract only. The extension does not request `nativeMessaging`, connect to a native host, or advertise a desktop connection until the packaged Rust helper and per-user installation flow ship together.

## Reserved contract

- Host name: `com.verboo.code.browser_extension`
- Protocol version: `1`
- Envelope: `{ version, id, kind, secret?, payload }`
- Kinds: `hello`, `toolRequest`, `toolResponse`, `error`
- Host to Chrome maximum: 1 MiB
- Chrome to host maximum: 64 MiB

The extension remains the browser controller. Every relayed tool request must pass through the canonical catalog, policy gate, and shared approval executor. The local bridge must never receive or forward CLI/OAuth tokens.

The runtime implementation must ship atomically with:

1. the Rust Native Messaging host and MCP server;
2. per-user manifest installation for Google Chrome on macOS, Windows, and Linux;
3. a configured production extension ID plus an explicit development ID;
4. version checks, authenticated per-session local transport, and bounded framing;
5. extension tests proving protocol mismatch, malformed-envelope, disconnect, and no-replay behavior.

Until all five exist, `nativeMessaging` stays absent from `manifest.json`.
