import Foundation
import CoreGraphics
import AppKit
import ScreenCaptureKit

/// One-shot ScreenCaptureKit screenshot.
///
/// Writes the PNG to --out if provided, otherwise to a temp path, and prints a
/// JSON metadata object with width / height / active_app / window_title / ts
/// / png_path.
enum CaptureCommand {
    static func run(args: [String]) async throws {
        let parsed = try ArgMap(args)
        let bundleFilter = parsed.get("app")

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
        } catch {
            // ScreenCaptureKit throws when Screen Recording permission is missing.
            throw VisionError.permissionDenied
        }

        guard let display = content.displays.first else {
            throw VisionError.captureFailed("no displays available")
        }

        // Select the frontmost app (or the one matching --app).
        let frontmostApp = NSWorkspace.shared.frontmostApplication
        let activeBundle = frontmostApp?.bundleIdentifier
        let activeName = frontmostApp?.localizedName ?? activeBundle ?? "unknown"

        if let wanted = bundleFilter, let bid = activeBundle, wanted != bid {
            throw VisionError.noMatchingWindow
        }

        // Best-effort: first visible window of the active app is the "active window".
        let activeWindow = content.windows.first { win in
            guard let owningBundle = win.owningApplication?.bundleIdentifier else { return false }
            return owningBundle == activeBundle
        }
        let windowTitle = activeWindow?.title ?? ""

        // Build SCContentFilter — whole display, no window exclusions.
        let filter = SCContentFilter(
            display: display,
            excludingApplications: [],
            exceptingWindows: []
        )

        let config = SCStreamConfiguration()
        config.width = Int(display.width)
        config.height = Int(display.height)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.showsCursor = false

        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: config
            )
        } catch {
            let nserr = error as NSError
            if nserr.code == -3801 || nserr.domain.contains("TCC") {
                throw VisionError.permissionDenied
            }
            throw VisionError.captureFailed(error.localizedDescription)
        }

        // Write PNG.
        let outPath: String
        if let o = parsed.get("out") {
            outPath = o
        } else {
            let tmp = NSTemporaryDirectory()
            outPath = (tmp as NSString).appendingPathComponent(
                "cortexos-vision-\(UUID().uuidString).png"
            )
        }

        let rep = NSBitmapImageRep(cgImage: image)
        guard let data = rep.representation(using: .png, properties: [:]) else {
            throw VisionError.captureFailed("png encode failed")
        }
        try data.write(to: URL(fileURLWithPath: outPath))

        let metadata: [String: Any] = [
            "width": image.width,
            "height": image.height,
            "active_app": activeName,
            "active_bundle": activeBundle ?? "",
            "window_title": windowTitle,
            "png_path": outPath,
            "ts": Int(Date().timeIntervalSince1970 * 1000),
        ]
        try emitJSON(metadata)
    }
}
