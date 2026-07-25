// swift-tools-version:5.9

import PackageDescription

let package = Package(
    name: "tauri-plugin-ani-player",
    platforms: [
        .iOS(.v16)
    ],
    products: [
        .library(
            name: "tauri-plugin-ani-player",
            type: .static,
            targets: ["tauri-plugin-ani-player"]
        )
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .binaryTarget(
            name: "MobileVLCKit",
            path: "Frameworks/MobileVLCKit.xcframework"
        ),
        .target(
            name: "tauri-plugin-ani-player",
            dependencies: [
                .byName(name: "Tauri"),
                .byName(name: "MobileVLCKit")
            ],
            path: "Sources"
        ),
        .testTarget(
            name: "tauri-plugin-ani-player-tests",
            dependencies: ["tauri-plugin-ani-player"],
            path: "Tests"
        )
    ]
)
