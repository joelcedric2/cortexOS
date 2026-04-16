import Foundation
import AVFoundation
import AppKit
import CoreImage

/// Phase 9 — one-shot camera capture via AVFoundation.
///
/// Takes a single JPEG frame from the selected camera (front / back /
/// continuity / default) and writes it to --out. On success emits a JSON
/// metadata object with width / height / device / jpeg_path / ts.
///
/// PRIVACY: strictly one-shot. The session is stopped and torn down the
/// moment the first valid sample lands. There is deliberately no loop API
/// here — the TypeScript wrapper calls this binary exactly once per frame.
///
/// Permission: macOS requires Camera access (TCC). If the user denies (or
/// has not yet granted) access the helper prints `permission-denied` on
/// stderr and exits with code 3 — same shape as the ScreenCaptureKit path.
enum CameraCommand {
    static func run(args: [String]) async throws {
        let parsed = try ArgMap(args)
        let outPath = try parsed.require("out")
        let deviceTag = parsed.get("device") ?? "front"

        try await ensureCameraAuthorized()

        guard let device = pickDevice(for: deviceTag) else {
            throw VisionError.captureFailed("no camera matched device=\(deviceTag)")
        }

        let session = AVCaptureSession()
        session.sessionPreset = .photo

        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            throw VisionError.captureFailed(
                "cannot open camera: \(error.localizedDescription)"
            )
        }
        guard session.canAddInput(input) else {
            throw VisionError.captureFailed("session rejected camera input")
        }
        session.addInput(input)

        let photoOutput = AVCapturePhotoOutput()
        guard session.canAddOutput(photoOutput) else {
            throw VisionError.captureFailed("session rejected photo output")
        }
        session.addOutput(photoOutput)

        session.startRunning()
        defer {
            session.stopRunning()
            session.inputs.forEach { session.removeInput($0) }
            session.outputs.forEach { session.removeOutput($0) }
        }

        // AVFoundation cameras need a moment after startRunning() before
        // they will actually yield a frame — one warm-up tick is enough.
        try await Task.sleep(nanoseconds: 200_000_000) // 200ms

        let settings = AVCapturePhotoSettings(
            format: [AVVideoCodecKey: AVVideoCodecType.jpeg]
        )

        let delegate = PhotoCollector()
        // Retain delegate across the async await.
        let jpegData: Data = try await withCheckedThrowingContinuation { cont in
            delegate.completion = { result in
                switch result {
                case .success(let data): cont.resume(returning: data)
                case .failure(let err): cont.resume(throwing: err)
                }
            }
            photoOutput.capturePhoto(with: settings, delegate: delegate)
        }

        let (width, height) = dimensions(for: jpegData)

        try jpegData.write(to: URL(fileURLWithPath: outPath), options: .atomic)

        let metadata: [String: Any] = [
            "width": width,
            "height": height,
            "device": deviceLabel(for: device, requested: deviceTag),
            "jpeg_path": outPath,
            "bytes": jpegData.count,
            "ts": Int(Date().timeIntervalSince1970 * 1000),
        ]
        try emitJSON(metadata)
    }

    // ─── Permission ────────────────────────────────────────────────────

    private static func ensureCameraAuthorized() async throws {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            return
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            if !granted { throw VisionError.permissionDenied }
        case .denied, .restricted:
            throw VisionError.permissionDenied
        @unknown default:
            throw VisionError.permissionDenied
        }
    }

    // ─── Device discovery ──────────────────────────────────────────────

    private static func pickDevice(for tag: String) -> AVCaptureDevice? {
        let devices = discoverDevices()

        switch tag {
        case "continuity":
            // Continuity Camera shows up as .external (macOS 14+) or as an
            // .externalUnknown on older SDKs; our helper matches either via
            // `isExternalCamera`.
            if let external = devices.first(where: isExternalCamera) {
                return external
            }
            // Fall through to any available camera if no external found.
            return devices.first
        case "back":
            if let back = devices.first(where: { $0.position == .back }) {
                return back
            }
            return devices.first
        case "front":
            fallthrough
        default:
            if let front = devices.first(where: { $0.position == .front }) {
                return front
            }
            // macOS laptops report the built-in FaceTime camera as .unspecified
            // — treat the first wide-angle camera as "front" in that case.
            if let wide = devices.first(where: {
                $0.deviceType == .builtInWideAngleCamera
            }) {
                return wide
            }
            return devices.first
        }
    }

    private static func discoverDevices() -> [AVCaptureDevice] {
        // Continuity Camera support (AVCaptureDevice.DeviceType.external) is
        // macOS 14+. On macOS 13 we fall back to builtIn + .externalUnknown.
        var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
        if #available(macOS 14.0, *) {
            types.append(.external)
        } else {
            #if os(macOS)
            // .externalUnknown is deprecated on macOS 14 but still valid on 13.
            types.append(.externalUnknown)
            #endif
        }
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: types,
            mediaType: .video,
            position: .unspecified
        )
        return session.devices
    }

    private static func isExternalCamera(_ device: AVCaptureDevice) -> Bool {
        if #available(macOS 14.0, *) {
            if device.deviceType == .external { return true }
        }
        #if os(macOS)
        if device.deviceType == .externalUnknown { return true }
        #endif
        return false
    }

    private static func deviceLabel(
        for device: AVCaptureDevice,
        requested: String
    ) -> String {
        // Prefer the requested tag when it matches common categories; fall
        // back to the device's localized name for external/continuity so the
        // TS layer can tell them apart.
        if isExternalCamera(device) { return "continuity" }
        if device.position == .back { return "back" }
        if device.position == .front { return "front" }
        return requested
    }

    // ─── JPEG dimension sniff ──────────────────────────────────────────

    private static func dimensions(for jpeg: Data) -> (Int, Int) {
        guard let img = NSImage(data: jpeg) else { return (0, 0) }
        // NSImage size is in points; convert via CGImage for pixel truth.
        var rect = CGRect(origin: .zero, size: img.size)
        if let cg = img.cgImage(
            forProposedRect: &rect,
            context: nil,
            hints: nil
        ) {
            return (cg.width, cg.height)
        }
        return (Int(img.size.width), Int(img.size.height))
    }
}

/// Thin delegate wrapper — AVCapturePhotoOutput needs a concrete
/// AVCapturePhotoCaptureDelegate; we bridge it to a checked continuation
/// so the rest of the command reads top-to-bottom.
private final class PhotoCollector: NSObject, AVCapturePhotoCaptureDelegate {
    var completion: ((Result<Data, Error>) -> Void)?

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        if let error = error {
            completion?(.failure(
                VisionError.captureFailed("photo capture error: \(error.localizedDescription)")
            ))
            return
        }
        guard let data = photo.fileDataRepresentation() else {
            completion?(.failure(
                VisionError.captureFailed("photo has no JPEG data")
            ))
            return
        }
        completion?(.success(data))
    }
}
