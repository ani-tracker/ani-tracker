// swift-tools-version:5.9

import PackageDescription

let package = Package(
    name: "tauri-plugin-ani-mobile",
    platforms: [
        .iOS(.v13)
    ],
    products: [
        .library(
            name: "tauri-plugin-ani-mobile",
            type: .static,
            targets: ["tauri-plugin-ani-mobile"]
        )
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-ani-mobile",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources"
        ),
        .testTarget(
            name: "tauri-plugin-ani-mobile-tests",
            dependencies: ["tauri-plugin-ani-mobile"],
            path: "Tests"
        )
    ]
)
