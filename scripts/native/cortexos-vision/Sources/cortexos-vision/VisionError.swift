import Foundation

enum VisionError: Error {
    case permissionDenied
    case noMatchingWindow
    case invalidArgs(String)
    case captureFailed(String)
    case ocrFailed(String)

    var tag: String {
        switch self {
        case .permissionDenied: return "permission-denied"
        case .noMatchingWindow: return "no-matching-window"
        case .invalidArgs(let s): return "invalid-args: \(s)"
        case .captureFailed(let s): return "capture-failed: \(s)"
        case .ocrFailed(let s): return "ocr-failed: \(s)"
        }
    }

    var code: Int32 {
        switch self {
        case .permissionDenied: return 3
        case .invalidArgs: return 2
        default: return 1
        }
    }
}

/// Minimal arg parser — accepts `--key value` pairs.
struct ArgMap {
    let values: [String: String]

    init(_ args: [String]) throws {
        var map: [String: String] = [:]
        var i = 0
        while i < args.count {
            let a = args[i]
            guard a.hasPrefix("--") else {
                throw VisionError.invalidArgs("unexpected positional: \(a)")
            }
            let key = String(a.dropFirst(2))
            let next = i + 1 < args.count ? args[i + 1] : nil
            if let v = next, !v.hasPrefix("--") {
                map[key] = v
                i += 2
            } else {
                map[key] = "true"
                i += 1
            }
        }
        self.values = map
    }

    func require(_ key: String) throws -> String {
        guard let v = values[key] else {
            throw VisionError.invalidArgs("missing --\(key)")
        }
        return v
    }

    func get(_ key: String) -> String? {
        return values[key]
    }
}

/// Write a dictionary as compact JSON to stdout (+ trailing newline).
func emitJSON(_ obj: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}
