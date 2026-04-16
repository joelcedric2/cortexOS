import Foundation
import CoreGraphics
import AppKit

/// Low-level synthetic input (mouse + keyboard) plus an ad-hoc screenshot
/// helper exposed under a single `input` subcommand. The Swift side owns
/// CoreGraphics event construction; the TS `Actuator` owns clamping /
/// audit / policy gating.
///
/// We emit one JSON object on stdout per invocation so the TS bridge can
/// parse a deterministic result envelope. Every op shells out via a
/// single `cortexos-vision input <op> …` call — no long-running daemons.
enum InputCommand {
    static func run(args: [String]) async throws {
        guard let op = args.first else {
            throw VisionError.invalidArgs("missing input op")
        }
        let rest = Array(args.dropFirst())
        let parsed = try ArgMap(rest)

        switch op {
        case "click":
            try runClick(parsed, double: false)
        case "double-click":
            try runClick(parsed, double: true)
        case "move":
            try runMove(parsed)
        case "type":
            try runType(parsed)
        case "scroll":
            try runScroll(parsed)
        case "screenshot":
            try runScreenshot(parsed)
        default:
            throw VisionError.invalidArgs("unknown input op: \(op)")
        }
    }

    // ─────────────── Mouse ops ───────────────

    private static func runClick(_ parsed: ArgMap, double: Bool) throws {
        let (x, y) = try requireXY(parsed)
        let button = parsed.get("button") ?? "left"
        let (downType, upType, mouseButton): (CGEventType, CGEventType, CGMouseButton)
        switch button {
        case "right":
            downType = .rightMouseDown
            upType = .rightMouseUp
            mouseButton = .right
        case "left":
            downType = .leftMouseDown
            upType = .leftMouseUp
            mouseButton = .left
        default:
            throw VisionError.invalidArgs("button must be left|right")
        }
        let pt = CGPoint(x: CGFloat(x), y: CGFloat(y))
        try postMouse(downType, at: pt, button: mouseButton, clickCount: 1)
        try postMouse(upType, at: pt, button: mouseButton, clickCount: 1)
        if double {
            try postMouse(downType, at: pt, button: mouseButton, clickCount: 2)
            try postMouse(upType, at: pt, button: mouseButton, clickCount: 2)
        }
        try emitJSON([
            "op": double ? "double-click" : "click",
            "x": x,
            "y": y,
            "button": button,
        ])
    }

    private static func runMove(_ parsed: ArgMap) throws {
        let (x, y) = try requireXY(parsed)
        let pt = CGPoint(x: CGFloat(x), y: CGFloat(y))
        guard let ev = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: pt,
            mouseButton: .left
        ) else {
            throw VisionError.captureFailed("mouseMoved event allocation failed")
        }
        ev.post(tap: .cghidEventTap)
        try emitJSON(["op": "move", "x": x, "y": y])
    }

    private static func runScroll(_ parsed: ArgMap) throws {
        let (x, y) = try requireXY(parsed)
        let dy = try intFrom(parsed, key: "dy")
        let dx = parsed.get("dx").flatMap { Int($0) } ?? 0
        // Move cursor to (x,y) first so the scroll lands on the intended element.
        let pt = CGPoint(x: CGFloat(x), y: CGFloat(y))
        if let mv = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: pt,
            mouseButton: .left
        ) { mv.post(tap: .cghidEventTap) }

        guard let scroll = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 2,
            wheel1: Int32(dy),
            wheel2: Int32(dx),
            wheel3: 0
        ) else {
            throw VisionError.captureFailed("scroll event allocation failed")
        }
        scroll.post(tap: .cghidEventTap)
        try emitJSON(["op": "scroll", "x": x, "y": y, "dy": dy, "dx": dx])
    }

    private static func postMouse(
        _ type: CGEventType,
        at point: CGPoint,
        button: CGMouseButton,
        clickCount: Int64
    ) throws {
        guard let ev = CGEvent(
            mouseEventSource: nil,
            mouseType: type,
            mouseCursorPosition: point,
            mouseButton: button
        ) else {
            throw VisionError.captureFailed("mouse event allocation failed")
        }
        ev.setIntegerValueField(.mouseEventClickState, value: clickCount)
        ev.post(tap: .cghidEventTap)
    }

    // ─────────────── Keyboard ───────────────

    private static func runType(_ parsed: ArgMap) throws {
        let text = try parsed.require("text")
        let delayMs = parsed.get("delay-ms").flatMap { Int($0) } ?? 0
        // Split into Unicode scalars so we can set string for each chunk.
        let chars = Array(text.unicodeScalars)
        for scalar in chars {
            let s = String(scalar)
            var buf = Array(s.utf16)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                throw VisionError.captureFailed("keyboard event allocation failed")
            }
            buf.withUnsafeBufferPointer { ptr in
                if let base = ptr.baseAddress {
                    down.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: base)
                    up.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: base)
                }
            }
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            if delayMs > 0 {
                usleep(UInt32(delayMs * 1000))
            }
        }
        try emitJSON(["op": "type", "length": text.count, "delay_ms": delayMs])
    }

    // ─────────────── Screenshot ───────────────

    /// Thin wrapper over CaptureCommand — `input screenshot --out X` so agents
    /// can take a fresh shot with the same binary they use for actions.
    private static func runScreenshot(_ parsed: ArgMap) throws {
        let outPath = parsed.get("out") ?? NSString(string: NSTemporaryDirectory())
            .appendingPathComponent("cortexos-input-\(UUID().uuidString).png")
        // Re-invoke capture via the public CaptureCommand entry point so we
        // share one code path for ScreenCaptureKit + permission handling.
        let sema = DispatchSemaphore(value: 0)
        var captureErr: Error?
        Task {
            defer { sema.signal() }
            do {
                try await CaptureCommand.run(args: ["--out", outPath])
            } catch {
                captureErr = error
            }
        }
        sema.wait()
        if let err = captureErr { throw err }
        // CaptureCommand already emitted its own JSON. Nothing more to do.
    }

    // ─────────────── Helpers ───────────────

    private static func requireXY(_ parsed: ArgMap) throws -> (Int, Int) {
        let x = try intFrom(parsed, key: "x")
        let y = try intFrom(parsed, key: "y")
        return (x, y)
    }

    private static func intFrom(_ parsed: ArgMap, key: String) throws -> Int {
        let raw = try parsed.require(key)
        guard let n = Int(raw) else {
            throw VisionError.invalidArgs("--\(key) must be an integer")
        }
        return n
    }
}
