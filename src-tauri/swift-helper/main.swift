// Computer Use Helper — Swift sidecar for Verboo Code Desktop.
//
// Launched by Rust `ComputerUseService` via `computer_use_spawn.rs`. The
// action process runs inside the LSUIElement `Verboo Computer Use.app` so
// macOS assigns it a stable, visible TCC identity without adding a Dock icon.
// LaunchServices connects it to the controller over a private Unix socket;
// contract tests and narrow recovery modes may still use stdio directly.
//
// P0 scope (Kratos arch §7.1, D6):
//   Read:  list-apps, list-windows, get-app-state (tree; screenshot opt-in)
//   Mutate: click, type-text, press-key, hotkey (M4 denylist), scroll
//
// Hard blocks (helper-enforced):
//   - com.apple.loginwindow (never control)
//   - AXSecureTextField (never read/write/screenshot)
//   - Window titles matching password|senha|2FA|OTP|verification|recovery code
//   - Self-test blocked surfaces (Kratos §4.2.2): LoginScreen, credentials,
//     full-access toggle, CU disable toggle, audit viewer, allowlist editor.
//
// Hotkey denylist (M4 mandatory): Cmd+Q, Cmd+W, Cmd+Option+Esc → scope_denied.
//
// Emergency stop: plain Esc via Carbon global hotkey, OS-wide while active.

import Foundation
import ApplicationServices
import AppKit
import Carbon
import CoreImage
import CoreMedia
import CoreVideo
import Darwin
import ScreenCaptureKit

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
        else if let double = try? container.decode(Double.self) { value = double }
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
    "com.apple.loginwindow",
    "com.apple.keychainaccess",
    "com.agilebits.onepassword-osx",
    "com.agilebits.onepassword8",
    "com.bitwarden.desktop",
    "com.lastpass.lastpassmacdesktop",
    "com.dashlane.dashlanephonefinal",
    "org.keepassxc.keepassxc",
    "com.ledger.live",
    "com.exodus.desktop",
    "org.electrum.electrum",
    "io.trezor.suite",
]
let HARD_BLOCKED_BUNDLE_MARKERS = [
    "1password", "bitwarden", "credential", "dashlane", "keychain", "keepass",
    "lastpass", "password", "protonpass", "authenticator", "bank", "banking",
    "coinbase", "binance", "cryptocurrency", "electrum", "exodus", "kraken",
    "ledger", "metamask", "phantom.wallet", "trezor", "wallet", "health",
    "healthrecord", "medicalrecord", "patientportal",
]

let HOTKEY_DENYLIST: Set<String> = [
    "cmd+q", "cmd+w", "cmd+option+esc", "cmd+alt+esc", "ctrl+q", "ctrl+w",
]
let HOTKEY_ALLOWLIST: Set<String> = [
    "cmd+a", "cmd+c", "cmd+v", "cmd+x", "cmd+z", "cmd+shift+z",
    "cmd+f", "cmd+l", "cmd+t", "cmd+r", "cmd+s", "cmd+n", "cmd+p", "cmd+shift+p",
]

func isHardBlocked(bundleId: String?, name: String? = nil) -> Bool {
    let id = bundleId?.lowercased() ?? ""
    let identity = "\(id) \(name?.lowercased() ?? "")"
    return HARD_BLOCKED_BUNDLE_IDS.contains(id)
        || HARD_BLOCKED_BUNDLE_MARKERS.contains(where: identity.contains)
}

func isHardBlocked(_ app: NSRunningApplication) -> Bool {
    isHardBlocked(bundleId: app.bundleIdentifier, name: app.localizedName)
}

// MARK: - list-apps

struct AppInfo: Encodable {
    let bundleId: String?
    let name: String
    let iconBase64: String?
    let pid: Int
    let isFrontmost: Bool
    let visibleWindowCount: Int
}

func visibleWindowCount(for pid: pid_t) -> Int {
    guard let windows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else { return 0 }
    return windows.reduce(into: 0) { count, info in
        guard let ownerPid = info[kCGWindowOwnerPID as String] as? Int,
              ownerPid == Int(pid),
              let layer = info[kCGWindowLayer as String] as? Int,
              layer == 0,
              let bounds = info[kCGWindowBounds as String],
              let frame = CGRect(dictionaryRepresentation: bounds as! CFDictionary),
              isEligibleCaptureFrame(frame) else { return }
        count += 1
    }
}

func appIconBase64(bundleURL: URL?) -> String? {
    guard let bundleURL else { return nil }
    let pixels = 32
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixels,
        pixelsHigh: pixels,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
    let icon = NSWorkspace.shared.icon(forFile: bundleURL.path)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    icon.draw(
        in: NSRect(x: 0, y: 0, width: pixels, height: pixels),
        from: .zero,
        operation: .copy,
        fraction: 1
    )
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]), png.count <= 64 * 1024 else {
        return nil
    }
    return png.base64EncodedString()
}

func listApps() -> [AppInfo] {
    let workspace = NSWorkspace.shared
    let frontmostId = workspace.frontmostApplication?.bundleIdentifier
    return workspace.runningApplications.compactMap { app in
        // Skip helper-like processes and immutable hard-block categories before
        // their names or icons can reach either app picker.
        guard app.activationPolicy == .regular, !isHardBlocked(app) else { return nil }
        return AppInfo(
            bundleId: app.bundleIdentifier,
            name: app.localizedName ?? "<unknown>",
            iconBase64: appIconBase64(bundleURL: app.bundleURL),
            pid: Int(app.processIdentifier),
            isFrontmost: app.bundleIdentifier == frontmostId,
            visibleWindowCount: visibleWindowCount(for: app.processIdentifier)
        )
    }
}

func stringParam(_ req: Request, _ key: String) -> String? {
    req.params?[key]?.value as? String
}

func intParam(_ req: Request, _ key: String) -> Int? {
    req.params?[key]?.value as? Int
}

func doubleParam(_ req: Request, _ key: String) -> Double? {
    if let value = req.params?[key]?.value as? Double { return value }
    if let value = req.params?[key]?.value as? Int { return Double(value) }
    return nil
}

func boolParam(_ req: Request, _ key: String) -> Bool? {
    req.params?[key]?.value as? Bool
}

func dictionaryParam(_ req: Request, _ key: String) -> [String: Any]? {
    req.params?[key]?.value as? [String: Any]
}

func rectParam(_ req: Request, _ key: String) -> CGRect? {
    guard let raw = dictionaryParam(req, key) else { return nil }
    func number(_ name: String) -> Double? {
        if let value = raw[name] as? Double { return value }
        if let value = raw[name] as? Int { return Double(value) }
        return nil
    }
    guard let x = number("x"), let y = number("y"),
          let width = number("width"), let height = number("height"),
          x.isFinite, y.isFinite, width.isFinite, height.isFinite,
          width > 0, height > 0 else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
}

func intArrayParam(_ req: Request, _ key: String, count: Int) -> [Int]? {
    guard let values = req.params?[key]?.value as? [Any], values.count == count else { return nil }
    let integers = values.compactMap { $0 as? Int }
    return integers.count == count ? integers : nil
}

private func rectArray(_ value: Any?) -> CGRect? {
    guard let values = value as? [Any], values.count == 4 else { return nil }
    let numbers = values.compactMap { value -> Double? in
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        return nil
    }
    guard numbers.count == 4, numbers.allSatisfy(\.isFinite),
          numbers[2] > 0, numbers[3] > 0 else { return nil }
    return CGRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3])
}

private func dictionaryRect(_ value: Any?) -> CGRect? {
    guard let dictionary = value as? [String: Any] else { return nil }
    func number(_ key: String) -> Double? {
        if let value = dictionary[key] as? Double { return value }
        if let value = dictionary[key] as? Int { return Double(value) }
        return nil
    }
    guard let x = number("x"), let y = number("y"),
          let width = number("width"), let height = number("height"),
          width > 0, height > 0 else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
}

func resolveRunningApp(_ selector: String) -> NSRunningApplication? {
    let lower = selector.lowercased()
    return NSWorkspace.shared.runningApplications.first {
        ($0.bundleIdentifier?.lowercased() == lower || $0.localizedName?.lowercased() == lower)
            && !isHardBlocked($0)
    }
}

private struct InstalledAppCandidate {
    let bundleId: String
    let displayName: String
    let bundleName: String
    let fileName: String
    let bundleURL: URL?
}

private enum InstalledAppResolution {
    case resolved(InstalledAppCandidate)
    case ambiguous
    case missing
}

private func selectInstalledApplication(
    selector: String,
    candidates: [InstalledAppCandidate]
) -> InstalledAppResolution {
    let normalized = selector.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !normalized.isEmpty else { return .missing }
    let candidates = candidates.filter {
        !isHardBlocked(bundleId: $0.bundleId, name: $0.displayName)
    }
    for matches in [
        candidates.filter { $0.bundleId.lowercased() == normalized },
        candidates.filter { $0.displayName.lowercased() == normalized },
        candidates.filter { $0.bundleName.lowercased() == normalized },
        candidates.filter { $0.fileName.lowercased() == normalized },
    ] where !matches.isEmpty {
        let distinctBundleIds = Set(matches.map { $0.bundleId.lowercased() })
        guard distinctBundleIds.count == 1 else { return .ambiguous }
        return .resolved(matches[0])
    }
    return .missing
}

private func installedAppCandidate(bundleURL: URL) -> InstalledAppCandidate? {
    guard let bundle = Bundle(url: bundleURL), let bundleId = bundle.bundleIdentifier else {
        return nil
    }
    let fileName = bundleURL.deletingPathExtension().lastPathComponent
    let bundleName = (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? fileName
    let displayName = (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
        ?? bundleName
    guard !isHardBlocked(bundleId: bundleId, name: displayName) else { return nil }
    return InstalledAppCandidate(
        bundleId: bundleId,
        displayName: displayName,
        bundleName: bundleName,
        fileName: fileName,
        bundleURL: bundleURL
    )
}

private func resolveInstalledApplication(_ selector: String) -> InstalledAppResolution {
    var candidates: [InstalledAppCandidate] = []
    var seenURLs = Set<String>()

    func appendCandidate(at url: URL?) {
        guard let url else { return }
        let canonicalURL = url.resolvingSymlinksInPath().standardizedFileURL
        guard seenURLs.insert(canonicalURL.path.lowercased()).inserted,
              let candidate = installedAppCandidate(bundleURL: canonicalURL) else { return }
        candidates.append(candidate)
    }

    for application in NSWorkspace.shared.runningApplications {
        appendCandidate(at: application.bundleURL)
    }
    appendCandidate(at: NSWorkspace.shared.urlForApplication(withBundleIdentifier: selector))
    if let path = NSWorkspace.shared.fullPath(forApplication: selector) {
        appendCandidate(at: URL(fileURLWithPath: path))
    }

    let applicationDirectories = [
        URL(fileURLWithPath: "/Applications", isDirectory: true),
        URL(fileURLWithPath: "/System/Applications", isDirectory: true),
        URL(fileURLWithPath: "/System/Applications/Utilities", isDirectory: true),
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications", isDirectory: true),
    ]
    for directory in applicationDirectories {
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        for url in urls where url.pathExtension.lowercased() == "app" {
            appendCandidate(at: url)
        }
    }

    return selectInstalledApplication(selector: selector, candidates: candidates)
}

func resolveAppMetadata(_ selector: String) -> [String: Any]? {
    guard case .resolved(let candidate) = resolveInstalledApplication(selector) else { return nil }
    let running = resolveRunningApp(candidate.bundleId)
    var metadata: [String: Any] = [
        "bundleId": candidate.bundleId,
        "name": candidate.displayName,
        "running": running != nil,
    ]
    if let iconBase64 = appIconBase64(bundleURL: running?.bundleURL ?? candidate.bundleURL) {
        metadata["iconBase64"] = iconBase64
    }
    return metadata
}

func launchApp(_ selector: String, request req: Request) throws -> NSRunningApplication {
    if let running = resolveRunningApp(selector) {
        if let failure = authorizeNativeEffect(req, requiredTier: .clickOnly) { throw failure }
        running.activate(options: [.activateAllWindows])
        return running
    }
    guard !isHardBlocked(bundleId: selector),
          case .resolved(let candidate) = resolveInstalledApplication(selector),
          let url = candidate.bundleURL else {
        throw NSError(domain: "ComputerUse", code: 1, userInfo: [NSLocalizedDescriptionKey: "Application not found: \(selector)"])
    }
    let bundleId = candidate.bundleId
    if let failure = authorizeNativeEffect(req, requiredTier: .clickOnly) { throw failure }
    guard NSWorkspace.shared.open(url) else {
        throw NSError(domain: "ComputerUse", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not open application: \(selector)"])
    }
    for _ in 0..<600 {
        if let app = resolveRunningApp(bundleId) {
            if let failure = authorizeNativeEffect(req, requiredTier: .clickOnly) { throw failure }
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

func textContentState(_ element: AXUIElement) -> String {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        element,
        kAXValueAttribute as CFString,
        &value
    ) == .success, let value else { return "unknown" }
    if let string = value as? String {
        return string.isEmpty ? "empty" : "non_empty"
    }
    if let attributed = value as? NSAttributedString {
        return attributed.length == 0 ? "empty" : "non_empty"
    }
    return "unknown"
}

func textSelectionState(_ element: AXUIElement) -> String {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        element,
        kAXSelectedTextRangeAttribute as CFString,
        &value
    ) == .success, let value,
          CFGetTypeID(value) == AXValueGetTypeID() else { return "unknown" }
    var range = CFRange(location: 0, length: 0)
    guard AXValueGetValue(value as! AXValue, .cfRange, &range), range.length >= 0 else {
        return "unknown"
    }
    return range.length == 0 ? "none" : "selected"
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

private struct AXControlDescriptor {
    let role: String
    let label: String
    let description: String
    let actions: [String]
    let screenFrame: CGRect
    let verifiedActionable: Bool
}

private enum AXDescriptorResolution {
    case descriptor(AXControlDescriptor)
    case secure
}

private let ACTIONABLE_AX_ROLES = Set([
    "AXButton", "AXCheckBox", "AXDefaultButton", "AXDisclosureTriangle", "AXLink",
    "AXMenuItem", "AXPopUpButton", "AXRadioButton", "AXSearchField", "AXTextArea",
    "AXTextField",
])
private let SUPPORTED_AX_ACTIONS = Set([
    "AXConfirm", "AXDecrement", "AXIncrement", "AXPick", "AXPress", "AXShowMenu",
])

private func normalizedAXDescriptor(
    role: String,
    subrole: String = "",
    label: String,
    description: String,
    actions: [String],
    screenFrame: CGRect
) -> AXDescriptorResolution {
    if isSecureRole(role, subrole) { return .secure }
    let boundedActions = Array(actions.prefix(16)).map { String($0.prefix(120)) }
    let boundedLabel = String(label.prefix(240))
    let validFrame = screenFrame.width > 0 && screenFrame.height > 0
    let verified = !boundedLabel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && validFrame
        && (ACTIONABLE_AX_ROLES.contains(role)
            || boundedActions.contains(where: SUPPORTED_AX_ACTIONS.contains))
    return .descriptor(AXControlDescriptor(
        role: String(role.prefix(120)),
        label: boundedLabel,
        description: String(description.prefix(360)),
        actions: boundedActions,
        screenFrame: screenFrame,
        verifiedActionable: verified
    ))
}

private func nearestActionableDescriptor(
    _ candidates: [AXControlDescriptor]
) -> AXControlDescriptor? {
    candidates.first(where: \.verifiedActionable) ?? candidates.first
}

private func axActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success,
          let names = names as? [String] else { return [] }
    return Array(names.prefix(16))
}

private func directControlDescriptor(_ element: AXUIElement) -> AXDescriptorResolution {
    let role = axString(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
    let subrole = axString(element, kAXSubroleAttribute as CFString) ?? ""
    if isSecureRole(role, subrole) { return .secure }
    let title = axString(element, kAXTitleAttribute as CFString) ?? ""
    let description = axString(element, kAXDescriptionAttribute as CFString) ?? ""
    let help = axString(element, kAXHelpAttribute as CFString) ?? ""
    let value = axString(element, kAXValueAttribute as CFString) ?? ""
    let label = [title, description, help, value].first { !$0.isEmpty } ?? ""
    return normalizedAXDescriptor(
        role: role,
        subrole: subrole,
        label: label,
        description: description.isEmpty ? help : description,
        actions: axActionNames(element),
        screenFrame: axFrame(element) ?? .null
    )
}

private func actionableDescriptor(from hit: AXUIElement) -> AXDescriptorResolution {
    var descriptors: [AXControlDescriptor] = []
    var current: AXUIElement? = hit
    for _ in 0..<9 {
        guard let element = current else { break }
        switch directControlDescriptor(element) {
        case .secure:
            return .secure
        case .descriptor(let descriptor):
            descriptors.append(descriptor)
        }
        var parent: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXParentAttribute as CFString,
            &parent
        ) == .success, let parent else { break }
        current = (parent as! AXUIElement)
    }
    guard let descriptor = nearestActionableDescriptor(descriptors) else {
        return .descriptor(AXControlDescriptor(
            role: "AXUnknown",
            label: "",
            description: "",
            actions: [],
            screenFrame: .null,
            verifiedActionable: false
        ))
    }
    return .descriptor(descriptor)
}

private func apiFrame(
    screenFrame: CGRect,
    captureFrame: CGRect,
    apiWidth: Int,
    apiHeight: Int
) -> CGRect? {
    guard screenFrame.width > 0, screenFrame.height > 0,
          captureFrame.width > 0, captureFrame.height > 0,
          apiWidth > 0, apiHeight > 0 else { return nil }
    let clipped = screenFrame.intersection(captureFrame)
    guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else { return nil }
    return CGRect(
        x: ((clipped.minX - captureFrame.minX) * Double(apiWidth) / captureFrame.width).rounded(),
        y: ((clipped.minY - captureFrame.minY) * Double(apiHeight) / captureFrame.height).rounded(),
        width: (clipped.width * Double(apiWidth) / captureFrame.width).rounded(),
        height: (clipped.height * Double(apiHeight) / captureFrame.height).rounded()
    )
}

private func apiGeometryPayload(_ frame: CGRect) -> [String: Any] {
    let x = Int(frame.minX)
    let y = Int(frame.minY)
    let width = Int(frame.width)
    let height = Int(frame.height)
    return [
        "apiFrame": ["x": x, "y": y, "width": width, "height": height],
        "apiCenter": ["x": x + width / 2, "y": y + height / 2],
    ]
}

private func rectPayload(_ frame: CGRect) -> [String: Int] {
    [
        "x": Int(frame.minX.rounded()),
        "y": Int(frame.minY.rounded()),
        "width": Int(frame.width.rounded()),
        "height": Int(frame.height.rounded()),
    ]
}

private func interactiveElements(
    nodes: [AXNode],
    captureFrame: CGRect,
    apiWidth: Int,
    apiHeight: Int
) -> [[String: Any]] {
    var results: [[String: Any]] = []
    for node in nodes where results.count < 120 {
        guard case .descriptor(let descriptor) = directControlDescriptor(node.element),
              descriptor.verifiedActionable,
              let frame = apiFrame(
                screenFrame: descriptor.screenFrame,
                captureFrame: captureFrame,
                apiWidth: apiWidth,
                apiHeight: apiHeight
              ) else { continue }
        var result: [String: Any] = [
            "role": descriptor.role,
            "label": descriptor.label,
            "description": descriptor.description,
            "actions": descriptor.actions,
            "verifiedActionable": true,
        ]
        result.merge(apiGeometryPayload(frame)) { _, new in new }
        results.append(result)
    }
    return results
}

func expectedTargetMatches(_ req: Request, app: NSRunningApplication) -> Bool {
    if let expectedPid = intParam(req, "expected_pid"), expectedPid != Int(app.processIdentifier) {
        return false
    }
    guard let expected = dictionaryParam(req, "expected_window_frame") else { return true }
    guard let window = focusedWindow(app), let actual = axFrame(window) else { return false }
    func number(_ key: String) -> Double? {
        if let value = expected[key] as? Double { return value }
        if let value = expected[key] as? Int { return Double(value) }
        return nil
    }
    guard let x = number("x"), let y = number("y"),
          let width = number("width"), let height = number("height") else { return false }
    let tolerance = 2.0
    return abs(actual.minX - x) <= tolerance
        && abs(actual.minY - y) <= tolerance
        && abs(actual.width - width) <= tolerance
        && abs(actual.height - height) <= tolerance
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
        return markers.contains(where: title.contains) || containsSecureControl(window)
    }
}

func isSecureRole(_ role: String, _ subrole: String) -> Bool {
    role.localizedCaseInsensitiveContains("secure")
        || subrole.localizedCaseInsensitiveContains("secure")
}

func containsSecureControl(_ root: AXUIElement, maxNodes: Int = 1_200) -> Bool {
    var remaining = maxNodes
    func walk(_ element: AXUIElement) -> Bool {
        guard remaining > 0 else { return true }
        remaining -= 1
        let role = axString(element, kAXRoleAttribute as CFString) ?? ""
        let subrole = axString(element, kAXSubroleAttribute as CFString) ?? ""
        if isSecureRole(role, subrole) { return true }
        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXChildrenAttribute as CFString,
            &childrenRef
        ) == .success, let children = childrenRef as? [AXUIElement] else { return false }
        return children.contains(where: walk)
    }
    return walk(root)
}

func fittedDimensions(width: Int, height: Int, maximumWidth: Int = 1280, maximumHeight: Int = 720) -> (Int, Int) {
    guard width > 0, height > 0 else { return (1, 1) }
    let scale = min(1, min(Double(maximumWidth) / Double(width), Double(maximumHeight) / Double(height)))
    return (
        max(1, Int((Double(width) * scale).rounded())),
        max(1, Int((Double(height) * scale).rounded()))
    )
}

func renderPng(_ cgImage: CGImage) -> (Data, Int, Int)? {
    let (width, height) = fittedDimensions(width: cgImage.width, height: cgImage.height)
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
    return (png, width, height)
}

func screenshotPayload(
    image sourceImage: CGImage,
    windowFrame: CGRect,
    displayId: CGDirectDisplayID,
    captureFrame requestedCaptureFrame: CGRect?,
    backend: String
) -> [String: Any]? {
    var image = sourceImage
    var frame = windowFrame
    if let requestedCaptureFrame {
        let tolerance = 1.0
        guard requestedCaptureFrame.minX >= windowFrame.minX - tolerance,
              requestedCaptureFrame.minY >= windowFrame.minY - tolerance,
              requestedCaptureFrame.maxX <= windowFrame.maxX + tolerance,
              requestedCaptureFrame.maxY <= windowFrame.maxY + tolerance else { return nil }
        let offsetX = requestedCaptureFrame.minX - windowFrame.minX
        let offsetY = requestedCaptureFrame.minY - windowFrame.minY
        let pixelRect = CGRect(
            x: offsetX * Double(sourceImage.width) / windowFrame.width,
            y: Double(sourceImage.height)
                - (offsetY + requestedCaptureFrame.height)
                    * Double(sourceImage.height) / windowFrame.height,
            width: requestedCaptureFrame.width * Double(sourceImage.width) / windowFrame.width,
            height: requestedCaptureFrame.height * Double(sourceImage.height) / windowFrame.height
        ).integral.intersection(
            CGRect(x: 0, y: 0, width: sourceImage.width, height: sourceImage.height)
        )
        guard pixelRect.width > 0, pixelRect.height > 0 else { return nil }
        guard let cropped = sourceImage.cropping(to: pixelRect) else { return nil }
        image = cropped
        frame = requestedCaptureFrame
    }
    guard let (png, width, height) = renderPng(image) else { return nil }
    let scale = Double(width) / max(1, frame.width)
    let globalCursor = CGEvent(source: nil)?.location ?? .zero
    let cursorX = (globalCursor.x - frame.minX) * Double(width) / max(1, frame.width)
    let cursorY = (globalCursor.y - frame.minY) * Double(height) / max(1, frame.height)
    return [
        "screenshot_id": UUID().uuidString,
        "screenshot_base64": png.base64EncodedString(),
        "screenshot_mime_type": "image/png",
        "screenshot_width": width,
        "screenshot_height": height,
        "screenshot_scale": scale,
        "display_id": displayId,
        "capture_backend": backend,
        "cursor_position": ["x": cursorX, "y": cursorY],
        "window_frame": [
            "x": windowFrame.minX,
            "y": windowFrame.minY,
            "width": windowFrame.width,
            "height": windowFrame.height,
        ],
        "target_window_frame": [
            "x": windowFrame.minX,
            "y": windowFrame.minY,
            "width": windowFrame.width,
            "height": windowFrame.height,
        ],
        "capture_frame": [
            "x": frame.minX,
            "y": frame.minY,
            "width": frame.width,
            "height": frame.height,
        ],
    ]
}

@available(macOS 12.3, *)
private final class OneFrameCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "ai.verboo.computer-use.capture")
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var completed = false
    private var capturedImage: CGImage?
    private var stream: SCStream?

    private func finish(_ image: CGImage?) {
        lock.lock()
        defer { lock.unlock() }
        guard !completed else { return }
        completed = true
        capturedImage = image
        semaphore.signal()
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .screen,
              sampleBuffer.isValid,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        finish(context.createCGImage(ciImage, from: ciImage.extent))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        NSLog("Verboo Computer Use: ScreenCaptureKit stream stopped: %@", error.localizedDescription)
        finish(nil)
    }

    func capture(filter: SCContentFilter, configuration: SCStreamConfiguration) -> CGImage? {
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        self.stream = stream
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        } catch {
            NSLog("Verboo Computer Use: could not attach ScreenCaptureKit output: %@", error.localizedDescription)
            return nil
        }
        stream.startCapture { [weak self] error in
            if let error {
                NSLog("Verboo Computer Use: could not start ScreenCaptureKit stream: %@", error.localizedDescription)
                self?.finish(nil)
            }
        }
        guard semaphore.wait(timeout: .now() + 4) == .success else {
            NSLog("Verboo Computer Use: timed out waiting for a ScreenCaptureKit frame")
            stream.stopCapture(completionHandler: nil)
            return nil
        }
        stream.stopCapture(completionHandler: nil)
        return capturedImage
    }
}

@available(macOS 12.3, *)
private final class ShareableContentCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var content: SCShareableContent?
    private var completed = false

    func complete(content: SCShareableContent?) {
        lock.lock()
        self.content = content
        completed = true
        lock.unlock()
    }

    func snapshot() -> (completed: Bool, content: SCShareableContent?) {
        lock.lock()
        defer { lock.unlock() }
        return (completed, content)
    }
}

@available(macOS 12.3, *)
private func shareableScreenContent(timeout: TimeInterval = 4) -> SCShareableContent? {
    let completion = ShareableContentCompletion()
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) {
        content,
        error in
        if let error {
            NSLog("Verboo Computer Use: could not retrieve shareable content: %@", error.localizedDescription)
        }
        completion.complete(content: content)
    }
    let deadline = Date().addingTimeInterval(timeout)
    while !completion.snapshot().completed && Date() < deadline {
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
    }
    return completion.snapshot().content
}

@available(macOS 12.3, *)
private func screenCaptureKitWindow(
    _ app: NSRunningApplication,
    focusedFrame: CGRect,
    captureFrame: CGRect?
) -> [String: Any]? {
    // A command-line helper does not create an NSApplication by default.
    // ScreenCaptureKit's filter initializer requires an initialized CGS
    // connection and aborts the process instead of returning an error when it
    // is missing (CGS_REQUIRE_INIT). Keep the helper UI-less while ensuring
    // the WindowServer connection exists before touching SCContentFilter.
    // `.accessory` keeps the LSUIElement agent out of the Dock while retaining
    // the Cocoa application identity required by current TCC implementations.
    let helperApplication = NSApplication.shared
    _ = helperApplication.setActivationPolicy(.accessory)
    guard let content = shareableScreenContent(),
          let selected = content.windows
            .filter({
                $0.owningApplication?.processID == app.processIdentifier
                    && $0.windowLayer == 0
                    && $0.windowID != 0
                    && isEligibleCaptureFrame($0.frame)
            })
            .max(by: { intersectionArea($0.frame, focusedFrame) < intersectionArea($1.frame, focusedFrame) }),
          intersectionArea(selected.frame, focusedFrame) > 0 else { return nil }

    let filter = SCContentFilter(desktopIndependentWindow: selected)
    let configuration = SCStreamConfiguration()
    configuration.showsCursor = true
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
    configuration.queueDepth = 1
    configuration.scalesToFit = false
    if #available(macOS 13.0, *) {
        let screen = focusScreen(containing: selected.frame)?.screen
        let backingScale = max(1, screen?.backingScaleFactor ?? 1)
        configuration.width = max(1, min(8192, Int((selected.frame.width * backingScale).rounded())))
        configuration.height = max(1, min(8192, Int((selected.frame.height * backingScale).rounded())))
    }
    if #available(macOS 14.0, *) {
        configuration.preservesAspectRatio = true
        configuration.ignoreShadowsSingleWindow = true
    }
    guard let image = OneFrameCapture().capture(filter: filter, configuration: configuration) else {
        return nil
    }
    let display = focusScreen(containing: selected.frame)?.screen
    let displayId = (display?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    return screenshotPayload(
        image: image,
        windowFrame: selected.frame,
        displayId: displayId,
        captureFrame: captureFrame,
        backend: "screen_capture_kit"
    )
}

private func legacyAuthorizedWindow(
    _ app: NSRunningApplication,
    focusedFrame: CGRect,
    captureFrame: CGRect?
) -> [String: Any]? {
    guard let windowInfo = CGWindowListCopyWindowInfo(
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
    }), let image = CGWindowListCreateImage(
        .null,
        .optionIncludingWindow,
        selected.0,
        [.boundsIgnoreFraming, .nominalResolution]
    ) else { return nil }
    let display = focusScreen(containing: selected.1)?.screen
    let displayId = (display?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    return screenshotPayload(
        image: image,
        windowFrame: selected.1,
        displayId: displayId,
        captureFrame: captureFrame,
        backend: "legacy_window_capture"
    )
}

func captureAuthorizedWindow(
    request req: Request,
    _ app: NSRunningApplication,
    captureFrame: CGRect? = nil
) -> [String: Any]? {
    guard authorizeNativeEffect(req, requiredTier: .viewOnly) == nil,
          let axWindow = focusedWindow(app),
          let focusedFrame = axFrame(axWindow) else { return nil }
    let captured: [String: Any]?
    if #available(macOS 12.3, *) {
        captured = screenCaptureKitWindow(
            app,
            focusedFrame: focusedFrame,
            captureFrame: captureFrame
        )
    } else {
        captured = legacyAuthorizedWindow(
            app,
            focusedFrame: focusedFrame,
            captureFrame: captureFrame
        )
    }
    guard var captured else { return nil }
    captured["app_pid"] = Int(app.processIdentifier)
    captured["window_title"] = String((axString(axWindow, kAXTitleAttribute as CFString) ?? "").prefix(240))
    return captured
}

func postClick(_ point: CGPoint, request req: Request) -> Bool {
    guard postAuthorizedEvent(
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
        request: req,
        requiredTier: .clickOnly
    ), postAuthorizedEvent(
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
        request: req,
        requiredTier: .clickOnly
    ), postAuthorizedEvent(
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left),
        request: req,
        requiredTier: .clickOnly
    ) else { return false }
    return true
}

func postMouseClick(_ point: CGPoint, button: CGMouseButton, count: Int, request req: Request) -> Bool {
    let downType: CGEventType = button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown
    let upType: CGEventType = button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp
    guard postAuthorizedEvent(
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: button),
        request: req,
        requiredTier: .clickOnly
    ) else { return false }
    for click in 1...count {
        guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button),
              let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button) else { return false }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        guard postAuthorizedEvent(down, request: req, requiredTier: .clickOnly),
              postAuthorizedEvent(up, request: req, requiredTier: .clickOnly) else { return false }
        usleep(35_000)
    }
    return true
}

func pointBelongsToApp(_ point: CGPoint, app: NSRunningApplication) -> Bool {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    var windowsRef: CFTypeRef?
    let windows = (AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &windowsRef) == .success ? windowsRef as? [AXUIElement] : nil) ?? []
    guard windows.compactMap(axFrame).contains(where: { $0.contains(point) }) else { return false }
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success,
          let hit else { return false }
    var hitPid: pid_t = 0
    AXUIElementGetPid(hit, &hitPid)
    return hitPid == app.processIdentifier
}

private func verifiedPointerContext(
    _ req: Request,
    requiredTier: NativeControlTier = .viewOnly
) -> (NSRunningApplication, CGPoint)? {
    guard AXIsProcessTrusted(), let selector = stringParam(req, "app"),
          let app = resolveRunningApp(selector), expectedTargetMatches(req, app: app),
          let x = intParam(req, "x"), let y = intParam(req, "y") else { return nil }
    guard !hasSensitiveWindow(app) else { return nil }
    guard activateAuthorizedApp(app, request: req, requiredTier: requiredTier) else { return nil }
    usleep(120_000)
    let point = CGPoint(x: x, y: y)
    guard expectedTargetMatches(req, app: app),
          NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
          pointBelongsToApp(point, app: app) else { return nil }
    if stringParam(req, "expected_role") != nil || stringParam(req, "expected_label") != nil {
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(
            AXUIElementCreateSystemWide(),
            Float(point.x),
            Float(point.y),
            &hit
        ) == .success, let hit else { return nil }
        guard case .descriptor(let descriptor) = actionableDescriptor(from: hit) else {
            return nil
        }
        if let expectedRole = stringParam(req, "expected_role"), expectedRole != descriptor.role {
            return nil
        }
        if let expectedLabel = stringParam(req, "expected_label"), expectedLabel != descriptor.label {
            return nil
        }
    }
    guard authorizeNativeEffect(req, requiredTier: requiredTier) == nil else { return nil }
    return (app, point)
}

private func verifiedKeyboardContext(
    _ req: Request,
    requiredTier: NativeControlTier = .viewOnly
) -> (NSRunningApplication, AXUIElement)? {
    guard AXIsProcessTrusted(), let selector = stringParam(req, "app"),
          let app = resolveRunningApp(selector), expectedTargetMatches(req, app: app),
          !hasSensitiveWindow(app) else { return nil }
    guard activateAuthorizedApp(app, request: req, requiredTier: requiredTier) else { return nil }
    usleep(120_000)
    guard expectedTargetMatches(req, app: app),
          NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { return nil }
    let system = AXUIElementCreateSystemWide()
    var focusedRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        system,
        kAXFocusedUIElementAttribute as CFString,
        &focusedRef
    ) == .success, let focusedRef else { return nil }
    let focused = focusedRef as! AXUIElement
    var focusedPid: pid_t = 0
    AXUIElementGetPid(focused, &focusedPid)
    guard focusedPid == app.processIdentifier else { return nil }
    let role = axString(focused, kAXRoleAttribute as CFString) ?? "AXUnknown"
    let subrole = axString(focused, kAXSubroleAttribute as CFString) ?? ""
    guard !role.localizedCaseInsensitiveContains("secure"),
          !subrole.localizedCaseInsensitiveContains("secure") else { return nil }
    let label = axString(focused, kAXTitleAttribute as CFString)
        ?? axString(focused, kAXDescriptionAttribute as CFString)
        ?? ""
    if let expectedRole = stringParam(req, "expected_role"), expectedRole != role { return nil }
    if let expectedLabel = stringParam(req, "expected_label"), expectedLabel != label { return nil }
    let contentState = textContentState(focused)
    let selectionState = textSelectionState(focused)
    if let expected = stringParam(req, "expected_content_state"), expected != contentState {
        return nil
    }
    if let expected = stringParam(req, "expected_selection_state"), expected != selectionState {
        return nil
    }
    guard authorizeNativeEffect(req, requiredTier: requiredTier) == nil else { return nil }
    return (app, focused)
}

private func defaultButtonLabel(_ focused: AXUIElement) -> String {
    var windowRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        focused,
        kAXWindowAttribute as CFString,
        &windowRef
    ) == .success, let windowRef else { return "" }
    var defaultButtonRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        windowRef as! AXUIElement,
        kAXDefaultButtonAttribute as CFString,
        &defaultButtonRef
    ) == .success, let defaultButtonRef else { return "" }
    let button = defaultButtonRef as! AXUIElement
    return axString(button, kAXTitleAttribute as CFString)
        ?? axString(button, kAXDescriptionAttribute as CFString)
        ?? ""
}

func keyboardTargetPayload(_ focused: AXUIElement) -> [String: Any] {
    let role = axString(focused, kAXRoleAttribute as CFString) ?? "AXUnknown"
    let label = axString(focused, kAXTitleAttribute as CFString)
        ?? axString(focused, kAXDescriptionAttribute as CFString)
        ?? ""
    let description = axString(focused, kAXHelpAttribute as CFString) ?? ""
    let currentDefaultButtonLabel = defaultButtonLabel(focused)
    return [
        "role": String(role.prefix(120)),
        "label": String(label.prefix(240)),
        "description": String(description.prefix(360)),
        "defaultButtonLabel": String(currentDefaultButtonLabel.prefix(240)),
        "contentState": textContentState(focused),
        "selectionState": textSelectionState(focused),
    ]
}

func hasKeyboardPreflightState(_ req: Request) -> Bool {
    let contentStates = ["empty", "non_empty", "unknown"]
    let selectionStates = ["none", "selected", "unknown"]
    guard let contentState = stringParam(req, "expected_content_state"),
          let selectionState = stringParam(req, "expected_selection_state") else {
        return false
    }
    return contentStates.contains(contentState) && selectionStates.contains(selectionState)
}

private let actionCancellationLock = NSLock()
private var actionCancellationRequested = false
private var heldLeftMousePoint: CGPoint?
private var heldKeyCode: CGKeyCode?
private var actionSignalSources: [DispatchSourceSignal] = []

private enum NativeControlTier: Int {
    case viewOnly = 0
    case clickOnly = 1
    case fullControl = 2

    init?(wireValue: String) {
        switch wireValue {
        case "view_only": self = .viewOnly
        case "click_only": self = .clickOnly
        case "full_control": self = .fullControl
        default: return nil
        }
    }
}

private struct NativeApprovedApp: Decodable {
    let bundleId: String
    let displayName: String
    let tier: String

    enum CodingKeys: String, CodingKey {
        case bundleId = "bundle_id"
        case displayName = "display_name"
        case tier
    }
}

private struct NativeCapability: Decodable {
    let token: String
    let app: String
    let approvedApps: [NativeApprovedApp]
    let paused: Bool
    let expiresAt: UInt64

    enum CodingKeys: String, CodingKey {
        case token
        case app
        case approvedApps = "approved_apps"
        case paused
        case expiresAt = "expires_at"
    }
}

private enum NativeAuthorizationFailure: Error {
    case capabilityRequired
    case sessionRevoked
    case scopeDenied
    case osPermissionRevoked

    var response: (code: String, message: String) {
        switch self {
        case .capabilityRequired:
            return ("capability_required", "A live Computer Use capability is required")
        case .sessionRevoked:
            return ("session_revoked", "The Computer Use capability is paused, expired, or revoked")
        case .scopeDenied:
            return ("scope_denied", "The requested app or control tier is outside the Computer Use capability")
        case .osPermissionRevoked:
            return ("os_permission_revoked", "Screen Recording permission was revoked before the Computer Use effect")
        }
    }
}

private func loadNativeCapability() throws -> NativeCapability {
    let environment = ProcessInfo.processInfo.environment
    guard let path = environment["VERBOO_CU_CAPABILITY_FILE"], !path.isEmpty,
          let expectedToken = environment["VERBOO_CU_TOKEN"], !expectedToken.isEmpty else {
        throw NativeAuthorizationFailure.capabilityRequired
    }
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let capability = try? JSONDecoder().decode(NativeCapability.self, from: data),
          capability.token == expectedToken,
          !capability.token.isEmpty,
          !capability.paused,
          capability.expiresAt > UInt64(Date().timeIntervalSince1970) else {
        throw NativeAuthorizationFailure.sessionRevoked
    }
    return capability
}

private func requiredTier(for method: String) -> NativeControlTier {
    switch method {
    case "type-text", "press-key", "hotkey", "hold-key":
        return .fullControl
    case "launch-app", "click", "left-click", "right-click", "middle-click", "double-click",
         "triple-click", "mouse-move", "scroll", "left-click-drag", "left-mouse-down",
         "left-mouse-up":
        return .clickOnly
    default:
        return .viewOnly
    }
}

private func authorizeNativeRequest(
    _ req: Request,
    requiredTier overrideTier: NativeControlTier? = nil
) -> NativeAuthorizationFailure? {
    let capability: NativeCapability
    do {
        capability = try loadNativeCapability()
    } catch let failure as NativeAuthorizationFailure {
        return failure
    } catch {
        return .sessionRevoked
    }

    let activeApp = capability.app.trimmingCharacters(in: .whitespacesAndNewlines)
    let requestedApp = stringParam(req, "app")?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? activeApp
    guard !activeApp.isEmpty,
          requestedApp.caseInsensitiveCompare(activeApp) == .orderedSame,
          let approved = capability.approvedApps.first(where: {
              $0.bundleId.caseInsensitiveCompare(activeApp) == .orderedSame
          }),
          !isHardBlocked(bundleId: approved.bundleId, name: approved.displayName),
          let approvedTier = NativeControlTier(wireValue: approved.tier),
          approvedTier.rawValue >= (overrideTier ?? requiredTier(for: req.method)).rawValue else {
        return .scopeDenied
    }
    return nil
}

private func authorizeNativeEffect(
    _ req: Request,
    requiredTier: NativeControlTier,
    screenRecordingGranted: Bool
) -> NativeAuthorizationFailure? {
    if let failure = authorizeNativeRequest(req, requiredTier: requiredTier) {
        return failure
    }
    guard screenRecordingGranted else { return .osPermissionRevoked }
    return nil
}

private func authorizeNativeEffect(
    _ req: Request,
    requiredTier: NativeControlTier
) -> NativeAuthorizationFailure? {
    authorizeNativeEffect(
        req,
        requiredTier: requiredTier,
        screenRecordingGranted: CGPreflightScreenCaptureAccess()
    )
}

private func actionCancellationIsRequested() -> Bool {
    actionCancellationLock.lock()
    let cancelled = actionCancellationRequested
    actionCancellationLock.unlock()
    return cancelled
}

@discardableResult
private func postAuthorizedEvent(
    _ event: CGEvent?,
    request req: Request,
    requiredTier: NativeControlTier
) -> Bool {
    guard !actionCancellationIsRequested(),
          authorizeNativeEffect(req, requiredTier: requiredTier) == nil,
          let event else { return false }
    event.post(tap: .cghidEventTap)
    return true
}

private func postSafetyReleaseEvent(_ event: CGEvent?) {
    // Revocation must not leave a key or mouse button held. This is the sole
    // post-revocation event path and it can only release state held by us.
    event?.post(tap: .cghidEventTap)
}

private func performAuthorizedAXAction(
    _ element: AXUIElement,
    action: CFString,
    request req: Request,
    requiredTier: NativeControlTier
) -> Bool {
    guard !actionCancellationIsRequested(),
          authorizeNativeEffect(req, requiredTier: requiredTier) == nil else { return false }
    return AXUIElementPerformAction(element, action) == .success
}

private func activateAuthorizedApp(
    _ app: NSRunningApplication,
    request req: Request,
    requiredTier: NativeControlTier
) -> Bool {
    guard !actionCancellationIsRequested(),
          authorizeNativeEffect(req, requiredTier: requiredTier) == nil else { return false }
    return app.activate(options: [.activateAllWindows])
}

private func waitForUISettle() {
    Thread.sleep(forTimeInterval: 0.15)
}

private func writeMutationSuccess(_ req: Request, result: [String: Any]) {
    waitForUISettle()
    writeResponse(req.id, result: result, error: nil)
}

private func capabilityAllowsAction() -> Bool {
    (try? loadNativeCapability()) != nil
}

private let preConsentMethods: Set<String> = [
    "capabilities", "list-apps", "resolve-app", "permissions", "request-permissions",
]

private func actionMayProceed() -> Bool {
    actionCancellationLock.lock()
    let cancelled = actionCancellationRequested
    actionCancellationLock.unlock()
    return !cancelled && capabilityAllowsAction()
}

@discardableResult
private func cancellableSleep(_ duration: Double) -> Bool {
    let deadline = Date().addingTimeInterval(duration)
    while Date() < deadline {
        guard actionMayProceed() else { return false }
        let remaining = deadline.timeIntervalSinceNow
        usleep(useconds_t(max(1_000, min(10_000, remaining * 1_000_000))))
    }
    return actionMayProceed()
}

private func requestActionCancellation() {
    actionCancellationLock.lock()
    actionCancellationRequested = true
    let key = heldKeyCode
    heldKeyCode = nil
    let mousePoint = heldLeftMousePoint
    heldLeftMousePoint = nil
    actionCancellationLock.unlock()

    if let key {
        postSafetyReleaseEvent(CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false))
    }
    if let mousePoint {
        postSafetyReleaseEvent(CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseUp,
            mouseCursorPosition: mousePoint,
            mouseButton: .left
        ))
    }
}

private func installActionCancellationHandlers() {
    for signalNumber in [SIGTERM, SIGINT] {
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .global(qos: .userInitiated))
        source.setEventHandler(handler: requestActionCancellation)
        source.resume()
        actionSignalSources.append(source)
    }
}

func typeUnicode(_ text: String, request req: Request) -> Bool {
    let chars = Array(text.utf16)
    var performed = false
    chars.withUnsafeBufferPointer { buffer in
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return }
        down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: buffer.baseAddress!)
        up.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: buffer.baseAddress!)
        guard postAuthorizedEvent(down, request: req, requiredTier: .fullControl) else { return }
        performed = postAuthorizedEvent(up, request: req, requiredTier: .fullControl)
    }
    return performed
}

let KEY_CODES: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53,
    "delete": 51, "backspace": 51, "left": 123, "right": 124, "down": 125, "up": 126,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
    "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37,
    "j": 38, "k": 40, "n": 45, "m": 46,
]

private func defaultButtonMetadataMatches(
    key: String,
    expectedLabel: String?,
    actualLabel: String
) -> Bool {
    guard ["enter", "return"].contains(key.lowercased()) else { return true }
    guard let expectedLabel else { return false }
    return expectedLabel == actualLabel
}

private func defaultButtonMatchesExpected(_ req: Request, focused: AXUIElement, key: String) -> Bool {
    defaultButtonMetadataMatches(
        key: key,
        expectedLabel: stringParam(req, "expected_default_button_label"),
        actualLabel: defaultButtonLabel(focused)
    )
}

func postKey(
    _ key: String,
    modifiers: CGEventFlags = [],
    request req: Request,
    focused: AXUIElement
) -> Bool {
    guard defaultButtonMatchesExpected(req, focused: focused, key: key),
          let code = KEY_CODES[key.lowercased()] else { return false }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { return false }
    down.flags = modifiers; up.flags = modifiers
    return postAuthorizedEvent(down, request: req, requiredTier: .fullControl)
        && postAuthorizedEvent(up, request: req, requiredTier: .fullControl)
}

// MARK: - Dispatcher

private let CONTRACT_SCREENSHOT_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8WQAAAAASUVORK5CYII="

private func contractScreenshotResult() -> [String: Any] {
    [
        "tree": "[0] AXWindow title=\"Contract Test\"",
        "elementCount": 1,
        "tree_truncated": false,
        "screenshot_id": UUID().uuidString,
        "screenshot_base64": CONTRACT_SCREENSHOT_BASE64,
        "screenshot_mime_type": "image/png",
        "screenshot_width": 1,
        "screenshot_height": 1,
        "screenshot_scale": 1,
        "display_id": 1,
        "app_pid": 4242,
        "window_title": "Contract Test",
        "capture_backend": "contract_test",
        "cursor_position": ["x": 0, "y": 0],
        "window_frame": ["x": 0, "y": 0, "width": 1, "height": 1],
    ]
}

private func handleContractTest(_ req: Request) {
    switch stringParam(req, "contract_case") {
    case "secure_field":
        writeResponse(req.id, result: nil, error: ("secure_text_field", "Contract fixture secure field"))
        return
    case "foreign_window":
        writeResponse(req.id, result: nil, error: ("scope_denied", "Contract fixture foreign window"))
        return
    default:
        break
    }

    let hasApp = stringParam(req, "app")?.isEmpty == false
    let hasPoint = intParam(req, "x") != nil && intParam(req, "y") != nil
    switch req.method {
    case "overlay-style":
        writeResponse(req.id, result: [
            "coreWidth": OVERLAY_CORE_WIDTH,
            "midGlowWidth": OVERLAY_MID_GLOW_WIDTH,
            "diffuseGlowWidth": OVERLAY_DIFFUSE_GLOW_WIDTH,
            "colors": OVERLAY_COLOR_HEX,
            "breathDurationSeconds": OVERLAY_BREATH_DURATION,
            "rotates": false,
            "showsPill": false,
        ], error: nil)
    case "overlay-phase-advances":
        guard let paused = boolParam(req, "paused"),
              let reduceMotion = boolParam(req, "reduce_motion") else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "overlay motion state is required")); return
        }
        writeResponse(req.id, result: [
            "advances": overlayPhaseAdvances(paused: paused, reduceMotion: reduceMotion),
        ], error: nil)
    case "compact-window-frames":
        guard let screenFrame = rectArray(req.params?["screen_frame"]?.value),
              let visibleFrame = rectArray(req.params?["visible_frame"]?.value),
              let mainHeight = doubleParam(req, "main_height"),
              let frames = compactWindowFrames(
                screenFrame: screenFrame,
                visibleFrame: visibleFrame,
                mainHeight: mainHeight
              ) else {
            writeResponse(req.id, result: nil, error: ("compact_unavailable", "Display is too small for compact layout")); return
        }
        writeResponse(req.id, result: [
            "targetFrame": rectPayload(frames.targetAXFrame),
            "controllerFrame": rectPayload(frames.controllerAXFrame),
            "overlayFrame": rectPayload(frames.overlayAppKitFrame),
        ], error: nil)
    case "restore-frame-decision":
        guard let pidMatches = boolParam(req, "pid_matches"),
              let bundleMatches = boolParam(req, "bundle_matches"),
              let launchMatches = boolParam(req, "launch_matches"),
              let candidateCount = intParam(req, "candidate_count"),
              let currentMatchesOriginal = boolParam(req, "current_matches_original"),
              let currentMatchesApplied = boolParam(req, "current_matches_applied") else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "restore decision metadata is required")); return
        }
        let decision = restoreFrameDecision(
            pidMatches: pidMatches,
            bundleMatches: bundleMatches,
            launchMatches: launchMatches,
            candidateCount: candidateCount,
            currentMatchesOriginal: currentMatchesOriginal,
            currentMatchesApplied: currentMatchesApplied
        )
        writeResponse(req.id, result: ["restore": decision.restore, "retire": decision.retire], error: nil)
    case "should-apply-compact-layout":
        guard let currentIdentity = stringParam(req, "current_identity"),
              let previousGeneration = intParam(req, "previous_generation"),
              let currentGeneration = intParam(req, "current_generation"),
              previousGeneration >= 0, currentGeneration >= 0 else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "layout identity metadata is required")); return
        }
        let previousIdentity = stringParam(req, "previous_identity").flatMap { $0.isEmpty ? nil : $0 }
        writeResponse(req.id, result: [
            "apply": shouldApplyCompactLayout(
                previousIdentity: previousIdentity,
                currentIdentity: currentIdentity
            ),
        ], error: nil)
    case "should-activate-target":
        guard let previousGeneration = intParam(req, "previous_generation"),
              let currentGeneration = intParam(req, "current_generation"),
              previousGeneration >= 0, currentGeneration >= 0 else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "focus generation metadata is required")); return
        }
        writeResponse(req.id, result: [
            "activate": shouldActivateTarget(
                previousGeneration: UInt64(previousGeneration),
                currentGeneration: UInt64(currentGeneration)
            ),
        ], error: nil)
    case "should-publish-layout-status":
        guard let protocolReady = boolParam(req, "protocol_ready"),
              let targetObserved = boolParam(req, "target_observed"),
              let statusPublished = boolParam(req, "status_published") else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "layout publication state is required")); return
        }
        writeResponse(req.id, result: [
            "publish": shouldPublishLayoutStatus(
                protocolReady: protocolReady,
                targetObserved: targetObserved,
                statusPublished: statusPublished
            ),
        ], error: nil)
    case "normalize-ax-candidates":
        guard let rawCandidates = req.params?["candidates"]?.value as? [Any] else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "candidates are required")); return
        }
        var descriptors: [AXControlDescriptor] = []
        for raw in rawCandidates {
            guard let candidate = raw as? [String: Any],
                  let role = candidate["role"] as? String,
                  let label = candidate["label"] as? String,
                  let description = candidate["description"] as? String,
                  let actions = candidate["actions"] as? [String],
                  let frame = rectArray(candidate["frame"]) else {
                writeResponse(req.id, result: nil, error: ("invalid_argument", "candidate metadata is invalid")); return
            }
            switch normalizedAXDescriptor(
                role: role,
                subrole: candidate["subrole"] as? String ?? "",
                label: label,
                description: description,
                actions: actions,
                screenFrame: frame
            ) {
            case .secure:
                writeResponse(req.id, result: nil, error: ("secure_text_field", "Secure controls cannot be inspected")); return
            case .descriptor(let descriptor):
                descriptors.append(descriptor)
            }
        }
        guard let descriptor = nearestActionableDescriptor(descriptors) else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "at least one candidate is required")); return
        }
        writeResponse(req.id, result: [
            "role": descriptor.role,
            "label": descriptor.label,
            "description": descriptor.description,
            "actions": descriptor.actions,
            "verifiedActionable": descriptor.verifiedActionable,
        ], error: nil)
    case "map-api-frame":
        guard let screenFrame = rectArray(req.params?["screen_frame"]?.value),
              let captureFrame = rectArray(req.params?["capture_frame"]?.value),
              let apiWidth = intParam(req, "api_width"),
              let apiHeight = intParam(req, "api_height"),
              let frame = apiFrame(
                screenFrame: screenFrame,
                captureFrame: captureFrame,
                apiWidth: apiWidth,
                apiHeight: apiHeight
              ) else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "frame does not intersect the capture")); return
        }
        writeResponse(req.id, result: apiGeometryPayload(frame), error: nil)
    case "resolve-installed-candidates", "resolve-launch-poll-selector":
        guard let selector = stringParam(req, "selector"),
              let rawCandidates = req.params?["candidates"]?.value as? [Any] else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "selector and candidates are required")); return
        }
        let candidates = rawCandidates.compactMap { raw -> InstalledAppCandidate? in
            guard let value = raw as? [String: Any],
                  let bundleId = value["bundle_id"] as? String,
                  let displayName = value["display_name"] as? String,
                  let bundleName = value["bundle_name"] as? String,
                  let fileName = value["file_name"] as? String else { return nil }
            return InstalledAppCandidate(
                bundleId: bundleId,
                displayName: displayName,
                bundleName: bundleName,
                fileName: fileName,
                bundleURL: nil
            )
        }
        switch selectInstalledApplication(selector: selector, candidates: candidates) {
        case .resolved(let candidate):
            if req.method == "resolve-launch-poll-selector" {
                writeResponse(req.id, result: ["pollSelector": candidate.bundleId], error: nil)
            } else {
                writeResponse(req.id, result: [
                    "status": "resolved",
                    "bundleId": candidate.bundleId,
                    "name": candidate.displayName,
                ], error: nil)
            }
        case .ambiguous:
            writeResponse(req.id, result: ["status": "ambiguous"], error: nil)
        case .missing:
            writeResponse(req.id, result: ["status": "missing"], error: nil)
        }
    case "default-button-match":
        writeResponse(
            req.id,
            result: [
                "matches": defaultButtonMetadataMatches(
                    key: stringParam(req, "key") ?? "",
                    expectedLabel: stringParam(req, "expected_default_button_label"),
                    actualLabel: stringParam(req, "actual_default_button_label") ?? ""
                ),
            ],
            error: nil
        )
    case "authorize-effect", "authorize-effect-after-wait":
        if req.method == "authorize-effect-after-wait" {
            guard let duration = doubleParam(req, "duration"), duration > 0 else {
                writeResponse(req.id, result: nil, error: ("invalid_argument", "duration is required")); return
            }
            Thread.sleep(forTimeInterval: duration)
        }
        let screenRecordingGranted = boolParam(req, "contract_screen_recording") ?? false
        if let failure = authorizeNativeEffect(
            req,
            requiredTier: .clickOnly,
            screenRecordingGranted: screenRecordingGranted
        ) {
            writeResponse(req.id, result: nil, error: failure.response)
        } else {
            writeResponse(req.id, result: ["performed": true], error: nil)
        }
    case "cancellable-wait":
        guard let duration = doubleParam(req, "duration"), duration > 0 else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "duration is required")); return
        }
        if cancellableSleep(duration) {
            writeResponse(req.id, result: ["performed": true], error: nil)
        } else {
            writeResponse(req.id, result: nil, error: ("aborted", "Capability revoked during contract wait"))
        }
    case "classify-hard-block":
        writeResponse(
            req.id,
            result: [
                "blocked": isHardBlocked(
                    bundleId: stringParam(req, "bundle_id"),
                    name: stringParam(req, "display_name")
                ),
            ],
            error: nil
        )
    case "classify-sensitive-role":
        writeResponse(
            req.id,
            result: [
                "sensitive": isSecureRole(
                    stringParam(req, "role") ?? "",
                    stringParam(req, "subrole") ?? ""
                ),
            ],
            error: nil
        )
    case "capture-window-frame-eligible":
        guard let frame = intArrayParam(req, "frame", count: 4) else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "frame requires four integers")); return
        }
        writeResponse(
            req.id,
            result: ["eligible": isEligibleCaptureFrame(CGRect(x: frame[0], y: frame[1], width: frame[2], height: frame[3]))],
            error: nil
        )
    case "screenshot", "get-app-state":
        guard hasApp else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "screenshot requires app")); return
        }
        writeResponse(req.id, result: contractScreenshotResult(), error: nil)
    case "inspect-pointer":
        guard hasApp, hasPoint else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "inspect-pointer requires app, x, and y")); return
        }
        writeResponse(
            req.id,
            result: ["role": "AXButton", "label": "Contract button", "description": "Contract target"],
            error: nil
        )
    case "inspect-keyboard-target":
        guard hasApp else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "inspect-keyboard-target requires app")); return
        }
        writeResponse(
            req.id,
            result: [
                "role": "AXTextField",
                "label": "Contract field",
                "description": "Contract keyboard target",
                "defaultButtonLabel": "Send",
                "contentState": "non_empty",
                "selectionState": "selected",
            ],
            error: nil
        )
    case "zoom":
        guard hasApp, rectParam(req, "capture_frame") != nil else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "zoom requires a positive capture frame")); return
        }
        writeResponse(req.id, result: contractScreenshotResult(), error: nil)
    case "left-click", "right-click", "middle-click", "double-click", "triple-click", "mouse-move", "left-mouse-down", "left-mouse-up":
        guard hasApp, hasPoint else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "pointer action requires app, x, and y")); return
        }
        writeResponse(req.id, result: ["performed": true], error: nil)
    case "left-click-drag":
        guard hasApp, hasPoint, intParam(req, "start_x") != nil, intParam(req, "start_y") != nil else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "drag requires start and end coordinates")); return
        }
        writeResponse(req.id, result: ["performed": true], error: nil)
    case "type-text":
        guard hasKeyboardPreflightState(req) else {
            writeResponse(req.id, result: nil, error: ("preflight_required", "Typing requires verified content and selection state")); return
        }
        guard hasApp, let text = stringParam(req, "text"), !text.isEmpty else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "type requires text")); return
        }
        writeResponse(req.id, result: ["performed": true, "characters": text.count], error: nil)
    case "press-key", "hotkey":
        guard hasApp, stringParam(req, "key")?.isEmpty == false else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "key action requires key")); return
        }
        writeResponse(req.id, result: ["performed": true], error: nil)
    case "hold-key":
        guard hasApp, stringParam(req, "key")?.isEmpty == false,
              let duration = doubleParam(req, "duration"), (0.1...60).contains(duration) else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "hold-key requires key and bounded duration")); return
        }
        writeResponse(req.id, result: ["performed": true], error: nil)
    case "scroll":
        let directions = ["up", "down", "left", "right"]
        guard hasApp, hasPoint, let direction = stringParam(req, "direction"), directions.contains(direction),
              let amount = intParam(req, "amount"), (1...100).contains(amount) else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "scroll requires coordinates, direction, and bounded amount")); return
        }
        writeResponse(req.id, result: ["performed": true], error: nil)
    case "wait":
        guard let duration = doubleParam(req, "duration"), (0.1...60).contains(duration) else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "wait requires bounded duration")); return
        }
        writeResponse(req.id, result: ["performed": true], error: nil)
    default:
        writeResponse(req.id, result: nil, error: ("unknown_method", "Unknown method: \(req.method)"))
    }
}

func handle(_ req: Request) {
    if !preConsentMethods.contains(req.method), let failure = authorizeNativeRequest(req) {
        writeResponse(req.id, result: nil, error: failure.response)
        return
    }
    switch req.method {
    case "capabilities":
        var caps: [String: Any] = [:]
        caps["commands"] = [
            "list-apps", "resolve-app", "launch-app", "list-windows", "get-app-state",
            "screenshot", "click", "left-click", "right-click", "middle-click", "double-click",
            "triple-click", "type-text", "press-key", "hotkey", "hold-key", "mouse-move", "scroll",
            "left-click-drag", "left-mouse-down", "left-mouse-up", "wait", "zoom",
            "inspect-pointer", "inspect-keyboard-target", "permissions", "request-permissions",
        ]
        caps["hard_blocked_bundles"] = Array(HARD_BLOCKED_BUNDLE_IDS).sorted()
        caps["hotkey_denylist"] = Array(HOTKEY_DENYLIST).sorted()
        writeResponse(req.id, result: caps, error: nil)

    case "list-apps":
        let apps = listApps()
        writeResponse(req.id, result: ["apps": apps.map { [
            "bundleId": $0.bundleId as Any,
            "name": $0.name,
            "iconBase64": $0.iconBase64 as Any,
            "pid": $0.pid,
            "isFrontmost": $0.isFrontmost,
            "visibleWindowCount": $0.visibleWindowCount,
        ] }], error: nil)

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
            let app = try launchApp(selector, request: req)
            writeMutationSuccess(
                req,
                result: [
                    "bundleId": app.bundleIdentifier as Any,
                    "name": app.localizedName as Any,
                    "pid": Int(app.processIdentifier),
                ]
            )
        } catch let failure as NativeAuthorizationFailure {
            writeResponse(req.id, result: nil, error: failure.response)
        } catch {
            writeResponse(req.id, result: nil, error: ("app_not_found", error.localizedDescription))
        }

    case "list-windows":
        // P0.1 stub: return empty until AX window enumeration lands.
        writeResponse(req.id, result: ["windows": []], error: nil)

    case "get-app-state", "screenshot", "zoom":
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
        if intParam(req, "expected_pid") != nil && !expectedTargetMatches(req, app: app) {
            writeResponse(req.id, result: nil, error: ("stale_state", "The approved window changed after the referenced screenshot"))
            return
        }
        if hasSensitiveWindow(app) { writeResponse(req.id, result: nil, error: ("scope_denied", "Sensitive window is visible in the authorized app")); return }
        let zoomCaptureFrame = req.method == "zoom" ? rectParam(req, "capture_frame") : nil
        if req.method == "zoom" && zoomCaptureFrame == nil {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "zoom requires a positive capture frame"))
            return
        }
        let nodes = buildTree(AXUIElementCreateApplication(app.processIdentifier))
        let noScreenshot = req.method == "zoom"
            ? false
            : (req.params?["no_screenshot"]?.value as? Bool ?? true)
        var state: [String: Any] = [
            "tree": nodes.map(\.line).joined(separator: "\n"),
            "elementCount": nodes.count,
            "scale": 2,
            "tree_truncated": nodes.count >= 400,
        ]
        if !noScreenshot {
            if intParam(req, "expected_pid") != nil && !expectedTargetMatches(req, app: app) {
                writeResponse(req.id, result: nil, error: ("stale_state", "The approved window changed before capture"))
                return
            }
            if let screenshot = captureAuthorizedWindow(request: req, app, captureFrame: zoomCaptureFrame) {
                state.merge(screenshot) { _, new in new }
                if let captureFrame = dictionaryRect(state["capture_frame"]),
                   let apiWidth = state["screenshot_width"] as? Int,
                   let apiHeight = state["screenshot_height"] as? Int {
                    state["interactive_elements"] = interactiveElements(
                        nodes: nodes,
                        captureFrame: captureFrame,
                        apiWidth: apiWidth,
                        apiHeight: apiHeight
                    )
                }
            } else {
                writeResponse(
                    req.id,
                    result: nil,
                    error: ("screen_capture_failed", "Screen Recording permission is missing or the approved window could not be captured safely")
                )
                return
            }
        }
        writeResponse(req.id, result: state, error: nil)

    case "inspect-pointer":
        guard let (_, point) = verifiedPointerContext(req, requiredTier: .viewOnly) else {
            writeResponse(req.id, result: nil, error: ("scope_denied", "Pointer target is outside the authorized foreground application")); return
        }
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(
            AXUIElementCreateSystemWide(),
            Float(point.x),
            Float(point.y),
            &hit
        ) == .success, let hit else {
            writeResponse(req.id, result: nil, error: ("scope_denied", "Could not inspect pointer target")); return
        }
        let descriptor: AXControlDescriptor
        switch actionableDescriptor(from: hit) {
        case .secure:
            writeResponse(req.id, result: nil, error: ("secure_text_field", "Secure controls cannot be inspected")); return
        case .descriptor(let resolved):
            descriptor = resolved
        }
        guard authorizeNativeEffect(req, requiredTier: .viewOnly) == nil else {
            writeResponse(req.id, result: nil, error: ("session_revoked", "Computer Use authority changed during pointer inspection")); return
        }
        writeResponse(
            req.id,
            result: [
                "role": descriptor.role,
                "label": descriptor.label,
                "description": descriptor.description,
                "actions": descriptor.actions,
                "verifiedActionable": descriptor.verifiedActionable,
            ],
            error: nil
        )

    case "inspect-keyboard-target":
        guard let (_, focused) = verifiedKeyboardContext(req, requiredTier: .viewOnly) else {
            writeResponse(req.id, result: nil, error: ("scope_denied", "Keyboard target is outside the authorized foreground application or is secure")); return
        }
        guard authorizeNativeEffect(req, requiredTier: .viewOnly) == nil else {
            writeResponse(req.id, result: nil, error: ("session_revoked", "Computer Use authority changed during keyboard inspection")); return
        }
        writeResponse(req.id, result: keyboardTargetPayload(focused), error: nil)

    case "left-click", "right-click", "middle-click", "double-click", "triple-click", "mouse-move":
        guard let (_, point) = verifiedPointerContext(req, requiredTier: .clickOnly) else {
            writeResponse(req.id, result: nil, error: ("scope_denied", "Pointer target is outside the authorized foreground application")); return
        }
        let performed: Bool
        switch req.method {
        case "mouse-move":
            performed = postAuthorizedEvent(
                CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
                request: req,
                requiredTier: .clickOnly
            )
        case "right-click": performed = postMouseClick(point, button: .right, count: 1, request: req)
        case "middle-click": performed = postMouseClick(point, button: .center, count: 1, request: req)
        case "double-click": performed = postMouseClick(point, button: .left, count: 2, request: req)
        case "triple-click": performed = postMouseClick(point, button: .left, count: 3, request: req)
        default: performed = postMouseClick(point, button: .left, count: 1, request: req)
        }
        guard performed else {
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped before the pointer action completed")); return
        }
        writeMutationSuccess(req, result: ["performed": true])

    case "left-click-drag":
        guard AXIsProcessTrusted(), let selector = stringParam(req, "app"), let app = resolveRunningApp(selector),
              expectedTargetMatches(req, app: app),
              let startX = intParam(req, "start_x"), let startY = intParam(req, "start_y"),
              let endX = intParam(req, "x"), let endY = intParam(req, "y") else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "drag requires app, start_x, start_y, x, and y")); return
        }
        let start = CGPoint(x: startX, y: startY), end = CGPoint(x: endX, y: endY)
        guard activateAuthorizedApp(app, request: req, requiredTier: .clickOnly) else {
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped before drag focus")); return
        }
        usleep(120_000)
        guard expectedTargetMatches(req, app: app), !hasSensitiveWindow(app),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
              pointBelongsToApp(start, app: app), pointBelongsToApp(end, app: app) else {
            writeResponse(req.id, result: nil, error: ("scope_denied", "Drag endpoints must belong to the authorized foreground application")); return
        }
        guard postAuthorizedEvent(
            CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left),
            request: req,
            requiredTier: .clickOnly
        ) else {
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped before drag")); return
        }
        let steps = 12
        for step in 1...steps {
            let progress = CGFloat(step) / CGFloat(steps)
            let point = CGPoint(x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress)
            guard postAuthorizedEvent(
                CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left),
                request: req,
                requiredTier: .clickOnly
            ), cancellableSleep(0.012) else {
                postSafetyReleaseEvent(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
                writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped during drag")); return
            }
        }
        guard postAuthorizedEvent(
            CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left),
            request: req,
            requiredTier: .clickOnly
        ) else {
            postSafetyReleaseEvent(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left))
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped before completing drag")); return
        }
        writeMutationSuccess(req, result: ["performed": true])

    case "left-mouse-down":
        guard let (_, point) = verifiedPointerContext(req, requiredTier: .clickOnly) else {
            writeResponse(req.id, result: nil, error: ("scope_denied", "Mouse-down target is outside the authorized foreground application")); return
        }
        guard postAuthorizedEvent(
            CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
            request: req,
            requiredTier: .clickOnly
        ) else {
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped before mouse-down")); return
        }
        actionCancellationLock.lock()
        heldLeftMousePoint = point
        actionCancellationLock.unlock()
        writeMutationSuccess(req, result: ["performed": true])

    case "left-mouse-up":
        actionCancellationLock.lock()
        let heldPoint = heldLeftMousePoint
        actionCancellationLock.unlock()
        guard let heldPoint, let (_, point) = verifiedPointerContext(req, requiredTier: .clickOnly),
              hypot(point.x - heldPoint.x, point.y - heldPoint.y) <= 1 else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "No verified mouse-down is active")); return
        }
        guard postAuthorizedEvent(
            CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left),
            request: req,
            requiredTier: .clickOnly
        ) else {
            postSafetyReleaseEvent(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped before mouse-up")); return
        }
        actionCancellationLock.lock()
        heldLeftMousePoint = nil
        actionCancellationLock.unlock()
        writeMutationSuccess(req, result: ["performed": true])

    case "click":
        guard AXIsProcessTrusted(), let selector = stringParam(req, "app"), let app = resolveRunningApp(selector),
              expectedTargetMatches(req, app: app) else {
            writeResponse(req.id, result: nil, error: ("accessibility_error", "Target app or Accessibility permission unavailable")); return
        }
        if hasSensitiveWindow(app) { writeResponse(req.id, result: nil, error: ("scope_denied", "Sensitive window is visible in the authorized app")); return }
        guard activateAuthorizedApp(app, request: req, requiredTier: .clickOnly) else {
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped before click focus")); return
        }
        usleep(120_000)
        guard expectedTargetMatches(req, app: app),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
            writeResponse(req.id, result: nil, error: ("window_not_focused", "Authorized application is not frontmost")); return
        }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        if let index = intParam(req, "element_index") {
            let nodes = buildTree(root)
            guard nodes.indices.contains(index) else { writeResponse(req.id, result: nil, error: ("element_not_found", "Element index is stale")); return }
            if !performAuthorizedAXAction(
                nodes[index].element,
                action: kAXPressAction as CFString,
                request: req,
                requiredTier: .clickOnly
            ), let frame = axFrame(nodes[index].element), !postClick(CGPoint(x: frame.midX, y: frame.midY), request: req) {
                writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped before click")); return
            }
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
            guard postClick(point, request: req) else {
                writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped before click")); return
            }
        } else { writeResponse(req.id, result: nil, error: ("invalid_argument", "click requires element_index or x/y")); return }
        writeMutationSuccess(req, result: ["performed": true])

    case "type-text":
        guard hasKeyboardPreflightState(req) else {
            writeResponse(req.id, result: nil, error: ("preflight_required", "Typing requires verified content and selection state")); return
        }
        guard let (_, _) = verifiedKeyboardContext(req, requiredTier: .fullControl), let text = stringParam(req, "text") else {
            writeResponse(req.id, result: nil, error: ("accessibility_error", "Authorized target app, Accessibility permission, or text missing")); return
        }
        guard typeUnicode(text, request: req) else {
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped before typing")); return
        }
        writeMutationSuccess(req, result: ["performed": true, "characters": text.count])

    case "press-key", "hotkey":
        guard let key = stringParam(req, "key"),
              let (_, focused) = verifiedKeyboardContext(req, requiredTier: .fullControl) else {
            writeResponse(req.id, result: nil, error: ("scope_denied", "Authorized keyboard target, permission, or key is missing")); return
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
        guard postKey(baseKey, modifiers: modifiers, request: req, focused: focused) else {
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped or the verified keyboard target changed before key press")); return
        }
        writeMutationSuccess(req, result: ["performed": true])

    case "hold-key":
        guard AXIsProcessTrusted(), let selector = stringParam(req, "app"), let app = resolveRunningApp(selector),
              expectedTargetMatches(req, app: app),
              let key = stringParam(req, "key"), let duration = doubleParam(req, "duration"),
              (0.1...60).contains(duration), let code = KEY_CODES[key.lowercased()] else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "hold-key requires a supported key and duration from 0.1 to 60 seconds")); return
        }
        guard activateAuthorizedApp(app, request: req, requiredTier: .fullControl) else {
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped before hold-key focus")); return
        }
        usleep(120_000)
        guard !hasSensitiveWindow(app), NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
            writeResponse(req.id, result: nil, error: ("scope_denied", "Authorized application is not a safe foreground target")); return
        }
        guard let (_, focused) = verifiedKeyboardContext(req, requiredTier: .fullControl),
              defaultButtonMatchesExpected(req, focused: focused, key: key),
              let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              postAuthorizedEvent(down, request: req, requiredTier: .fullControl) else {
            writeResponse(req.id, result: nil, error: ("scope_denied", "Authorized keyboard target is unavailable")); return
        }
        actionCancellationLock.lock()
        heldKeyCode = code
        actionCancellationLock.unlock()
        let completed = cancellableSleep(duration)
        postSafetyReleaseEvent(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false))
        actionCancellationLock.lock()
        heldKeyCode = nil
        actionCancellationLock.unlock()
        guard completed else {
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped while holding the key")); return
        }
        writeMutationSuccess(req, result: ["performed": true])

    case "wait":
        guard let duration = doubleParam(req, "duration"), (0.1...60).contains(duration) else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "wait duration must be from 0.1 to 60 seconds")); return
        }
        guard cancellableSleep(duration) else {
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped while waiting")); return
        }
        writeMutationSuccess(req, result: ["performed": true])

    case "scroll":
        guard AXIsProcessTrusted(), let selector = stringParam(req, "app"), let app = resolveRunningApp(selector),
              expectedTargetMatches(req, app: app),
              let x = intParam(req, "x"), let y = intParam(req, "y"), let direction = stringParam(req, "direction") else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "scroll requires authorized app, x, y, and direction")); return
        }
        if hasSensitiveWindow(app) { writeResponse(req.id, result: nil, error: ("scope_denied", "Sensitive window is visible in the authorized app")); return }
        guard activateAuthorizedApp(app, request: req, requiredTier: .clickOnly) else {
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped before scroll focus")); return
        }
        usleep(120_000)
        let point = CGPoint(x: x, y: y)
        var hit: AXUIElement?
        guard expectedTargetMatches(req, app: app),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier,
              AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &hit) == .success, let hit else {
            writeResponse(req.id, result: nil, error: ("scope_denied", "Could not verify scroll target")); return
        }
        var hitPid: pid_t = 0; AXUIElementGetPid(hit, &hitPid)
        guard hitPid == app.processIdentifier else { writeResponse(req.id, result: nil, error: ("scope_denied", "Scroll target belongs to another application")); return }
        let amount = max(1, min(100, intParam(req, "amount") ?? 6))
        let vertical = direction.lowercased() == "up" ? amount : direction.lowercased() == "down" ? -amount : 0
        let horizontal = direction.lowercased() == "left" ? amount : direction.lowercased() == "right" ? -amount : 0
        guard vertical != 0 || horizontal != 0,
              let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(vertical), wheel2: Int32(horizontal), wheel3: 0) else {
            writeResponse(req.id, result: nil, error: ("invalid_argument", "direction must be up, down, left, or right")); return
        }
        event.location = point
        guard postAuthorizedEvent(event, request: req, requiredTier: .clickOnly) else {
            writeResponse(req.id, result: nil, error: ("aborted", "Computer Use stopped before scroll")); return
        }
        writeMutationSuccess(req, result: ["performed": true])

    case "permissions":
        let trusted = AXIsProcessTrusted()
        writeResponse(req.id, result: [
            "accessibility": trusted ? "granted" : "missing",
            "screenRecording": CGPreflightScreenCaptureAccess() ? "granted" : "missing",
        ] as [String: Any], error: nil)

    case "request-permissions":
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        let screenRecording = requestScreenCaptureAccess()
        writeResponse(req.id, result: [
            "accessibility": trusted ? "granted" : "missing",
            "screenRecording": screenRecording ? "granted" : "missing",
        ] as [String: Any], error: nil)

    default:
        writeResponse(req.id, result: nil, error: ("unknown_method", "Unknown method: \(req.method)"))
    }
}

/// Register the real app-bundle identity with Screen Recording TCC.
///
/// On current macOS versions a Unix-style executable inside an `.app` may be
/// ignored by the legacy CoreGraphics request until it has initialized an
/// AppKit application connection. ScreenCaptureKit is the supported capture
/// surface and also causes TCC to register the calling bundle. The agent stays
/// UI-less because `.accessory` never creates a Dock or app-switcher entry.
private func requestScreenCaptureAccess() -> Bool {
    if CGPreflightScreenCaptureAccess() { return true }

    let agentApplication = NSApplication.shared
    _ = agentApplication.setActivationPolicy(.accessory)

    if #available(macOS 12.3, *) {
        guard let content = shareableScreenContent(),
              let display = content.displays.first else {
            let requested = CGRequestScreenCaptureAccess()
            NSLog("Verboo Computer Use: legacy Screen Recording request after missing shareable content returned %@", requested.description)
            return CGPreflightScreenCaptureAccess()
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.showsCursor = false

        let permissionCapture = OneFrameCapture()
        _ = permissionCapture.capture(filter: filter, configuration: configuration)
        if CGPreflightScreenCaptureAccess() { return true }
    }

    let requested = CGRequestScreenCaptureAccess()
    NSLog("Verboo Computer Use: legacy Screen Recording fallback returned %@", requested.description)
    return CGPreflightScreenCaptureAccess()
}

// MARK: - Stdio loop

func runEmergencyMonitor() {
    guard let capabilityFlag = CommandLine.arguments.firstIndex(of: "--monitor-capability"),
          CommandLine.arguments.indices.contains(capabilityFlag + 1) else {
        FileHandle.standardError.write(Data("Missing emergency monitor capability path\n".utf8))
        exit(2)
    }
    let capabilityPath = CommandLine.arguments[capabilityFlag + 1]
    guard FileManager.default.fileExists(atPath: capabilityPath) else {
        exit(0)
    }

    // The desktop owns the write end of stdin. EOF is an unforgeable process
    // lifeline: if the desktop crashes, the orphan monitor exits and releases
    // the global Esc registration without trusting a persisted PID.
    FileHandle.standardInput.readabilityHandler = { handle in
        if handle.availableData.isEmpty {
            exit(0)
        }
    }

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
    guard RegisterEventHotKey(UInt32(kVK_Escape), 0, hotKeyId, GetApplicationEventTarget(), 0, &hotKey) == noErr else {
        FileHandle.standardError.write(Data("Unable to register emergency hotkey\n".utf8))
        exit(2)
    }
    FileHandle.standardOutput.write(Data("{\"event\":\"monitor-ready\"}\n".utf8))
    fflush(stdout)
    let capabilityTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
        if !FileManager.default.fileExists(atPath: capabilityPath) {
            exit(0)
        }
    }
    RunLoop.main.add(capabilityTimer, forMode: .common)
    RunLoop.main.run()
}

// MARK: - Focus HUD and display-scoped isolation

private struct FocusCapability: Decodable {
    let expiresAt: UInt64
    let paused: Bool
    let approvedApps: [FocusApprovedApp]
    let isolateOtherApps: Bool
    let selfTestEnabled: Bool
    let controllerPid: pid_t?
    let compactLayout: Bool
    let compactPanelWidth: Int
    let focusRequestGeneration: UInt64

    enum CodingKeys: String, CodingKey {
        case expiresAt = "expires_at"
        case paused
        case approvedApps = "approved_apps"
        case isolateOtherApps = "isolate_other_apps"
        case selfTestEnabled = "self_test_enabled"
        case controllerPid = "controller_pid"
        case compactLayout = "compact_layout"
        case compactPanelWidth = "compact_panel_width"
        case focusRequestGeneration = "focus_request_generation"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        expiresAt = try container.decode(UInt64.self, forKey: .expiresAt)
        paused = try container.decode(Bool.self, forKey: .paused)
        approvedApps = try container.decodeIfPresent([FocusApprovedApp].self, forKey: .approvedApps) ?? []
        isolateOtherApps = try container.decodeIfPresent(Bool.self, forKey: .isolateOtherApps) ?? true
        selfTestEnabled = try container.decodeIfPresent(Bool.self, forKey: .selfTestEnabled) ?? false
        let decodedControllerPid = try container.decodeIfPresent(Int64.self, forKey: .controllerPid)
        controllerPid = decodedControllerPid.flatMap(validatedRestorePid)
        compactLayout = try container.decodeIfPresent(Bool.self, forKey: .compactLayout) ?? false
        compactPanelWidth = try container.decodeIfPresent(Int.self, forKey: .compactPanelWidth) ?? 420
        focusRequestGeneration = try container.decodeIfPresent(UInt64.self, forKey: .focusRequestGeneration) ?? 0
    }
}

private struct FocusApprovedApp: Decodable {
    let bundleId: String

    enum CodingKeys: String, CodingKey {
        case bundleId = "bundle_id"
    }
}

private struct FocusCommit: Decodable {
    let event: String
    let generation: String
}

private struct FocusScreen {
    let screen: NSScreen
    let axFrame: CGRect
}

private enum FocusMutationKind: String, Codable {
    case minimized
    case frame
}

private struct CodableRect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ frame: CGRect) {
        x = frame.minX
        y = frame.minY
        width = frame.width
        height = frame.height
    }

    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

private struct FocusRestoreRecord: Codable {
    let kind: FocusMutationKind
    let pid: Int64
    let bundleId: String?
    let launchTimeMillis: Int64?
    let title: String
    let originalFrame: CodableRect?
    let appliedFrame: CodableRect?

    private enum CodingKeys: String, CodingKey {
        case kind, pid, bundleId, launchTimeMillis, title, originalFrame, appliedFrame
        case x, y, width, height
    }

    init(
        kind: FocusMutationKind,
        pid: Int64,
        bundleId: String?,
        launchTimeMillis: Int64?,
        title: String,
        originalFrame: CodableRect?,
        appliedFrame: CodableRect?
    ) {
        self.kind = kind
        self.pid = pid
        self.bundleId = bundleId
        self.launchTimeMillis = launchTimeMillis
        self.title = title
        self.originalFrame = originalFrame
        self.appliedFrame = appliedFrame
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decodeIfPresent(FocusMutationKind.self, forKey: .kind) ?? .minimized
        pid = try container.decode(Int64.self, forKey: .pid)
        bundleId = try container.decodeIfPresent(String.self, forKey: .bundleId)
        launchTimeMillis = try container.decodeIfPresent(Int64.self, forKey: .launchTimeMillis)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        if let original = try container.decodeIfPresent(CodableRect.self, forKey: .originalFrame) {
            originalFrame = original
        } else if let x = try container.decodeIfPresent(Double.self, forKey: .x),
                  let y = try container.decodeIfPresent(Double.self, forKey: .y),
                  let width = try container.decodeIfPresent(Double.self, forKey: .width),
                  let height = try container.decodeIfPresent(Double.self, forKey: .height) {
            originalFrame = CodableRect(CGRect(x: x, y: y, width: width, height: height))
        } else {
            originalFrame = nil
        }
        appliedFrame = try container.decodeIfPresent(CodableRect.self, forKey: .appliedFrame)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(pid, forKey: .pid)
        try container.encodeIfPresent(bundleId, forKey: .bundleId)
        try container.encodeIfPresent(launchTimeMillis, forKey: .launchTimeMillis)
        try container.encode(title, forKey: .title)
        try container.encodeIfPresent(originalFrame, forKey: .originalFrame)
        try container.encodeIfPresent(appliedFrame, forKey: .appliedFrame)
    }
}

private func focusRestoreRecord(
    window: AXUIElement,
    app: NSRunningApplication
) -> FocusRestoreRecord? {
    guard let frame = axFrame(window),
          let bundleId = app.bundleIdentifier,
          let launchDate = app.launchDate else { return nil }
    return FocusRestoreRecord(
        kind: .minimized,
        pid: Int64(app.processIdentifier),
        bundleId: bundleId,
        launchTimeMillis: Int64((launchDate.timeIntervalSince1970 * 1_000).rounded()),
        title: axString(window, kAXTitleAttribute as CFString) ?? "",
        originalFrame: CodableRect(frame),
        appliedFrame: nil
    )
}

private func focusFrameRestoreRecord(
    window: AXUIElement,
    app: NSRunningApplication,
    appliedFrame: CGRect
) -> FocusRestoreRecord? {
    guard let originalFrame = axFrame(window),
          let bundleId = app.bundleIdentifier,
          let launchDate = app.launchDate else { return nil }
    return FocusRestoreRecord(
        kind: .frame,
        pid: Int64(app.processIdentifier),
        bundleId: bundleId,
        launchTimeMillis: Int64((launchDate.timeIntervalSince1970 * 1_000).rounded()),
        title: axString(window, kAXTitleAttribute as CFString) ?? "",
        originalFrame: CodableRect(originalFrame),
        appliedFrame: CodableRect(appliedFrame)
    )
}

private func validatedRestorePid(_ value: Int64) -> pid_t? {
    guard value > 1, value <= Int64(Int32.max) else { return nil }
    return pid_t(value)
}

private func launchTimeMillis(_ app: NSRunningApplication) -> Int64? {
    app.launchDate.map { Int64(($0.timeIntervalSince1970 * 1_000).rounded()) }
}

private func confirmWindowIsUnminimized(
    _ window: AXUIElement,
    timeout: TimeInterval = 0.5
) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if boolAttribute(window, kAXMinimizedAttribute as CFString) == false {
            return true
        }
        Thread.sleep(forTimeInterval: 0.02)
    } while Date() < deadline
    return boolAttribute(window, kAXMinimizedAttribute as CFString) == false
}

private func setAccessibilityFrame(_ window: AXUIElement, frame: CGRect) -> Bool {
    var size = frame.size
    var position = frame.origin
    guard let sizeValue = AXValueCreate(.cgSize, &size),
          let positionValue = AXValueCreate(.cgPoint, &position),
          AXUIElementSetAttributeValue(
            window,
            kAXSizeAttribute as CFString,
            sizeValue
          ) == .success,
          AXUIElementSetAttributeValue(
            window,
            kAXPositionAttribute as CFString,
            positionValue
          ) == .success else { return false }
    let deadline = Date().addingTimeInterval(0.6)
    repeat {
        if let observed = axFrame(window), framesMatch(observed, frame) { return true }
        Thread.sleep(forTimeInterval: 0.02)
    } while Date() < deadline
    return axFrame(window).map { framesMatch($0, frame) } ?? false
}

private func syncFocusRestoreDirectory(_ directoryURL: URL) throws {
    let descriptor = open(directoryURL.path, O_RDONLY)
    guard descriptor >= 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    defer { close(descriptor) }
    guard fsync(descriptor) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
}

private func writeFocusRestoreRecords(_ records: [FocusRestoreRecord], to url: URL) throws {
    let fileManager = FileManager.default
    let directoryURL = url.deletingLastPathComponent()
    try fileManager.createDirectory(
        at: directoryURL,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directoryURL.path)

    if records.isEmpty {
        if fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
            try syncFocusRestoreDirectory(directoryURL)
        }
        return
    }
    let data = try JSONEncoder().encode(records)
    let temporary = directoryURL
        .appendingPathComponent(".focus-restore-\(UUID().uuidString).tmp")
    do {
        try data.write(to: temporary)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        let handle = try FileHandle(forWritingTo: temporary)
        try handle.synchronize()
        try handle.close()
        guard rename(temporary.path, url.path) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        try syncFocusRestoreDirectory(directoryURL)
    } catch {
        try? fileManager.removeItem(at: temporary)
        throw error
    }
}

@discardableResult
private func restorePersistedFocusWindows(at url: URL) -> Bool {
    guard FileManager.default.fileExists(atPath: url.path) else { return true }
    let records: [FocusRestoreRecord]
    do {
        records = try JSONDecoder().decode(
            [FocusRestoreRecord].self,
            from: Data(contentsOf: url)
        )
    } catch {
        FileHandle.standardError.write(
            Data("Unable to decode persisted focus restoration state: \(error)\n".utf8)
        )
        return false
    }
    var unresolved: [FocusRestoreRecord] = []
    for record in records {
        guard let pid = validatedRestorePid(record.pid) else {
            unresolved.append(record)
            continue
        }
        guard let app = NSRunningApplication(processIdentifier: pid) else { continue }
        guard let expectedBundleId = record.bundleId,
              app.bundleIdentifier?.caseInsensitiveCompare(expectedBundleId) == .orderedSame,
              let expectedLaunchTime = record.launchTimeMillis,
              launchTimeMillis(app) == expectedLaunchTime else {
            // Preserve the record but never apply it when process identity is
            // incomplete or the PID has been reused by another launch.
            unresolved.append(record)
            continue
        }
        guard let originalFrame = record.originalFrame?.cgRect else {
            unresolved.append(record)
            continue
        }
        let candidates = applicationWindows(app).filter {
            (axString($0, kAXTitleAttribute as CFString) ?? "") == record.title
        }
        switch record.kind {
        case .minimized:
            let matching = candidates.filter {
                guard let frame = axFrame($0) else { return false }
                return framesMatch(frame, originalFrame, tolerance: 8)
            }
            guard matching.count == 1,
                  let window = matching.first,
                  let isMinimized = boolAttribute(window, kAXMinimizedAttribute as CFString) else {
                unresolved.append(record)
                continue
            }
            // The record is persisted before minimization. An already visible
            // window means the mutation never happened and the record retires.
            guard isMinimized else { continue }
            if AXUIElementSetAttributeValue(
                window,
                kAXMinimizedAttribute as CFString,
                kCFBooleanFalse
            ) != .success || !confirmWindowIsUnminimized(window) {
                unresolved.append(record)
            }
        case .frame:
            guard candidates.count == 1,
                  let window = candidates.first,
                  let currentFrame = axFrame(window),
                  let appliedFrame = record.appliedFrame?.cgRect else {
                unresolved.append(record)
                continue
            }
            let decision = restoreFrameDecision(
                pidMatches: true,
                bundleMatches: true,
                launchMatches: true,
                candidateCount: candidates.count,
                currentMatchesOriginal: framesMatch(currentFrame, originalFrame),
                currentMatchesApplied: framesMatch(currentFrame, appliedFrame)
            )
            if decision.retire { continue }
            guard decision.restore, setAccessibilityFrame(window, frame: originalFrame) else {
                unresolved.append(record)
                continue
            }
        }
    }
    do {
        try writeFocusRestoreRecords(unresolved, to: url)
        return unresolved.isEmpty
    } catch {
        FileHandle.standardError.write(
            Data("Unable to persist focus restoration outcome: \(error)\n".utf8)
        )
        return false
    }
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

private struct CompactWindowFrames {
    let targetAXFrame: CGRect
    let controllerAXFrame: CGRect
    let overlayAppKitFrame: CGRect
}

private func compactWindowFrames(
    screenFrame: CGRect,
    visibleFrame: CGRect,
    mainHeight: CGFloat,
    preferredPanelWidth _: CGFloat = 420,
    gap: CGFloat = 12,
    inset: CGFloat = 10
) -> CompactWindowFrames? {
    guard screenFrame.width > 0, screenFrame.height > 0,
          visibleFrame.width > 0, visibleFrame.height >= 560 else { return nil }
    let panelWidth = min(460, max(396, visibleFrame.width * 0.27)).rounded()
    let targetWidth = (visibleFrame.width - inset * 2 - gap - panelWidth).rounded()
    let contentHeight = (visibleFrame.height - inset * 2).rounded()
    guard targetWidth >= 640, contentHeight >= 540 else { return nil }
    let visibleAXMinY = mainHeight - visibleFrame.maxY
    let target = CGRect(
        x: (visibleFrame.minX + inset).rounded(),
        y: (visibleAXMinY + inset).rounded(),
        width: targetWidth,
        height: contentHeight
    )
    let controller = CGRect(
        x: (target.maxX + gap).rounded(),
        y: target.minY,
        width: panelWidth,
        height: contentHeight
    )
    return CompactWindowFrames(
        targetAXFrame: target,
        controllerAXFrame: controller,
        overlayAppKitFrame: screenFrame
    )
}

private func compactWindowFrames(
    screen: NSScreen,
    preferredPanelWidth: CGFloat = 420,
    gap: CGFloat = 12,
    inset: CGFloat = 10
) -> CompactWindowFrames? {
    compactWindowFrames(
        screenFrame: screen.frame,
        visibleFrame: screen.visibleFrame,
        mainHeight: appKitMainHeight(),
        preferredPanelWidth: preferredPanelWidth,
        gap: gap,
        inset: inset
    )
}

private func framesMatch(_ lhs: CGRect, _ rhs: CGRect, tolerance: CGFloat = 2) -> Bool {
    abs(lhs.minX - rhs.minX) <= tolerance
        && abs(lhs.minY - rhs.minY) <= tolerance
        && abs(lhs.width - rhs.width) <= tolerance
        && abs(lhs.height - rhs.height) <= tolerance
}

private func restoreFrameDecision(
    pidMatches: Bool,
    bundleMatches: Bool,
    launchMatches: Bool,
    candidateCount: Int,
    currentMatchesOriginal: Bool,
    currentMatchesApplied: Bool
) -> (restore: Bool, retire: Bool) {
    guard pidMatches, bundleMatches, launchMatches, candidateCount == 1 else {
        return (false, false)
    }
    if currentMatchesOriginal { return (false, true) }
    if currentMatchesApplied { return (true, false) }
    return (false, false)
}

private func shouldApplyCompactLayout(
    previousIdentity: String?,
    currentIdentity: String
) -> Bool {
    previousIdentity != currentIdentity
}

private func shouldActivateTarget(
    previousGeneration: UInt64,
    currentGeneration: UInt64
) -> Bool {
    currentGeneration > previousGeneration
}

private func shouldPublishLayoutStatus(
    protocolReady: Bool,
    targetObserved: Bool,
    statusPublished: Bool
) -> Bool {
    protocolReady && targetObserved && !statusPublished
}

private func intersectionArea(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
    let intersection = lhs.intersection(rhs)
    guard !intersection.isNull else { return 0 }
    return max(0, intersection.width) * max(0, intersection.height)
}

private func isEligibleCaptureFrame(_ frame: CGRect) -> Bool {
    frame.minX.isFinite
        && frame.minY.isFinite
        && frame.width.isFinite
        && frame.height.isFinite
        && frame.width >= 32
        && frame.height >= 32
        && frame.width <= 16_384
        && frame.height <= 16_384
}

private func focusScreen(containing frame: CGRect) -> FocusScreen? {
    NSScreen.screens
        .map { FocusScreen(screen: $0, axFrame: accessibilityFrame(for: $0)) }
        .max { intersectionArea($0.axFrame, frame) < intersectionArea($1.axFrame, frame) }
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
        let focused = focusedRef as! AXUIElement
        if let frame = axFrame(focused), isEligibleCaptureFrame(frame) {
            return focused
        }
    }
    return applicationWindows(app)
        .filter({ boolAttribute($0, kAXMinimizedAttribute as CFString) != true })
        .compactMap({ window in axFrame(window).map { (window, $0) } })
        .filter({ isEligibleCaptureFrame($0.1) })
        .max(by: { $0.1.width * $0.1.height < $1.1.width * $1.1.height })?
        .0
}

private let OVERLAY_CORE_WIDTH: CGFloat = 2.5
private let OVERLAY_MID_GLOW_WIDTH: CGFloat = 12
private let OVERLAY_DIFFUSE_GLOW_WIDTH: CGFloat = 36
private let OVERLAY_BREATH_DURATION: TimeInterval = 8
private let OVERLAY_COLOR_HEX = ["#9355ff", "#a96dff", "#5ed8ef"]

private func overlayPhaseAdvances(paused: Bool, reduceMotion: Bool) -> Bool {
    !paused && !reduceMotion
}

private final class FocusOverlayView: NSView {
    var paused = false
    var reduceMotion = false
    private var phaseSeconds: TimeInterval = 0

    override var isOpaque: Bool { false }

    func advance() {
        guard overlayPhaseAdvances(paused: paused, reduceMotion: reduceMotion) else { return }
        phaseSeconds = (phaseSeconds + 0.12).truncatingRemainder(
            dividingBy: OVERLAY_BREATH_DURATION
        )
        needsDisplay = true
    }

    private func drawGradientStroke(width: CGFloat, opacity: CGFloat) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let ringRect = bounds.insetBy(dx: OVERLAY_DIFFUSE_GLOW_WIDTH / 2 + 2, dy: OVERLAY_DIFFUSE_GLOW_WIDTH / 2 + 2)
        let ring = CGPath(
            roundedRect: ringRect,
            cornerWidth: 18,
            cornerHeight: 18,
            transform: nil
        )
        let stroked = ring.copy(
            strokingWithWidth: width,
            lineCap: .round,
            lineJoin: .round,
            miterLimit: 10
        )
        let colors = [
            NSColor(srgbRed: 147 / 255, green: 85 / 255, blue: 1, alpha: opacity),
            NSColor(srgbRed: 169 / 255, green: 109 / 255, blue: 1, alpha: opacity),
            NSColor(srgbRed: 94 / 255, green: 216 / 255, blue: 239 / 255, alpha: opacity),
        ]
        guard let gradient = NSGradient(colors: colors) else { return }
        context.saveGState()
        context.addPath(stroked)
        context.clip()
        gradient.draw(in: bounds, angle: 0)
        context.restoreGState()
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        NSColor.clear.setFill()
        dirtyRect.fill()

        let phase = phaseSeconds / OVERLAY_BREATH_DURATION * 2 * Double.pi
        let breath = (sin(phase) + 1) * 0.5
        let coreOpacity: CGFloat = paused ? 0.38 : reduceMotion ? 0.68 : 0.58 + breath * 0.14
        drawGradientStroke(width: OVERLAY_DIFFUSE_GLOW_WIDTH, opacity: coreOpacity * 0.08)
        drawGradientStroke(width: OVERLAY_MID_GLOW_WIDTH, opacity: coreOpacity * 0.24)
        drawGradientStroke(width: OVERLAY_CORE_WIDTH, opacity: coreOpacity)
    }
}

private final class FocusSessionController {
    private let selector: String
    private let generation: String
    private let capabilityURL: URL
    private let restoreURL: URL
    private let overlay = FocusOverlayView(frame: .zero)
    private let panel: NSPanel
    private var timer: Timer?
    private var minimizedWindows: [AXUIElement] = []
    private var restoreRecords: [FocusRestoreRecord] = []
    private var isolatedApprovedPids: Set<pid_t> = []
    private var targetApp: NSRunningApplication?
    private var hadTarget = false
    private var protocolReady = false
    private var layoutStatusPublished = false
    private(set) var compactLayoutApplied = false
    private(set) var compactDisplayId: UInt32?
    private var appliedLayoutIdentity: String?
    private var observedFocusRequestGeneration: UInt64 = 0
    private var stopping = false
    private var signalSources: [DispatchSourceSignal] = []

    var targetObserved: Bool { hadTarget }

    init(selector: String, capabilityURL: URL, generation: String) {
        self.selector = selector
        self.generation = generation
        self.capabilityURL = capabilityURL
        restoreURL = capabilityURL.deletingLastPathComponent().appendingPathComponent("focus-restore.json")
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
        panel.sharingType = .none
        panel.contentView = overlay
    }

    func prepare() -> Bool {
        NSApplication.shared.setActivationPolicy(.accessory)
        return restorePersistedFocusWindows(at: restoreURL)
    }

    func beginIsolation() -> Bool {
        installSignalHandlers()
        timer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] _ in
            self?.tick()
        }
        tick()
        return !stopping
    }

    func markProtocolReady() {
        protocolReady = true
        // A target observed during the synchronous first tick is already
        // represented by focus-ready. Only a later target needs a new event.
        if hadTarget { layoutStatusPublished = true }
    }

    private func resolveTargetApp() -> NSRunningApplication? {
        if let targetApp, !targetApp.isTerminated { return targetApp }
        // Once the authorized process exits, do not silently attach the lease
        // to a replacement process that happens to share its bundle id.
        guard !hadTarget else { return nil }
        let resolved = resolveRunningApp(selector)
        targetApp = resolved
        return resolved
    }

    private func publishLayoutStatusIfNeeded() {
        guard shouldPublishLayoutStatus(
            protocolReady: protocolReady,
            targetObserved: hadTarget,
            statusPublished: layoutStatusPublished
        ) else { return }
        layoutStatusPublished = true
        var event: [String: Any] = [
            "event": "focus-layout",
            "generation": generation,
            "target_observed": true,
            "compact_layout_applied": compactLayoutApplied,
        ]
        if let compactDisplayId { event["display_id"] = compactDisplayId }
        guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        fflush(stdout)
    }

    private func displayId(_ screen: NSScreen) -> UInt32? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }

    private func applyCompactLayoutIfNeeded(
        capability: FocusCapability,
        targetApp: NSRunningApplication,
        targetWindow: AXUIElement,
        targetFrame: CGRect
    ) -> CompactWindowFrames? {
        guard capability.compactLayout,
              let controllerPid = capability.controllerPid,
              let controllerApp = NSRunningApplication(processIdentifier: controllerPid),
              let controllerWindow = focusedWindow(controllerApp),
              let selectedScreen = focusScreen(containing: targetFrame)?.screen,
              let frames = compactWindowFrames(
                screen: selectedScreen,
                preferredPanelWidth: CGFloat(capability.compactPanelWidth)
              ) else {
            compactLayoutApplied = false
            compactDisplayId = nil
            return nil
        }
        guard targetApp.processIdentifier != controllerPid || capability.selfTestEnabled else {
            return nil
        }
        let selectedDisplayId = displayId(selectedScreen)
        let identity = [
            String(targetApp.processIdentifier),
            String(CFHash(targetWindow)),
            String(controllerPid),
            String(CFHash(controllerWindow)),
            String(selectedDisplayId ?? 0),
        ].joined(separator: ":")
        guard shouldApplyCompactLayout(
            previousIdentity: appliedLayoutIdentity,
            currentIdentity: identity
        ) else { return compactLayoutApplied ? frames : nil }

        if appliedLayoutIdentity != nil, !restoreWindows() {
            compactLayoutApplied = false
            return nil
        }
        guard let targetRecord = focusFrameRestoreRecord(
                window: targetWindow,
                app: targetApp,
                appliedFrame: frames.targetAXFrame
              ),
              let controllerRecord = focusFrameRestoreRecord(
                window: controllerWindow,
                app: controllerApp,
                appliedFrame: frames.controllerAXFrame
              ) else { return nil }
        let previousRecords = restoreRecords
        restoreRecords.append(contentsOf: [targetRecord, controllerRecord])
        do {
            try writeFocusRestoreRecords(restoreRecords, to: restoreURL)
        } catch {
            restoreRecords = previousRecords
            return nil
        }
        guard setAccessibilityFrame(targetWindow, frame: frames.targetAXFrame),
              setAccessibilityFrame(controllerWindow, frame: frames.controllerAXFrame) else {
            let restored = restorePersistedFocusWindows(at: restoreURL)
            if restored { restoreRecords.removeAll() }
            compactLayoutApplied = false
            return nil
        }
        appliedLayoutIdentity = identity
        compactLayoutApplied = true
        compactDisplayId = selectedDisplayId
        return frames
    }

    private func activateTargetIfRequested(
        capability: FocusCapability,
        targetApp: NSRunningApplication
    ) {
        guard shouldActivateTarget(
            previousGeneration: observedFocusRequestGeneration,
            currentGeneration: capability.focusRequestGeneration
        ) else { return }
        // Consume before activation so a failed OS activation is never retried
        // by the 120 ms timer and cannot become a focus-stealing loop.
        observedFocusRequestGeneration = capability.focusRequestGeneration
        targetApp.activate(options: [.activateAllWindows])
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

        guard let app = resolveTargetApp(), let window = focusedWindow(app), let frame = axFrame(window) else {
            panel.orderOut(nil)
            if hadTarget { stopAndExit() }
            return
        }
        if app.processIdentifier == capability.controllerPid && !capability.selfTestEnabled {
            stopAndExit(exitCode: 3)
            return
        }
        hadTarget = true
        guard let selectedFocusScreen = focusScreen(containing: frame) else {
            panel.orderOut(nil)
            return
        }
        let compactFrames = applyCompactLayoutIfNeeded(
            capability: capability,
            targetApp: app,
            targetWindow: window,
            targetFrame: frame
        )
        publishLayoutStatusIfNeeded()
        activateTargetIfRequested(capability: capability, targetApp: app)
        var approvedPids = Set(
            NSWorkspace.shared.runningApplications.compactMap { running -> pid_t? in
                guard let bundleId = running.bundleIdentifier,
                      capability.approvedApps.contains(where: {
                          $0.bundleId.caseInsensitiveCompare(bundleId) == .orderedSame
                      }) else { return nil }
                return running.processIdentifier
            }
        ).union([app.processIdentifier])
        if let controllerPid = capability.controllerPid,
           NSRunningApplication(processIdentifier: controllerPid) != nil {
            approvedPids.insert(controllerPid)
        }
        if !capability.isolateOtherApps {
            guard restoreMinimizedWindows() else {
                stopAndExit(exitCode: 3)
                return
            }
        } else {
            if isolatedApprovedPids != approvedPids {
                guard restoreMinimizedWindows() else {
                    stopAndExit(exitCode: 3)
                    return
                }
                isolatedApprovedPids = approvedPids
            }
            guard isolateVisibleApps(except: approvedPids) else {
                stopAndExit(exitCode: 3)
                return
            }
        }

        let panelFrame = compactFrames?.overlayAppKitFrame ?? selectedFocusScreen.screen.frame
        if panel.frame != panelFrame {
            panel.setFrame(panelFrame, display: true)
            overlay.frame = CGRect(origin: .zero, size: panelFrame.size)
        }
        overlay.needsDisplay = true
        panel.orderFrontRegardless()
    }

    private func isolateVisibleApps(except approvedPids: Set<pid_t>) -> Bool {
        for app in NSWorkspace.shared.runningApplications where
            app.activationPolicy == .regular && !approvedPids.contains(app.processIdentifier) {
            for window in applicationWindows(app) {
                guard boolAttribute(window, kAXMinimizedAttribute as CFString) == false,
                      axFrame(window).map(isEligibleCaptureFrame) == true else { continue }
                var settable = DarwinBoolean(false)
                guard AXUIElementIsAttributeSettable(
                    window,
                    kAXMinimizedAttribute as CFString,
                    &settable
                ) == .success, settable.boolValue else { continue }
                // Persist the restoration record before mutating the window.
                // A crash can now leave either an unminimized window with an
                // inert record or a minimized window with a durable record,
                // never a minimized window with no recovery data.
                guard let record = focusRestoreRecord(window: window, app: app) else {
                    continue
                }
                let previousRecords = restoreRecords
                restoreRecords.append(record)
                do {
                    try writeFocusRestoreRecords(restoreRecords, to: restoreURL)
                } catch {
                    restoreRecords = previousRecords
                    FileHandle.standardError.write(
                        Data("Unable to persist focus restoration before minimizing: \(error)\n".utf8)
                    )
                    return false
                }

                if AXUIElementSetAttributeValue(
                    window,
                    kAXMinimizedAttribute as CFString,
                    kCFBooleanTrue
                ) == .success {
                    minimizedWindows.append(window)
                } else {
                    restoreRecords = previousRecords
                    do {
                        try writeFocusRestoreRecords(restoreRecords, to: restoreURL)
                    } catch {
                        FileHandle.standardError.write(
                            Data("Unable to roll back unused focus restoration state: \(error)\n".utf8)
                        )
                        return false
                    }
                }
            }
        }
        return true
    }

    @discardableResult
    private func restoreMinimizedWindows() -> Bool {
        for window in minimizedWindows where boolAttribute(window, kAXMinimizedAttribute as CFString) == true {
            if AXUIElementSetAttributeValue(
                window,
                kAXMinimizedAttribute as CFString,
                kCFBooleanFalse
            ) != .success || !confirmWindowIsUnminimized(window) {
                return false
            }
        }
        minimizedWindows.removeAll()
        restoreRecords.removeAll(where: { $0.kind == .minimized })
        do {
            try writeFocusRestoreRecords(restoreRecords, to: restoreURL)
        } catch {
            return false
        }
        isolatedApprovedPids.removeAll()
        return true
    }

    @discardableResult
    private func restoreWindows() -> Bool {
        for window in minimizedWindows where boolAttribute(window, kAXMinimizedAttribute as CFString) == true {
            _ = AXUIElementSetAttributeValue(
                window,
                kAXMinimizedAttribute as CFString,
                kCFBooleanFalse
            )
        }
        minimizedWindows.removeAll()
        let restored = restorePersistedFocusWindows(at: restoreURL)
        if restored {
            restoreRecords.removeAll()
            appliedLayoutIdentity = nil
            compactLayoutApplied = false
            compactDisplayId = nil
        }
        isolatedApprovedPids.removeAll()
        return restored
    }

    private func stopAndExit(exitCode: Int32 = 0) {
        guard !stopping else { return }
        stopping = true
        timer?.invalidate()
        panel.orderOut(nil)
        let restored = restoreWindows()
        exit(restored ? exitCode : 3)
    }
}

private func runFocusSession() {
    guard let flagIndex = CommandLine.arguments.firstIndex(of: "--focus-session"),
          CommandLine.arguments.indices.contains(flagIndex + 2),
          let generationIndex = CommandLine.arguments.firstIndex(of: "--focus-generation"),
          CommandLine.arguments.indices.contains(generationIndex + 1) else {
        FileHandle.standardError.write(
            Data("Missing focus-session app, capability path, or generation\n".utf8)
        )
        exit(2)
    }
    let selector = CommandLine.arguments[flagIndex + 1]
    let capabilityURL = URL(fileURLWithPath: CommandLine.arguments[flagIndex + 2])
    let generation = CommandLine.arguments[generationIndex + 1]
    guard !generation.isEmpty else { exit(2) }
    let controller = FocusSessionController(
        selector: selector,
        capabilityURL: capabilityURL,
        generation: generation
    )
    guard controller.prepare() else {
        FileHandle.standardError.write(Data("Unable to restore prior focus state; refusing isolation\n".utf8))
        exit(3)
    }
    let prepared = ["event": "focus-prepared", "generation": generation]
    guard let preparedData = try? JSONSerialization.data(withJSONObject: prepared) else { exit(2) }
    FileHandle.standardOutput.write(preparedData)
    FileHandle.standardOutput.write(Data("\n".utf8))
    fflush(stdout)

    guard let commitLine = readLine(strippingNewline: true),
          let commitData = commitLine.data(using: .utf8),
          let commit = try? JSONDecoder().decode(FocusCommit.self, from: commitData),
          commit.event == "focus-commit",
          commit.generation == generation else {
        FileHandle.standardError.write(Data("Focus lease commit was missing or invalid\n".utf8))
        exit(3)
    }
    guard controller.beginIsolation() else { exit(3) }

    var ready: [String: Any] = [
        "event": "focus-ready",
        "generation": generation,
        "target_observed": controller.targetObserved,
        "compact_layout_applied": controller.compactLayoutApplied,
    ]
    if let displayId = controller.compactDisplayId {
        ready["display_id"] = displayId
    }
    guard let readyData = try? JSONSerialization.data(withJSONObject: ready) else { exit(2) }
    FileHandle.standardOutput.write(readyData)
    FileHandle.standardOutput.write(Data("\n".utf8))
    fflush(stdout)
    controller.markProtocolReady()
    NSApplication.shared.run()
}

private func runFocusRestore() {
    guard let flagIndex = CommandLine.arguments.firstIndex(of: "--restore-focus-state"),
          CommandLine.arguments.indices.contains(flagIndex + 1) else {
        exit(2)
    }
    let restored = restorePersistedFocusWindows(
        at: URL(fileURLWithPath: CommandLine.arguments[flagIndex + 1])
    )
    exit(restored ? 0 : 3)
}

private func runFocusStateWriteContract() {
    guard CommandLine.arguments.contains("--contract-test"),
          let flagIndex = CommandLine.arguments.firstIndex(of: "--contract-write-focus-state"),
          CommandLine.arguments.indices.contains(flagIndex + 1) else {
        exit(2)
    }
    let record = FocusRestoreRecord(
        kind: .minimized,
        pid: 0,
        bundleId: "contract.invalid",
        launchTimeMillis: 1,
        title: "Contract",
        originalFrame: CodableRect(CGRect(x: 0, y: 0, width: 100, height: 100)),
        appliedFrame: nil
    )
    do {
        try writeFocusRestoreRecords(
            [record],
            to: URL(fileURLWithPath: CommandLine.arguments[flagIndex + 1])
        )
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("Focus state contract write failed: \(error)\n".utf8))
        exit(3)
    }
}

private struct AgentLaunchRequest {
    let sourceAppURL: URL
    let installedAppURL: URL
    let socketPath: String

    var capabilityEnvironment: [String: String] {
        var environment: [String: String] = [:]
        if let token = ProcessInfo.processInfo.environment["VERBOO_CU_TOKEN"] {
            environment["VERBOO_CU_TOKEN"] = token
        }
        if let capabilityFile = ProcessInfo.processInfo.environment["VERBOO_CU_CAPABILITY_FILE"] {
            environment["VERBOO_CU_CAPABILITY_FILE"] = capabilityFile
        }
        return environment
    }
}

private func commandLineValue(after flag: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: flag),
          CommandLine.arguments.indices.contains(index + 1) else {
        return nil
    }
    return CommandLine.arguments[index + 1]
}

private func agentLaunchRequest() -> AgentLaunchRequest? {
    guard let sourceApp = commandLineValue(after: "--launch-agent-app"),
          let installedApp = commandLineValue(after: "--installed-agent-app"),
          let socketPath = commandLineValue(after: "--launch-agent-socket"),
          !sourceApp.isEmpty,
          !installedApp.isEmpty,
          !socketPath.isEmpty else {
        return nil
    }
    return AgentLaunchRequest(
        sourceAppURL: URL(fileURLWithPath: sourceApp).standardizedFileURL,
        installedAppURL: URL(fileURLWithPath: installedApp).standardizedFileURL,
        socketPath: socketPath
    )
}

private func writeJSONAndExit(_ payload: [String: Any], code: Int32 = 0) -> Never {
    guard let data = try? JSONSerialization.data(
        withJSONObject: payload,
        options: [.sortedKeys, .withoutEscapingSlashes]
    ) else {
        exit(3)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    fflush(stdout)
    exit(code)
}

private func runAgentLaunchPlanContract() -> Never {
    guard let request = agentLaunchRequest() else {
        writeJSONAndExit(["error": "invalid launch arguments"], code: 2)
    }
    writeJSONAndExit([
        "source_app": request.sourceAppURL.path,
        "installed_app": request.installedAppURL.path,
        "socket": request.socketPath,
        "activates": false,
        "adds_to_recent_items": false,
        "creates_new_application_instance": true,
        "allows_running_application_substitution": false,
        "capability_environment": request.capabilityEnvironment.count == 2,
    ])
}

private func agentBundlesMatch(source: URL, installed: URL) -> Bool {
    let fileManager = FileManager.default
    guard fileManager.fileExists(atPath: installed.path) else { return false }
    for relativePath in [
        "Contents/Info.plist",
        "Contents/MacOS/computer-use-helper",
    ] {
        let sourcePath = source.appendingPathComponent(relativePath).path
        let installedPath = installed.appendingPathComponent(relativePath).path
        if !fileManager.contentsEqual(atPath: sourcePath, andPath: installedPath) {
            return false
        }
    }
    return true
}

private func terminateInstalledAgentInstances(at installedAppURL: URL) {
    let installedPath = installedAppURL.standardizedFileURL.path
    let applications = NSRunningApplication.runningApplications(
        withBundleIdentifier: "ai.verboo.code.computer-use"
    )
    for application in applications {
        guard application.bundleURL?.standardizedFileURL.path == installedPath else { continue }
        _ = application.terminate()
        let deadline = Date().addingTimeInterval(2)
        while !application.isTerminated && Date() < deadline {
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
        if !application.isTerminated {
            _ = application.forceTerminate()
        }
    }
}

private func installAgentApp(_ request: AgentLaunchRequest) throws {
    let fileManager = FileManager.default
    guard fileManager.fileExists(atPath: request.sourceAppURL.path) else {
        throw NSError(
            domain: "ai.verboo.code.computer-use.launcher",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Packaged Verboo Computer Use.app is missing"]
        )
    }
    if agentBundlesMatch(source: request.sourceAppURL, installed: request.installedAppURL) {
        return
    }

    terminateInstalledAgentInstances(at: request.installedAppURL)
    let parentURL = request.installedAppURL.deletingLastPathComponent()
    try fileManager.createDirectory(
        at: parentURL,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    try fileManager.setAttributes(
        [.posixPermissions: 0o700],
        ofItemAtPath: parentURL.path
    )

    let stagedURL = parentURL.appendingPathComponent(
        ".Verboo Computer Use-\(UUID().uuidString).app",
        isDirectory: true
    )
    if fileManager.fileExists(atPath: stagedURL.path) {
        try fileManager.removeItem(at: stagedURL)
    }
    do {
        try fileManager.copyItem(at: request.sourceAppURL, to: stagedURL)
        if fileManager.fileExists(atPath: request.installedAppURL.path) {
            _ = try fileManager.replaceItemAt(
                request.installedAppURL,
                withItemAt: stagedURL,
                backupItemName: nil,
                options: []
            )
        } else {
            try fileManager.moveItem(at: stagedURL, to: request.installedAppURL)
        }
    } catch {
        try? fileManager.removeItem(at: stagedURL)
        throw error
    }
}

private final class AgentLaunchCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var value: (NSRunningApplication?, Error?)?

    func complete(application: NSRunningApplication?, error: Error?) {
        lock.lock()
        value = (application, error)
        lock.unlock()
    }

    func snapshot() -> (NSRunningApplication?, Error?)? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

private func runAgentLauncher() -> Never {
    guard let request = agentLaunchRequest() else {
        FileHandle.standardError.write(Data("Missing Verboo agent launch arguments\n".utf8))
        exit(2)
    }

    do {
        try installAgentApp(request)
    } catch {
        FileHandle.standardError.write(Data("Install Verboo Computer Use agent: \(error)\n".utf8))
        exit(3)
    }

    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    configuration.createsNewApplicationInstance = true
    configuration.allowsRunningApplicationSubstitution = false
    configuration.promptsUserIfNeeded = false
    configuration.arguments = [
        "--verboo-agent-socket",
        request.socketPath,
    ]
    configuration.environment = request.capabilityEnvironment

    let completion = AgentLaunchCompletion()
    NSWorkspace.shared.openApplication(
        at: request.installedAppURL,
        configuration: configuration
    ) { application, error in
        completion.complete(application: application, error: error)
    }

    let deadline = Date().addingTimeInterval(8)
    while completion.snapshot() == nil && Date() < deadline {
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
    }
    guard let (application, error) = completion.snapshot() else {
        FileHandle.standardError.write(Data("Launch Services timed out\n".utf8))
        exit(3)
    }
    if let error {
        FileHandle.standardError.write(Data("Launch Services failed: \(error)\n".utf8))
        exit(3)
    }
    guard let application,
          application.processIdentifier > 1,
          application.bundleIdentifier == "ai.verboo.code.computer-use" else {
        FileHandle.standardError.write(Data("Launch Services returned an invalid application\n".utf8))
        exit(3)
    }

    let installedAppURL = request.installedAppURL.resolvingSymlinksInPath()
    let executableURL = installedAppURL
        .appendingPathComponent("Contents/MacOS/computer-use-helper")
        .resolvingSymlinksInPath()
    writeJSONAndExit([
        "pid": Int(application.processIdentifier),
        "app_path": installedAppURL.path,
        "executable_path": executableURL.path,
    ])
}

func readLoop(contractTest: Bool = false, dispatchRequestsOnMain: Bool = false) {
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
            if contractTest {
                handleContractTest(req)
            } else if dispatchRequestsOnMain {
                DispatchQueue.main.sync {
                    handle(req)
                }
            } else {
                handle(req)
            }
        }
    }
}

private func runAgentApplicationLoop(contractTest: Bool) {
    let application = NSApplication.shared
    _ = application.setActivationPolicy(.accessory)
    DispatchQueue.global(qos: .userInitiated).async {
        readLoop(contractTest: contractTest, dispatchRequestsOnMain: true)
        DispatchQueue.main.async {
            NSApplication.shared.terminate(nil)
        }
    }
    application.run()
}

private func installAgentSocketTransportIfNeeded() -> Bool {
    guard let socketFlag = CommandLine.arguments.firstIndex(of: "--verboo-agent-socket") else {
        return false
    }
    guard CommandLine.arguments.indices.contains(socketFlag + 1) else {
        FileHandle.standardError.write(Data("Missing Verboo agent socket path\n".utf8))
        exit(2)
    }

    let pathBytes = CommandLine.arguments[socketFlag + 1].utf8CString
    var address = sockaddr_un()
    let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
    guard pathBytes.count <= pathCapacity else {
        FileHandle.standardError.write(Data("Verboo agent socket path is too long\n".utf8))
        exit(2)
    }

    let socketDescriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard socketDescriptor >= 0 else {
        FileHandle.standardError.write(Data("Could not create Verboo agent socket\n".utf8))
        exit(2)
    }

    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        let destination = UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self)
        for index in pathBytes.indices {
            destination[index] = pathBytes[index]
        }
    }

    let connected = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(socketDescriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connected == 0,
          dup2(socketDescriptor, STDIN_FILENO) >= 0,
          dup2(socketDescriptor, STDOUT_FILENO) >= 0 else {
        Darwin.close(socketDescriptor)
        FileHandle.standardError.write(Data("Could not connect Verboo agent transport\n".utf8))
        exit(2)
    }
    Darwin.close(socketDescriptor)
    return true
}

if CommandLine.arguments.contains("--contract-agent-launch-plan") {
    runAgentLaunchPlanContract()
}
if CommandLine.arguments.contains("--launch-agent-app") {
    runAgentLauncher()
}

let usesAgentSocketTransport = installAgentSocketTransportIfNeeded()

if CommandLine.arguments.contains("--monitor-emergency") {
    runEmergencyMonitor()
} else if CommandLine.arguments.contains("--focus-session") {
    runFocusSession()
} else if CommandLine.arguments.contains("--restore-focus-state") {
    runFocusRestore()
} else if CommandLine.arguments.contains("--contract-write-focus-state") {
    runFocusStateWriteContract()
} else {
    if !CommandLine.arguments.contains("--contract-test") {
        installActionCancellationHandlers()
    }
    let contractTest = CommandLine.arguments.contains("--contract-test")
    if usesAgentSocketTransport {
        runAgentApplicationLoop(contractTest: contractTest)
    } else {
        readLoop(contractTest: contractTest)
    }
}
