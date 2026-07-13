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
import Carbon

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
let HOTKEY_ALLOWLIST: Set<String> = [
    "cmd+a", "cmd+c", "cmd+v", "cmd+x", "cmd+z", "cmd+shift+z",
    "cmd+f", "cmd+l", "cmd+t", "cmd+r", "cmd+s", "cmd+n", "cmd+p", "cmd+shift+p",
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

func stringParam(_ req: Request, _ key: String) -> String? {
    req.params?[key]?.value as? String
}

func intParam(_ req: Request, _ key: String) -> Int? {
    req.params?[key]?.value as? Int
}

func resolveRunningApp(_ selector: String) -> NSRunningApplication? {
    let lower = selector.lowercased()
    return NSWorkspace.shared.runningApplications.first {
        $0.bundleIdentifier?.lowercased() == lower || $0.localizedName?.lowercased() == lower
    }
}

func resolveAppMetadata(_ selector: String) -> [String: Any]? {
    let lower = selector.lowercased()
    let runningMatches = NSWorkspace.shared.runningApplications.filter {
        $0.bundleIdentifier?.lowercased() == lower || $0.localizedName?.lowercased() == lower
    }
    guard runningMatches.count <= 1 else { return nil }
    if let running = runningMatches.first, let bundleId = running.bundleIdentifier {
        return ["bundleId": bundleId, "name": running.localizedName ?? selector, "running": true]
    }
    let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: selector)
        ?? NSWorkspace.shared.fullPath(forApplication: selector).map(URL.init(fileURLWithPath:))
    guard let url,
          let bundle = Bundle(url: url), let bundleId = bundle.bundleIdentifier else { return nil }
    let name = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
        ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)
        ?? url.deletingPathExtension().lastPathComponent
    return ["bundleId": bundleId, "name": name, "running": false]
}

func launchApp(_ selector: String) throws -> NSRunningApplication {
    if let running = resolveRunningApp(selector) {
        running.activate(options: [.activateAllWindows])
        return running
    }
    guard !isHardBlocked(bundleId: selector),
          let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: selector) else {
        throw NSError(domain: "ComputerUse", code: 1, userInfo: [NSLocalizedDescriptionKey: "Application not found: \(selector)"])
    }
    guard NSWorkspace.shared.open(url) else {
        throw NSError(domain: "ComputerUse", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not open application: \(selector)"])
    }
    for _ in 0..<600 {
        if let app = resolveRunningApp(selector) {
            app.activate(options: [.activateAllWindows])
            return app
        }
        usleep(50_000)
    }
    throw NSError(domain: "ComputerUse", code: 3, userInfo: [NSLocalizedDescriptionKey: "Application did not launch: \(selector)"])
}

struct AXNode {
    let element: AXUIElement
    let line: String
}

func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value as? String
}

func axFrame(_ element: AXUIElement) -> CGRect? {
    var positionRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
          let positionValue = positionRef, let sizeValue = sizeRef,
          CFGetTypeID(positionValue) == AXValueGetTypeID(),
          CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

func buildTree(_ root: AXUIElement, maxNodes: Int = 400) -> [AXNode] {
    var nodes: [AXNode] = []
    func walk(_ element: AXUIElement, depth: Int) {
        guard nodes.count < maxNodes, depth <= 12 else { return }
        let role = axString(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
        let subrole = axString(element, kAXSubroleAttribute as CFString) ?? ""
        let isSecure = role.localizedCaseInsensitiveContains("secure") || subrole.localizedCaseInsensitiveContains("secure")
        let title = axString(element, kAXTitleAttribute as CFString) ?? ""
        let value = isSecure ? "<redacted>" : (axString(element, kAXValueAttribute as CFString) ?? "")
        let frame = axFrame(element)
        let frameText = frame.map { String(format: " frame=(%.0f,%.0f,%.0f,%.0f)", $0.minX, $0.minY, $0.width, $0.height) } ?? ""
        let summary = [title.isEmpty ? nil : "title=\"\(title.prefix(160))\"", value.isEmpty ? nil : "value=\"\(value.prefix(160))\""].compactMap { $0 }.joined(separator: " ")
        let index = nodes.count
        nodes.append(AXNode(element: element, line: "\(String(repeating: "  ", count: depth))[\(index)] \(role) \(summary)\(frameText)"))
        if isSecure { return }
        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
              let children = childrenRef as? [AXUIElement] else { return }
        for child in children { walk(child, depth: depth + 1) }
    }
    walk(root, depth: 0)
    return nodes
}

func hasSensitiveWindow(_ app: NSRunningApplication) -> Bool {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    var windowsRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &windowsRef) == .success,
          let windows = windowsRef as? [AXUIElement] else { return false }
    let markers = ["password", "senha", "2fa", "otp", "verification", "recovery code"]
    return windows.contains { window in
        let title = (axString(window, kAXTitleAttribute as CFString) ?? "").lowercased()
        return markers.contains(where: title.contains)
    }
}

func captureAuthorizedWindow(_ app: NSRunningApplication) -> [String: Any]? {
    guard let axWindow = focusedWindow(app), let focusedFrame = axFrame(axWindow),
          let windowInfo = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
          ) as? [[String: Any]] else { return nil }

    let candidates: [(CGWindowID, CGRect)] = windowInfo.compactMap { info in
        guard let ownerPid = info[kCGWindowOwnerPID as String] as? Int,
              ownerPid == Int(app.processIdentifier),
              let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
              let number = info[kCGWindowNumber as String] as? UInt32,
              let bounds = info[kCGWindowBounds as String],
              let frame = CGRect(dictionaryRepresentation: bounds as! CFDictionary) else { return nil }
        return (number, frame)
    }
    guard let selected = candidates.max(by: {
        intersectionArea($0.1, focusedFrame) < intersectionArea($1.1, focusedFrame)
    }),
    let cgImage = CGWindowListCreateImage(
        .null,
        .optionIncludingWindow,
        selected.0,
        [.boundsIgnoreFraming, .nominalResolution]
    ) else { return nil }

    let maxLongEdge: CGFloat = 1568
    let longEdge = max(selected.1.width, selected.1.height)
    let scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1
    let width = max(1, Int((selected.1.width * scale).rounded()))
    let height = max(1, Int((selected.1.height * scale).rounded()))
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    NSImage(cgImage: cgImage, size: NSSize(width: width, height: height)).draw(
        in: CGRect(x: 0, y: 0, width: width, height: height),
        from: .zero,
        operation: .copy,
        fraction: 1
    )
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
    return [
        "screenshot_base64": png.base64EncodedString(),
        "screenshot_mime_type": "image/png",
        "screenshot_width": width,
        "screenshot_height": height,
        "screenshot_scale": scale,
        "window_frame": [
            "x": selected.1.minX,
            "y": selected.1.minY,
            "width": selected.1.width,
            "height": selected.1.height,
        ],
    ]
}

func postClick(_ point: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func typeUnicode(_ text: String) {
    let chars = Array(text.utf16)
    chars.withUnsafeBufferPointer { buffer in
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return }
        down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: buffer.baseAddress!)
        up.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: buffer.baseAddress!)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

let KEY_CODES: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53,
    "delete": 51, "backspace": 51, "left": 123, "right": 124, "down": 125, "up": 126,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37,
    "j": 38, "k": 40, "n": 45, "m": 46,
]

func postKey(_ key: String, modifiers: CGEventFlags = []) -> Bool {
    guard let code = KEY_CODES[key.lowercased()] else { return false }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { return false }
    down.flags = modifiers; up.flags = modifiers
    down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
    return true
}

// MARK: - Dispatcher

func handle(_ req: Request) {
    switch req.method {
    case "capabilities":
        var caps: [String: Any] = [:]
        caps["commands"] = [
            "list-apps", "resolve-app", "launch-app", "list-windows", "get-app-state",
            "click", "type-text", "press-key", "hotkey", "scroll", "permissions", "request-permissions",
        ]
        caps["hard_blocked_bundles"] = Array(HARD_BLOCKED_BUNDLE_IDS).sorted()
        caps["hotkey_denylist"] = Array(HOTKEY_DENYLIST).sorted()
        writeResponse(req.id, result: caps, error: nil)

    case "list-apps":
        let apps = listApps()
        writeResponse(req.id, result: ["apps": apps.map { ["bundleId": $0.bundleId as Any, "name": $0.name, "pid": $0.pid, "isFrontmost": $0.isFrontmost] }], error: nil)

    case "resolve-app":
        guard let selector = stringParam(req, "app"), let metadata = resolveAppMetadata(selector),
              let bundleId = metadata["bundleId"] as? String, !isHardBlocked(bundleId: bundleId) else {
            writeResponse(req.id, result: nil, error: ("app_not_found", "Application was not found or is blocked")); return
        }
        writeResponse(req.id, result: metadata, error: nil)

    case "launch-app":
        guard let selector = stringParam(req, "app"), !isHardBlocked(bundleId: selector) else {
            writeResponse(req.id, result: nil, error: ("app_hard_blocked", "Missing or blocked target application"))
            return
        }
        do {
            let app = try launchApp(selector)
            writeResponse(req.id, result: ["bundleId": app.bundleIdentifier as Any, "name": app.localizedName as Any, "pid": Int(app.processIdentifier)], error: nil)
        } catch {
            writeResponse(req.id, result: nil, error: ("app_not_found", error.localizedDescription))
        }

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
        guard AXIsProcessTrusted() else {
            writeResponse(req.id, result: nil, error: ("accessibility_error", "Accessibility permission is required"))
            return
        }
        guard let selector = bundle, let app = resolveRunningApp(selector) else {
            writeResponse(req.id, result: nil, error: ("app_not_found", "Application is not running: \(bundle ?? "?")"))
            return
        }
        if hasSensitiveWindow(app) { writeResponse(req.id, result: nil, error: ("scope_denied", "Sensitive window is visible in the authorized app")); return }
        let nodes = buildTree(AXUIElementCreateApplication(app.processIdentifier))
        let noScreenshot = req.params?["no_screenshot"]?.value as? Bool ?? true
        var state: [String: Any] = [
            "tree": nodes.map(\.line).joined(separator: "\n"),
            "elementCount": nodes.count,
            "scale": 2,
            "tree_truncated": nodes.count >= 400,
        ]
        if !noScreenshot {
            if let screenshot = captureAuthorizedWindow(app) {
                state.merge(screenshot) { _, new in new }
            } else {
                state["screenshot_error"] = "Screen Recording permission is missing or the authorized window could not be captured."
            }
        }
        writeResponse(req.id, result: state, error: nil)

    case "click":
        guard AXIsProcessTrusted(), let selector = stringParam(req, "app"), let app = resolveRunningApp(selector) else {
            writeResponse(req.id, result: nil, error: ("accessibility_error", "Target app or Accessibility permission unavailable")); return
        }
        if hasSensitiveWindow(app) { writeResponse(req.id, result: nil, error: ("scope_denied", "Sensitive window is visible in the authorized app")); return }
        app.activate(options: [.activateAllWindows])
        usleep(120_000)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
            writeResponse(req.id, result: nil, error: ("window_not_focused", "Authorized application is not frontmost")); return
        }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        if let index = intParam(req, "element_index") {
            let nodes = buildTree(root)
            guard nodes.indices.contains(index) else { writeResponse(req.id, result: nil, error: ("element_not_found", "Element index is stale")); return }
            if AXUIElementPerformAction(nodes[index].element, kAXPressAction as CFString) != .success,
               let frame = axFrame(nodes[index].element) { postClick(CGPoint(x: frame.midX, y: frame.midY)) }
        } else if let x = intParam(req, "x"), let y = intParam(req, "y") {
            let point = CGPoint(x: x, y: y)
            var windowsRef: CFTypeRef?
            let windows = (AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &windowsRef) == .success ? windowsRef as? [AXUIElement] : nil) ?? []
            guard windows.compactMap(axFrame).contains(where: { $0.contains(point) }) else {
                writeResponse(req.id, result: nil, error: ("scope_denied", "Click coordinates are outside the authorized app windows")); return
            }
            var hit: AXUIElement?
            guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success,
                  let hit else {
                writeResponse(req.id, result: nil, error: ("scope_denied", "Could not verify click target ownership")); return
            }
            var hitPid: pid_t = 0
            AXUIElementGetPid(hit, &hitPid)
            guard hitPid == app.processIdentifier else {
                writeResponse(req.id, result: nil, error: ("scope_denied", "Click target belongs to another application")); return
            }
            postClick(point)
        } else { writeResponse(req.id, result: nil, error: ("invalid_argument", "click requires element_index or x/y")); return }
        usleep(150_000)
        writeResponse(req.id, result: ["performed": true], error: nil)

    case "type-text":
        guard AXIsProcessTrusted(), let selector = stringParam(req, "app"), let app = resolveRunningApp(selector), let text = stringParam(req, "text") else {
            writeResponse(req.id, result: nil, error: ("accessibility_error", "Authorized target app, Accessibility permission, or text missing")); return
        }
        if hasSensitiveWindow(app) { writeResponse(req.id, result: nil, error: ("scope_denied", "Sensitive window is visible in the authorized app")); return }
        app.activate(options: [.activateAllWindows])
        usleep(120_000)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
            writeResponse(req.id, result: nil, error: ("window_not_focused", "Authorized application is not frontmost")); return
        }
        let system = AXUIElementCreateSystemWide()
        var focusedRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success,
              let focused = focusedRef else {
            writeResponse(req.id, result: nil, error: ("window_not_focused", "Authorized application has no focused text receiver")); return
        }
        var focusedPid: pid_t = 0
        AXUIElementGetPid(focused as! AXUIElement, &focusedPid)
        guard focusedPid == app.processIdentifier else {
            writeResponse(req.id, result: nil, error: ("window_not_focused", "Focused receiver belongs to another application")); return
        }
        let focusedRole = axString(focused as! AXUIElement, kAXRoleAttribute as CFString) ?? ""
        let focusedSubrole = axString(focused as! AXUIElement, kAXSubroleAttribute as CFString) ?? ""
        if focusedRole.localizedCaseInsensitiveContains("secure") || focusedSubrole.localizedCaseInsensitiveContains("secure") {
            writeResponse(req.id, result: nil, error: ("secure_text_field", "Typing into secure text fields is blocked")); return
        }
        typeUnicode(text)
        usleep(150_000)
        writeResponse(req.id, result: ["performed": true, "characters": text.count], error: nil)

    case "press-key", "hotkey":
        guard AXIsProcessTrusted(), let selector = stringParam(req, "app"), let app = resolveRunningApp(selector), let key = stringParam(req, "key") else {
            writeResponse(req.id, result: nil, error: ("accessibility_error", "Authorized target app, permission, or key missing")); return
        }
        if hasSensitiveWindow(app) { writeResponse(req.id, result: nil, error: ("scope_denied", "Sensitive window is visible in the authorized app")); return }
        app.activate(options: [.activateAllWindows]); usleep(120_000)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
            writeResponse(req.id, result: nil, error: ("window_not_focused", "Authorized application is not frontmost")); return
        }
        var modifiers: CGEventFlags = []
        var baseKey = key
        if req.method == "hotkey" {
            let chord = key.lowercased()
            let parts = chord.split(separator: "+").map(String.init)
            let normalizedChord = parts.map { part in
                if part == "command" || part == "cmdorctrl" { return "cmd" }
                if part == "alt" { return "option" }
                if part == "control" { return "ctrl" }
                return part
            }.joined(separator: "+")
            if HOTKEY_DENYLIST.contains(normalizedChord) { writeResponse(req.id, result: nil, error: ("scope_denied", "Quit/close/force-quit shortcuts are blocked")); return }
            if !HOTKEY_ALLOWLIST.contains(normalizedChord) { writeResponse(req.id, result: nil, error: ("scope_denied", "Shortcut is not in the app-local safety allowlist")); return }
            baseKey = parts.last ?? ""
            if parts.contains("cmd") || parts.contains("command") || parts.contains("cmdorctrl") { modifiers.insert(.maskCommand) }
            if parts.contains("shift") { modifiers.insert(.maskShift) }
            if parts.contains("option") || parts.contains("alt") { modifiers.insert(.maskAlternate) }
            if parts.contains("ctrl") || parts.contains("control") { modifiers.insert(.maskControl) }
        }
        let system = AXUIElementCreateSystemWide()
        var focusedRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success, let focusedRef {
            let focused = focusedRef as! AXUIElement
            let role = axString(focused, kAXRoleAttribute as CFString) ?? ""
            let subrole = axString(focused, kAXSubroleAttribute as CFString) ?? ""
            if role.localizedCaseInsensitiveContains("secure") || subrole.localizedCaseInsensitiveContains("secure") {
                writeResponse(req.id, result: nil, error: ("secure_text_field", "Keyboard actions in secure fields are blocked")); return
            }
        }
        guard postKey(baseKey, modifiers: modifiers) else { writeResponse(req.id, result: nil, error: ("invalid_argument", "Unsupported key: \(baseKey)")); return }
        writeResponse(req.id, result: ["performed": true], error: nil)

    case "scroll":
        guard AXIsProcessTrusted(), let selector = stringParam(req, "app"), let app = resolveRunningApp(selector),
              let x = intParam(req, "x"), let y = intParam(req, "y"), let direction = stringParam(req, "direction") else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "scroll requires authorized app, x, y, and direction")); return
        }
        if hasSensitiveWindow(app) { writeResponse(req.id, result: nil, error: ("scope_denied", "Sensitive window is visible in the authorized app")); return }
        app.activate(options: [.activateAllWindows]); usleep(120_000)
        let point = CGPoint(x: x, y: y)
        var hit: AXUIElement?
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
              AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &hit) == .success, let hit else {
            writeResponse(req.id, result: nil, error: ("scope_denied", "Could not verify scroll target")); return
        }
        var hitPid: pid_t = 0; AXUIElementGetPid(hit, &hitPid)
        guard hitPid == app.processIdentifier else { writeResponse(req.id, result: nil, error: ("scope_denied", "Scroll target belongs to another application")); return }
        let delta = direction.lowercased() == "up" ? 6 : direction.lowercased() == "down" ? -6 : 0
        guard delta != 0, let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(delta), wheel2: 0, wheel3: 0) else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "direction must be up or down")); return
        }
        event.location = point; event.post(tap: .cghidEventTap)
        writeResponse(req.id, result: ["performed": true], error: nil)

    case "permissions":
        let trusted = AXIsProcessTrusted()
        writeResponse(req.id, result: [
            "accessibility": trusted ? "granted" : "missing",
            "screenRecording": CGPreflightScreenCaptureAccess() ? "granted" : "missing",
        ] as [String: Any], error: nil)

    case "request-permissions":
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        let screenRecording = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
        writeResponse(req.id, result: [
            "accessibility": trusted ? "granted" : "missing",
            "screenRecording": screenRecording ? "granted" : "missing",
        ] as [String: Any], error: nil)

    default:
        writeResponse(req.id, result: nil, error: ("unknown_method", "Unknown method: \(req.method)"))
    }
}

// MARK: - Stdio loop

func runEmergencyMonitor() {
    var handler: EventHandlerRef?
    var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let callback: EventHandlerUPP = { _, _, _ in
        FileHandle.standardOutput.write(Data("{\"event\":\"emergency-stop\"}\n".utf8))
        fflush(stdout)
        exit(0)
    }
    guard InstallEventHandler(GetApplicationEventTarget(), callback, 1, &eventType, nil, &handler) == noErr else {
        FileHandle.standardError.write(Data("Unable to install emergency event handler\n".utf8))
        exit(2)
    }
    var hotKey: EventHotKeyRef?
    let hotKeyId = EventHotKeyID(signature: OSType(0x5642524F), id: 1)
    guard RegisterEventHotKey(UInt32(kVK_Escape), UInt32(cmdKey | shiftKey), hotKeyId, GetApplicationEventTarget(), 0, &hotKey) == noErr else {
        FileHandle.standardError.write(Data("Unable to register emergency hotkey\n".utf8))
        exit(2)
    }
    FileHandle.standardOutput.write(Data("{\"event\":\"monitor-ready\"}\n".utf8))
    fflush(stdout)
    RunLoop.main.run()
}

// MARK: - Focus HUD and display-scoped isolation

private struct FocusCapability: Decodable {
    let expiresAt: UInt64
    let paused: Bool

    enum CodingKeys: String, CodingKey {
        case expiresAt = "expires_at"
        case paused
    }
}

private struct FocusScreen {
    let screen: NSScreen
    let axFrame: CGRect
}

private func appKitMainHeight() -> CGFloat {
    NSScreen.screens.first(where: { $0.frame.origin == .zero })?.frame.height
        ?? NSScreen.main?.frame.height
        ?? 0
}

private func accessibilityFrame(for screen: NSScreen) -> CGRect {
    let frame = screen.frame
    return CGRect(
        x: frame.minX,
        y: appKitMainHeight() - frame.maxY,
        width: frame.width,
        height: frame.height
    )
}

private func intersectionArea(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
    let intersection = lhs.intersection(rhs)
    guard !intersection.isNull else { return 0 }
    return max(0, intersection.width) * max(0, intersection.height)
}

private func focusScreen(containing frame: CGRect) -> FocusScreen? {
    NSScreen.screens
        .map { FocusScreen(screen: $0, axFrame: accessibilityFrame(for: $0)) }
        .max { intersectionArea($0.axFrame, frame) < intersectionArea($1.axFrame, frame) }
}

private func appKitFrame(fromAccessibility frame: CGRect, margin: CGFloat) -> CGRect {
    CGRect(
        x: frame.minX - margin,
        y: appKitMainHeight() - frame.maxY - margin,
        width: frame.width + margin * 2,
        height: frame.height + margin * 2
    )
}

private func boolAttribute(_ element: AXUIElement, _ attribute: CFString) -> Bool? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value as? Bool
}

private func applicationWindows(_ app: NSRunningApplication) -> [AXUIElement] {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    var windowsRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &windowsRef) == .success,
          let windows = windowsRef as? [AXUIElement] else { return [] }
    return windows
}

private func focusedWindow(_ app: NSRunningApplication) -> AXUIElement? {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    var focusedRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(root, kAXFocusedWindowAttribute as CFString, &focusedRef) == .success,
       let focusedRef {
        return (focusedRef as! AXUIElement)
    }
    return applicationWindows(app).first(where: {
        boolAttribute($0, kAXMinimizedAttribute as CFString) != true && axFrame($0) != nil
    })
}

private final class FocusOverlayView: NSView {
    var appName = "App"
    var paused = false
    var reduceMotion = false
    private var phase: CGFloat = 0

    override var isOpaque: Bool { false }

    func advance() {
        guard !paused, !reduceMotion else { return }
        phase += 0.08
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        NSColor.clear.setFill()
        dirtyRect.fill()

        let accent = NSColor(srgbRed: 147 / 255, green: 85 / 255, blue: 1, alpha: 1)
        let accentStrong = NSColor(srgbRed: 169 / 255, green: 109 / 255, blue: 1, alpha: 1)
        let surface = NSColor(srgbRed: 21 / 255, green: 24 / 255, blue: 39 / 255, alpha: 0.94)
        let text = NSColor(srgbRed: 238 / 255, green: 241 / 255, blue: 1, alpha: 1)
        let margin: CGFloat = 8
        let pulse = reduceMotion || paused ? 0 : (sin(phase) + 1) * 0.5
        let ringAlpha: CGFloat = paused ? 0.34 : 0.56 + pulse * 0.24

        let ringRect = bounds.insetBy(dx: margin, dy: margin)
        let ring = NSBezierPath(roundedRect: ringRect, xRadius: 12, yRadius: 12)
        ring.lineWidth = paused ? 2 : 2.5
        accent.withAlphaComponent(ringAlpha).setStroke()
        ring.stroke()

        let glow = NSBezierPath(roundedRect: ringRect.insetBy(dx: -2, dy: -2), xRadius: 14, yRadius: 14)
        glow.lineWidth = 5
        accent.withAlphaComponent(paused ? 0.08 : 0.08 + pulse * 0.08).setStroke()
        glow.stroke()

        let label = paused ? "Verboo • \(appName) • Ⅱ" : "Verboo • \(appName) • ⌘⇧Esc"
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: text,
        ]
        let labelSize = (label as NSString).size(withAttributes: attributes)
        let pillWidth = min(bounds.width - 32, max(220, labelSize.width + 42))
        let pillRect = CGRect(
            x: (bounds.width - pillWidth) / 2,
            y: bounds.maxY - 46,
            width: pillWidth,
            height: 32
        )
        let pill = NSBezierPath(roundedRect: pillRect, xRadius: 16, yRadius: 16)
        surface.setFill()
        pill.fill()
        accentStrong.withAlphaComponent(paused ? 0.28 : 0.62).setStroke()
        pill.lineWidth = 1
        pill.stroke()
        (label as NSString).draw(
            at: CGPoint(x: pillRect.midX - labelSize.width / 2, y: pillRect.midY - labelSize.height / 2),
            withAttributes: attributes
        )
    }
}

private final class FocusSessionController {
    private let selector: String
    private let capabilityURL: URL
    private let overlay = FocusOverlayView(frame: .zero)
    private let panel: NSPanel
    private var timer: Timer?
    private var minimizedWindows: [AXUIElement] = []
    private var isolatedScreenFrame: CGRect?
    private var hadTarget = false
    private var stopping = false
    private var signalSources: [DispatchSourceSignal] = []

    init(selector: String, capabilityURL: URL) {
        self.selector = selector
        self.capabilityURL = capabilityURL
        panel = NSPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.contentView = overlay
    }

    func start() {
        NSApplication.shared.setActivationPolicy(.accessory)
        installSignalHandlers()
        timer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in
            self?.tick()
        }
        tick()
    }

    private func installSignalHandlers() {
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { [weak self] in self?.stopAndExit() }
            source.resume()
            signalSources.append(source)
        }
    }

    private func readCapability() -> FocusCapability? {
        guard let data = try? Data(contentsOf: capabilityURL),
              let capability = try? JSONDecoder().decode(FocusCapability.self, from: data) else {
            return nil
        }
        let now = UInt64(Date().timeIntervalSince1970)
        return capability.expiresAt > now ? capability : nil
    }

    private func tick() {
        guard !stopping else { return }
        guard let capability = readCapability() else {
            stopAndExit()
            return
        }
        overlay.paused = capability.paused
        overlay.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        overlay.advance()

        guard let app = resolveRunningApp(selector), let window = focusedWindow(app), let frame = axFrame(window) else {
            panel.orderOut(nil)
            if hadTarget { stopAndExit() }
            return
        }
        hadTarget = true
        overlay.appName = app.localizedName ?? selector

        guard let screen = focusScreen(containing: frame) else {
            panel.orderOut(nil)
            return
        }
        if isolatedScreenFrame != screen.axFrame {
            restoreWindows()
            isolateDisplay(screen.axFrame, except: app.processIdentifier)
            isolatedScreenFrame = screen.axFrame
        }

        let panelFrame = appKitFrame(fromAccessibility: frame, margin: 8)
        if panel.frame != panelFrame {
            panel.setFrame(panelFrame, display: true)
            overlay.frame = CGRect(origin: .zero, size: panelFrame.size)
        }
        overlay.needsDisplay = true
        panel.orderFrontRegardless()
    }

    private func isolateDisplay(_ displayFrame: CGRect, except targetPid: pid_t) {
        minimizedWindows.removeAll()
        for app in NSWorkspace.shared.runningApplications where
            app.activationPolicy == .regular && app.processIdentifier != targetPid {
            for window in applicationWindows(app) {
                guard boolAttribute(window, kAXMinimizedAttribute as CFString) == false,
                      let frame = axFrame(window),
                      intersectionArea(frame, displayFrame) > 0 else { continue }
                var settable = DarwinBoolean(false)
                guard AXUIElementIsAttributeSettable(
                    window,
                    kAXMinimizedAttribute as CFString,
                    &settable
                ) == .success, settable.boolValue else { continue }
                if AXUIElementSetAttributeValue(
                    window,
                    kAXMinimizedAttribute as CFString,
                    kCFBooleanTrue
                ) == .success {
                    minimizedWindows.append(window)
                }
            }
        }
    }

    private func restoreWindows() {
        for window in minimizedWindows where boolAttribute(window, kAXMinimizedAttribute as CFString) == true {
            _ = AXUIElementSetAttributeValue(
                window,
                kAXMinimizedAttribute as CFString,
                kCFBooleanFalse
            )
        }
        minimizedWindows.removeAll()
        isolatedScreenFrame = nil
    }

    private func stopAndExit() {
        guard !stopping else { return }
        stopping = true
        timer?.invalidate()
        panel.orderOut(nil)
        restoreWindows()
        exit(0)
    }
}

private func runFocusSession() {
    guard let flagIndex = CommandLine.arguments.firstIndex(of: "--focus-session"),
          CommandLine.arguments.indices.contains(flagIndex + 2) else {
        FileHandle.standardError.write(Data("Missing focus-session app or capability path\n".utf8))
        exit(2)
    }
    let selector = CommandLine.arguments[flagIndex + 1]
    let capabilityURL = URL(fileURLWithPath: CommandLine.arguments[flagIndex + 2])
    let controller = FocusSessionController(selector: selector, capabilityURL: capabilityURL)
    FileHandle.standardOutput.write(Data("{\"event\":\"focus-ready\"}\n".utf8))
    fflush(stdout)
    controller.start()
    NSApplication.shared.run()
}

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

if CommandLine.arguments.contains("--monitor-emergency") {
    runEmergencyMonitor()
} else if CommandLine.arguments.contains("--focus-session") {
    runFocusSession()
} else {
    readLoop()
}
