// swift-tools-version:5.9

import PackageDescription

let package = Package(
    name: "tauri-plugin-ani-torrent",
    platforms: [
        .iOS(.v13)
    ],
    products: [
        .library(
            name: "tauri-plugin-ani-torrent",
            type: .static,
            targets: ["tauri-plugin-ani-torrent"]
        )
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .binaryTarget(
            name: "AniTorrentCore",
            path: "Frameworks/AniTorrentCore.xcframework"
        ),
        .target(
            name: "tauri-plugin-ani-torrent",
            dependencies: [
                .byName(name: "Tauri"),
                .byName(name: "AniTorrentCore")
            ],
            path: "Sources"
        )
    ]
)
