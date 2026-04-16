import Foundation
import CoreGraphics
import ImageIO
import Vision

/// Apple Vision OCR on a PNG file.
///
/// Emits { blocks: [ { text, bbox:{x,y,w,h}, confidence } ], duration_ms }.
/// bbox is in pixel coordinates with origin top-left (matches the PNG).
enum OCRCommand {
    static func run(args: [String]) async throws {
        let parsed = try ArgMap(args)
        let imagePath = try parsed.require("image")

        let url = URL(fileURLWithPath: imagePath)
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw VisionError.ocrFailed("cannot read image: \(imagePath)")
        }

        let width = CGFloat(cgImage.width)
        let height = CGFloat(cgImage.height)

        let start = Date()
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            throw VisionError.ocrFailed(error.localizedDescription)
        }

        var blocks: [[String: Any]] = []
        var allText: [String] = []

        for obs in (request.results ?? []) {
            guard let best = obs.topCandidates(1).first else { continue }
            // Vision returns normalized bbox with origin bottom-left.
            let r = obs.boundingBox
            let px = r.origin.x * width
            let py = (1.0 - r.origin.y - r.size.height) * height
            let pw = r.size.width * width
            let ph = r.size.height * height
            blocks.append([
                "text": best.string,
                "bbox": [
                    "x": Int(px.rounded()),
                    "y": Int(py.rounded()),
                    "w": Int(pw.rounded()),
                    "h": Int(ph.rounded()),
                ],
                "confidence": Double(best.confidence),
            ])
            allText.append(best.string)
        }

        let duration = Int(Date().timeIntervalSince(start) * 1000)
        try emitJSON([
            "blocks": blocks,
            "text": allText.joined(separator: "\n"),
            "duration_ms": duration,
        ])
    }
}
