import Foundation
import AppKit
import ApplicationServices

/// Accessibility queries over AXUIElement. Returns a JSON list of
/// `{role, label, bbox, pid}` matching the requested filter.
///
/// Invocation:
///   cortexos-vision ax find    --role <role> [--label <str>] [--app <bundleId>]
///   cortexos-vision ax findAll --role <role> [--app <bundleId>]
///
/// Permission: AX requires the helper binary to be trusted under
/// System Settings → Privacy & Security → Accessibility. When the process
/// is not trusted we throw `.permissionDenied` so the TS bridge emits a
/// clean `AXPermissionDeniedError`.
enum AXCommand {
    static func run(args: [String]) async throws {
        guard let op = args.first else {
            throw VisionError.invalidArgs("missing ax op (find|findAll)")
        }
        let rest = Array(args.dropFirst())
        let parsed = try ArgMap(rest)

        if !AXIsProcessTrusted() {
            throw VisionError.permissionDenied
        }

        let role = try parsed.require("role")
        let label = parsed.get("label")
        let bundle = parsed.get("app")

        let matches = collect(role: role, label: label, bundle: bundle)

        switch op {
        case "find":
            if let first = matches.first {
                try emitJSON(first)
            } else {
                try emitJSON(["match": "none"])
            }
        case "findAll":
            try emitJSON(["matches": matches])
        default:
            throw VisionError.invalidArgs("unknown ax op: \(op)")
        }
    }

    private static func collect(
        role: String,
        label: String?,
        bundle: String?
    ) -> [[String: Any]] {
        let apps = NSWorkspace.shared.runningApplications.filter { app in
            if app.activationPolicy != .regular { return false }
            if let want = bundle, app.bundleIdentifier != want { return false }
            return true
        }
        var out: [[String: Any]] = []
        for app in apps {
            let pid = app.processIdentifier
            let axApp = AXUIElementCreateApplication(pid)
            walk(axApp, pid: pid, wantRole: role, wantLabel: label, out: &out, depth: 0)
        }
        return out
    }

    /// DFS the AX tree, bounded to depth 8 so we never walk pathological UIs.
    private static func walk(
        _ element: AXUIElement,
        pid: pid_t,
        wantRole: String,
        wantLabel: String?,
        out: inout [[String: Any]],
        depth: Int
    ) {
        if depth > 8 { return }

        let role = copyAttr(element, kAXRoleAttribute as CFString) as? String
        let title = copyAttr(element, kAXTitleAttribute as CFString) as? String
        let desc = copyAttr(element, kAXDescriptionAttribute as CFString) as? String
        let label = title ?? desc ?? ""

        if role == wantRole {
            if wantLabel == nil || label.localizedCaseInsensitiveContains(wantLabel!) {
                let bbox = bboxOf(element)
                out.append([
                    "role": role ?? "",
                    "label": label,
                    "bbox": bbox,
                    "pid": Int(pid),
                ])
            }
        }

        // Children
        if let kids = copyAttr(element, kAXChildrenAttribute as CFString) as? [AXUIElement] {
            for k in kids {
                walk(k, pid: pid, wantRole: wantRole, wantLabel: wantLabel, out: &out, depth: depth + 1)
                if out.count > 200 { return } // hard cap
            }
        }
    }

    private static func copyAttr(_ el: AXUIElement, _ name: CFString) -> AnyObject? {
        var value: AnyObject?
        let err = AXUIElementCopyAttributeValue(el, name, &value)
        return err == .success ? value : nil
    }

    private static func bboxOf(_ el: AXUIElement) -> [String: Int] {
        var pos = CGPoint.zero
        var size = CGSize.zero

        if let posVal = copyAttr(el, kAXPositionAttribute as CFString) {
            AXValueGetValue(posVal as! AXValue, .cgPoint, &pos)
        }
        if let sizeVal = copyAttr(el, kAXSizeAttribute as CFString) {
            AXValueGetValue(sizeVal as! AXValue, .cgSize, &size)
        }
        return [
            "x": Int(pos.x.rounded()),
            "y": Int(pos.y.rounded()),
            "w": Int(size.width.rounded()),
            "h": Int(size.height.rounded()),
        ]
    }
}
