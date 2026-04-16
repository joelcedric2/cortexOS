import Foundation
import AVFoundation
import AppKit

/// Phase 9.5 — short video clip capture via AVFoundation.
///
/// Records a short H.264 / 720p MP4 clip (default 10s) from the selected
/// camera and writes it to --out. On success emits JSON with duration_sec,
/// width, height, bytes, device.
///
/// PRIVACY: the session is torn down the instant the writer finishes, and
/// the clip is bounded by `--duration` (default 10s, max 60s). There is NO
/// continuous-recording API here — every invocation writes exactly one
/// short clip and exits, just like `camera-capture` writes exactly one
/// still.
///
/// Permission: shares `ensureCameraAuthorized()` semantics with
/// CameraCommand — denial yields `permission-denied` on stderr + exit 3.
enum CameraRecordCommand {
    static func run(args: [String]) async throws {
        let parsed = try ArgMap(args)
        let outPath = try parsed.require("out")
        let deviceTag = parsed.get("device") ?? "front"

        let durationArg = parsed.get("duration") ?? "10"
        guard let durationSec = Double(durationArg), durationSec >= 1.0, durationSec <= 60.0 else {
            throw VisionError.invalidArgs(
                "--duration must be between 1 and 60 seconds (got \(durationArg))"
            )
        }

        try await ensureCameraAuthorized()

        guard let device = pickDevice(for: deviceTag) else {
            throw VisionError.captureFailed("no camera matched device=\(deviceTag)")
        }

        let session = AVCaptureSession()
        session.sessionPreset = .hd1280x720

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

        let movieOutput = AVCaptureMovieFileOutput()
        guard session.canAddOutput(movieOutput) else {
            throw VisionError.captureFailed("session rejected movie output")
        }
        session.addOutput(movieOutput)

        // Cap the recording length inside AVFoundation as a belt-and-
        // suspenders measure — the async sleep below should stop first.
        let maxDuration = CMTime(seconds: durationSec, preferredTimescale: 600)
        movieOutput.maxRecordedDuration = maxDuration

        session.startRunning()
        defer {
            session.stopRunning()
            session.inputs.forEach { session.removeInput($0) }
            session.outputs.forEach { session.removeOutput($0) }
        }

        // Warm-up the sensor before starting the writer.
        try await Task.sleep(nanoseconds: 200_000_000) // 200ms

        // Clear any existing file — AVCaptureMovieFileOutput refuses to
        // overwrite.
        let outURL = URL(fileURLWithPath: outPath)
        try? FileManager.default.removeItem(at: outURL)

        let delegate = MovieCollector()
        let finishedURL: URL = try await withCheckedThrowingContinuation { cont in
            delegate.completion = { result in
                switch result {
                case .success(let url): cont.resume(returning: url)
                case .failure(let err): cont.resume(throwing: err)
                }
            }
            movieOutput.startRecording(to: outURL, recordingDelegate: delegate)

            // Stop the recording after the requested duration. The delegate
            // will be invoked with didFinishRecordingTo once the file is
            // flushed to disk.
            let ns = UInt64(durationSec * 1_000_000_000)
            Task {
                try? await Task.sleep(nanoseconds: ns)
                if movieOutput.isRecording {
                    movieOutput.stopRecording()
                }
            }
        }

        let (width, height) = videoDimensions(for: finishedURL)
        let bytes = fileByteCount(at: finishedURL)
        let actualDuration = videoDurationSec(for: finishedURL) ?? durationSec

        let metadata: [String: Any] = [
            "video_path": finishedURL.path,
            "duration_sec": actualDuration,
            "width": width,
            "height": height,
            "bytes": bytes,
            "device": deviceLabel(for: device, requested: deviceTag),
            "ts": Int(Date().timeIntervalSince1970 * 1000),
        ]
        try emitJSON(metadata)
    }

    // ─── Permission (shared shape with CameraCommand) ─────────────────

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

    // ─── Device discovery (mirrors CameraCommand) ─────────────────────

    private static func pickDevice(for tag: String) -> AVCaptureDevice? {
        let devices = discoverDevices()
        switch tag {
        case "continuity":
            if let external = devices.first(where: isExternalCamera) { return external }
            return devices.first
        case "back":
            if let back = devices.first(where: { $0.position == .back }) { return back }
            return devices.first
        case "front":
            fallthrough
        default:
            if let front = devices.first(where: { $0.position == .front }) { return front }
            if let wide = devices.first(where: {
                $0.deviceType == .builtInWideAngleCamera
            }) { return wide }
            return devices.first
        }
    }

    private static func discoverDevices() -> [AVCaptureDevice] {
        var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
        if #available(macOS 14.0, *) {
            types.append(.external)
        } else {
            #if os(macOS)
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
        if isExternalCamera(device) { return "continuity" }
        if device.position == .back { return "back" }
        if device.position == .front { return "front" }
        return requested
    }

    // ─── File + asset inspection ──────────────────────────────────────

    private static func videoDimensions(for url: URL) -> (Int, Int) {
        let asset = AVAsset(url: url)
        guard let track = asset.tracks(withMediaType: .video).first else {
            return (0, 0)
        }
        let size = track.naturalSize.applying(track.preferredTransform)
        return (Int(abs(size.width)), Int(abs(size.height)))
    }

    private static func videoDurationSec(for url: URL) -> Double? {
        let asset = AVAsset(url: url)
        let d = asset.duration.seconds
        if d.isFinite && d > 0 { return d }
        return nil
    }

    private static func fileByteCount(at url: URL) -> Int {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.size] as? Int) ?? 0
    }
}

/// Bridges the AVCaptureFileOutputRecordingDelegate → checked continuation.
private final class MovieCollector: NSObject, AVCaptureFileOutputRecordingDelegate {
    var completion: ((Result<URL, Error>) -> Void)?

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        // AVCaptureMovieFileOutput reports an error with code
        // `maximumDurationReached` even on successful duration-capped
        // clips. Treat that as success when the file is non-empty.
        if let error = error {
            let nsErr = error as NSError
            let isMaxDuration = nsErr.domain == AVFoundationErrorDomain
                && nsErr.code == AVError.maximumDurationReached.rawValue
            let haveFile = FileManager.default.fileExists(atPath: outputFileURL.path)
            let attrs = try? FileManager.default.attributesOfItem(
                atPath: outputFileURL.path
            )
            let size = (attrs?[.size] as? Int) ?? 0
            if isMaxDuration && haveFile && size > 0 {
                completion?(.success(outputFileURL))
                return
            }
            completion?(.failure(
                VisionError.captureFailed(
                    "movie recording failed: \(error.localizedDescription)"
                )
            ))
            return
        }
        completion?(.success(outputFileURL))
    }
}
