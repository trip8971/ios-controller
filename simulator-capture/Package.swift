// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "simulator-capture",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "simulator-capture",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("AppKit"),
            ]
        )
    ]
)
