import Foundation
import AppKit
import ApplicationServices

/// Subscribes to `kAXValueChangedNotification` on text-field elements in the
/// focused app and streams NDJSON samples to stdout as their values change.
///
/// Usage:
///   cortexos-vision ax-watch --app <bundle-id> [--text-role]
///
/// Emits lines of:
///   {"app":"<bundle>","role":"AXTextField","label":"<label>","value":"<current text>","ts":"<ISO>"}
///
/// Throttling: per-element, max 1 emission per 3s AND dedup on identical
/// content (identical value is suppressed regardless of time window).
///
/// Exits cleanly on SIGTERM / SIGINT. No network.
enum AXWatchCommand {
    static func run(args: [String]) async throws {
        let parsed = try ArgMap(args)
        let wantedBundle = try parsed.require("app")
        // --text-role is currently a hint: we always filter to AXTextField /
        // AXTextArea / AXComboBox. Reserved for future role customisation.
        _ = parsed.get("text-role")

        // Check Accessibility permission up-front. We intentionally do NOT
        // prompt here — the caller (TypeScript bridge) handles onboarding.
        let trusted = AXIsProcessTrusted()
        if !trusted {
            throw VisionError.permissionDenied
        }

        // Resolve the running app by bundle id.
        guard let runningApp = NSRunningApplication.runningApplications(
            withBundleIdentifier: wantedBundle
        ).first else {
            throw VisionError.noMatchingWindow
        }

        let watcher = AXWatcher(bundleId: wantedBundle, pid: runningApp.processIdentifier)
        try watcher.start()

        // Install signal handlers so we exit cleanly.
        installSignalHandlers(onSignal: {
            watcher.stop()
            exit(0)
        })

        // Run the AX run-loop forever (until SIGTERM).
        RunLoop.current.run()
    }

    private static func installSignalHandlers(onSignal: @escaping () -> Void) {
        let sigTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        let sigInt  = DispatchSource.makeSignalSource(signal: SIGINT,  queue: .main)
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT,  SIG_IGN)
        sigTerm.setEventHandler { onSignal() }
        sigInt.setEventHandler  { onSignal() }
        sigTerm.resume()
        sigInt.resume()
        // Retain the sources for the lifetime of the process.
        SignalRetainer.shared.sources = [sigTerm, sigInt]
    }
}

/// Keeps DispatchSourceSignal refs alive so GCD doesn't cancel them.
private final class SignalRetainer {
    static let shared = SignalRetainer()
    var sources: [DispatchSourceSignal] = []
}

// ────────────────────────── AXWatcher ──────────────────────────

/// Wraps AXObserver + a small per-element throttle state.
private final class AXWatcher {
    private let bundleId: String
    private let pid: pid_t
    private var observer: AXObserver?
    private var appElement: AXUIElement?
    /// Last emission time + last value per element (identified by its
    /// CFHashCode). We keep this weakly via the pointer identity — AXUIElement
    /// is a CF type so a small Dictionary<ObjectIdentifier,…> won't work; we
    /// use its hashValue as returned by CFHash.
    private var lastEmittedAt: [Int: Date] = [:]
    private var lastValue: [Int: String] = [:]
    private let throttle: TimeInterval = 3.0

    init(bundleId: String, pid: pid_t) {
        self.bundleId = bundleId
        self.pid = pid
    }

    func start() throws {
        let app = AXUIElementCreateApplication(pid)
        self.appElement = app

        var observer: AXObserver?
        let err = AXObserverCreate(pid, axCallback, &observer)
        guard err == .success, let obs = observer else {
            throw VisionError.captureFailed("AXObserverCreate failed: \(err.rawValue)")
        }
        self.observer = obs

        // Attach observer run-loop source.
        CFRunLoopAddSource(
            CFRunLoopGetCurrent(),
            AXObserverGetRunLoopSource(obs),
            .defaultMode
        )

        // Register on the app root. kAXValueChangedNotification bubbles up
        // from descendants when registered on the application element.
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        let regErr = AXObserverAddNotification(
            obs,
            app,
            kAXValueChangedNotification as CFString,
            selfPtr
        )
        if regErr != .success && regErr != .notificationAlreadyRegistered {
            throw VisionError.captureFailed("AXObserverAddNotification failed: \(regErr.rawValue)")
        }

        // Also subscribe to focused-element changes so we pick up newly
        // focused text fields (e.g. user tabs into a different input).
        _ = AXObserverAddNotification(
            obs,
            app,
            kAXFocusedUIElementChangedNotification as CFString,
            selfPtr
        )
    }

    func stop() {
        if let obs = observer, let app = appElement {
            AXObserverRemoveNotification(obs, app, kAXValueChangedNotification as CFString)
            AXObserverRemoveNotification(obs, app, kAXFocusedUIElementChangedNotification as CFString)
        }
        observer = nil
        appElement = nil
    }

    /// Called by the AX C callback (see axCallback below).
    fileprivate func handle(element: AXUIElement, notification: String) {
        // Only emit for text-ish roles.
        let role = copyStringAttr(element, kAXRoleAttribute as CFString) ?? ""
        let isTextRole = role == "AXTextField"
            || role == "AXTextArea"
            || role == "AXComboBox"
            || role == "AXSearchField"
        if !isTextRole { return }

        let value = copyStringAttr(element, kAXValueAttribute as CFString) ?? ""
        // Label: description → title → empty
        let label = copyStringAttr(element, kAXDescriptionAttribute as CFString)
            ?? copyStringAttr(element, kAXTitleAttribute as CFString)
            ?? ""

        let key = Int(CFHash(element))
        let now = Date()

        // Dedup by content.
        if let prev = lastValue[key], prev == value { return }
        // Throttle per element.
        if let ts = lastEmittedAt[key], now.timeIntervalSince(ts) < throttle { return }

        lastEmittedAt[key] = now
        lastValue[key] = value

        emit(role: role, label: label, value: value, ts: now)
    }

    private func emit(role: String, label: String, value: String, ts: Date) {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let payload: [String: Any] = [
            "app": bundleId,
            "role": role,
            "label": label,
            "value": value,
            "ts": iso.string(from: ts),
        ]
        do {
            try emitJSON(payload)
        } catch {
            // Stdout write failure is fatal — parent process likely gone.
            FileHandle.standardError.write(Data("emit-failed\n".utf8))
            exit(1)
        }
    }

    private func copyStringAttr(_ element: AXUIElement, _ attr: CFString) -> String? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, attr, &value)
        guard err == .success else { return nil }
        if let s = value as? String { return s }
        return nil
    }
}

/// C-style callback AX requires. Bounces back into AXWatcher.handle().
private func axCallback(
    _ observer: AXObserver,
    _ element: AXUIElement,
    _ notification: CFString,
    _ refcon: UnsafeMutableRawPointer?
) {
    guard let refcon = refcon else { return }
    let watcher = Unmanaged<AXWatcher>.fromOpaque(refcon).takeUnretainedValue()
    watcher.handle(element: element, notification: notification as String)
}
