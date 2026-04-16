// cortexos-vision — tiny CLI entry point.
//
// Subcommands:
//   capture         [--app <bundle-id>] [--out <path>]
//   ocr             --image <path>
//   camera-capture  --out <path> [--device front|back|continuity]
//   input           click|double-click|move|type|scroll|screenshot
//   ax              find|findAll
//   ax-watch        --app <bundle-id> [--text-role]
//
// All results emitted as a single JSON object to stdout. Errors go to stderr
// and the process exits with a non-zero status. When the user has not granted
// Screen Recording or Camera permission, we print "permission-denied" to
// stderr so the TypeScript bridge can surface a clean error.
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
            case "camera-capture":
                try await CameraCommand.run(args: rest)
            case "input":
                try await InputCommand.run(args: rest)
            case "ax":
                try await AXCommand.run(args: rest)
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
        cortexos-vision — cortexOS Phase 8 perception + Phase 10 actuator helper

        Usage:
          cortexos-vision capture [--app <bundle-id>] [--out <path>]
          cortexos-vision ocr --image <path>
          cortexos-vision camera-capture --out <path> [--device front|back|continuity]
          cortexos-vision input click        --x <n> --y <n> [--button left|right]
          cortexos-vision input double-click --x <n> --y <n>
          cortexos-vision input move         --x <n> --y <n>
          cortexos-vision input type         --text <str> [--delay-ms <n>]
          cortexos-vision input scroll       --x <n> --y <n> --dy <n> [--dx <n>]
          cortexos-vision input screenshot   [--out <path>]
          cortexos-vision ax find            --role <role> [--label <str>] [--app <bundleId>]
          cortexos-vision ax findAll         --role <role> [--app <bundleId>]
          cortexos-vision ax-watch           --app <bundle-id> [--text-role]

        Exit codes:
          0  success
          1  generic error
          2  usage error
          3  permission-denied (Screen Recording / Vision / Camera / Accessibility not granted)
        """
        print(usage)
    }
}
