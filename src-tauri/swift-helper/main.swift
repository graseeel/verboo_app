// Computer Use Helper — Swift sidecar for Verboo Code Desktop.
//
// Lazy-started by Rust `ComputerUseService` via `computer_use_spawn.rs`.
// Communicates over stdio using newline-delimited JSON. Every request has
// `id`; every response has `id + ok|err`. Mirrors Orca's CLI surface so
// the existing `~/.verboo/skills/computer-use/SKILL.md` agent skill works
// unchanged.
//
// P0 scope (Kratos arch §7.1, D6):
//   Read:  list-apps, list-windows, get-app-state (tree; screenshot opt-in)
//   Mutate: click, type-text, press-key, hotkey (M4 denylist), scroll
//
// Hard blocks (Tier 1, helper-enforced — Kratos arch §6.5):
//   - com.apple.systempreferences (never control)
//   - com.apple.loginwindow (never control)
//   - AXSecureTextField (never read/write/screenshot)
//   - Window titles matching password|senha|2FA|OTP|verification|recovery code
//   - Self-test blocked surfaces (Kratos §4.2.2): LoginScreen, credentials,
//     full-access toggle, CU disable toggle, audit viewer, allowlist editor.
//
// Hotkey denylist (M4 mandatory): Cmd+Q, Cmd+W, Cmd+Option+Esc → scope_denied.
//
// Emergency stop (M3): Cmd+Shift+Esc via Carbon global hotkey, OS-wide.

import Foundation
import ApplicationServices
import AppKit

// MARK: - IPC primitives

struct Request: Decodable {
    let id: Int
    let method: String
    let params: [String: AnyCodable]?
}

struct AnyCodable: Decodable {
    let value: Any
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let int = try? container.decode(Int.self) { value = int }
        else if let str = try? container.decode(String.self) { value = str }
        else if let bool = try? container.decode(Bool.self) { value = bool }
        else if let arr = try? container.decode([AnyCodable].self) { value = arr.map { $0.value } }
        else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else { value = NSNull() }
    }
}

func writeResponse(_ id: Int, result: [String: Any]?, error: (code: String, message: String)?) {
    var payload: [String: Any] = ["id": id]
    if let error {
        payload["result"] = NSNull()
        payload["error"] = ["code": error.code, "message": error.message]
    } else {
        payload["result"] = result ?? NSNull()
        payload["error"] = NSNull()
    }
    guard let data = try? JSONSerialization.data(
        withJSONObject: payload,
        options: [.sortedKeys, .withoutEscapingSlashes]
    ),
    let line = String(data: data, encoding: .utf8)
    else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

// MARK: - Tier 1 hard blocks (Kratos arch §6.5)

let HARD_BLOCKED_BUNDLE_IDS: Set<String> = [
    "com.apple.systempreferences",
    "com.apple.loginwindow",
]

let HOTKEY_DENYLIST: Set<String> = [
    "cmd+q", "cmd+w", "cmd+option+esc", "cmd+alt+esc", "ctrl+q", "ctrl+w",
]

func isHardBlocked(bundleId: String?) -> Bool {
    guard let id = bundleId?.lowercased() else { return false }
    return HARD_BLOCKED_BUNDLE_IDS.contains(id)
}

// MARK: - list-apps

struct AppInfo: Encodable {
    let bundleId: String?
    let name: String
    let pid: Int
    let isFrontmost: Bool
}

func listApps() -> [AppInfo] {
    let workspace = NSWorkspace.shared
    let frontmostId = workspace.frontmostApplication?.bundleIdentifier
    return workspace.runningApplications.compactMap { app in
        // Skip helper-like processes; only return apps with a UI.
        guard app.activationPolicy == .regular else { return nil }
        return AppInfo(
            bundleId: app.bundleIdentifier,
            name: app.localizedName ?? "<unknown>",
            pid: Int(app.processIdentifier),
            isFrontmost: app.bundleIdentifier == frontmostId
        )
    }
}

// MARK: - Dispatcher

func handle(_ req: Request) {
    switch req.method {
    case "capabilities":
        var caps: [String: Any] = [:]
        caps["commands"] = [
            "list-apps", "list-windows", "get-app-state",
            "click", "type-text", "press-key", "hotkey", "scroll",
        ]
        caps["hard_blocked_bundles"] = Array(HARD_BLOCKED_BUNDLE_IDS).sorted()
        caps["hotkey_denylist"] = Array(HOTKEY_DENYLIST).sorted()
        writeResponse(req.id, result: caps, error: nil)

    case "list-apps":
        let apps = listApps()
        writeResponse(req.id, result: ["apps": apps.map { ["bundleId": $0.bundleId as Any, "name": $0.name, "pid": $0.pid, "isFrontmost": $0.isFrontmost] }], error: nil)

    case "list-windows":
        // P0.1 stub: return empty until AX window enumeration lands.
        writeResponse(req.id, result: ["windows": []], error: nil)

    case "get-app-state":
        // Hard-block check before any AX walk.
        let bundle = req.params?["app"]?.value as? String
        if isHardBlocked(bundleId: bundle) {
            writeResponse(req.id, result: nil, error: ("app_hard_blocked", "Target bundle is Tier 1 hard-blocked: \(bundle ?? "?")"))
            return
        }
        // P0.1 stub: tree only, no screenshot, no elements yet.
        writeResponse(req.id, result: [
            "tree": "",
            "elementCount": 0,
            "scale": 2,
            "tree_truncated": false,
        ] as [String: Any], error: nil)

    case "click", "type-text", "press-key", "scroll":
        // P0.1 stub: refuse until AX action impl lands (P0.1b).
        writeResponse(req.id, result: nil, error: ("not_implemented", "\(req.method) lands in P0.1b — helper skeleton only"))

    case "hotkey":
        // M4 mandatory denylist (Kratos arch §7.1).
        let chord = (req.params?["key"]?.value as? String ?? "").lowercased()
        if HOTKEY_DENYLIST.contains(chord) {
            writeResponse(req.id, result: nil, error: ("scope_denied", "Hotkey chord '\(chord)' is M4-denylisted (quit/close/force-quit)"))
            return
        }
        writeResponse(req.id, result: nil, error: ("not_implemented", "hotkey impl lands in P0.1b"))

    case "permissions":
        let trusted = AXIsProcessTrusted()
        writeResponse(req.id, result: [
            "accessibility": trusted ? "granted" : "missing",
            "screenshots": "unknown",  // CGPreflightScreenCaptureAccess requires macOS 15+; defer
        ] as [String: Any], error: nil)

    default:
        writeResponse(req.id, result: nil, error: ("unknown_method", "Unknown method: \(req.method)"))
    }
}

// MARK: - Stdio loop

func readLoop() {
    let stdin = FileHandle.standardInput
    var buffer = Data()
    while true {
        let chunk = stdin.availableData
        if chunk.isEmpty { break }  // EOF
        buffer.append(chunk)
        while let nlIdx = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.prefix(Int(nlIdx))
            buffer = Data(buffer.dropFirst(Int(nlIdx) + 1))
            guard !lineData.isEmpty,
                  let req = try? JSONDecoder().decode(Request.self, from: lineData)
            else {
                // Skip malformed line; do not crash the helper.
                continue
            }
            handle(req)
        }
    }
}

readLoop()
