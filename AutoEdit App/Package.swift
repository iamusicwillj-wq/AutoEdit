// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AutoEditApp",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "AutoEdit", targets: ["AutoEditApp"])
    ],
    targets: [
        .executableTarget(
            name: "AutoEditApp",
            path: "Sources/AutoEditApp",
            resources: [.process("Resources")]
        ),
        .testTarget(name: "AutoEditAppTests", dependencies: ["AutoEditApp"], path: "Tests/Unit")
    ]
)
