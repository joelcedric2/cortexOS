// cortexos-vision — tiny CLI entry point.
//
// Subcommands:
//   capture  [--app <bundle-id>] [--out <path>]
//   ocr      --image <path>
//   ax-watch --app <bundle-id> [--text-role]
//
// All results emitted as a single JSON object to stdout. Errors go to stderr
// and the process exits with a non-zero status. When the user has not granted
// Screen Recording permission, we print "permission-denied" to stderr so the
// TypeScript bridge can surface a clean error.
//
// IMPORTANT: This binary makes no network calls. Everything stays on-device.

import Foundation

@main
struct CortexOSVision {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let sub = args.first else {
            printUsage()
            exit(2)
        }
        let rest = Array(args.dropFirst())
        do {
            switch sub {
            case "capture":
                try await CaptureCommand.run(args: rest)
            case "ocr":
                try await OCRCommand.run(args: rest)
            case "ax-watch":
                try await AXWatchCommand.run(args: rest)
            case "--help", "-h", "help":
                printUsage()
            default:
                FileHandle.standardError.write(Data("unknown subcommand: \(sub)\n".utf8))
                printUsage()
                exit(2)
            }
        } catch let err as VisionError {
            FileHandle.standardError.write(Data("\(err.tag)\n".utf8))
            exit(err.code)
        } catch {
            FileHandle.standardError.write(Data("error: \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    private static func printUsage() {
        let usage = """
        cortexos-vision — cortexOS Phase 8 perception helper

        Usage:
          cortexos-vision capture  [--app <bundle-id>] [--out <path>]
          cortexos-vision ocr      --image <path>
          cortexos-vision ax-watch --app <bundle-id> [--text-role]

        Exit codes:
          0  success
          1  generic error
          2  usage error
          3  permission-denied (Screen Recording / Vision / Accessibility not granted)
        """
        print(usage)
    }
}
