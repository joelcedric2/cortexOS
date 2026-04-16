// swift-tools-version:5.9
// cortexos-vision — native helper for cortexOS Phase 8 (screen perception).
// Uses ScreenCaptureKit + Apple Vision. No network. All output on stdout.

import PackageDescription

let package = Package(
    name: "cortexos-vision",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "cortexos-vision", targets: ["cortexos-vision"]),
    ],
    targets: [
        .executableTarget(
            name: "cortexos-vision",
            path: "Sources/cortexos-vision"
        ),
    ]
)
