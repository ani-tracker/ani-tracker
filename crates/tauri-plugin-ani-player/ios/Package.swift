// swift-tools-version:5.9

import Foundation
import PackageDescription

/** 从 XCFramework 清单中返回当前 iOS SDK 可用的模块搜索参数。 */
private func xcframeworkSearchFlags(named name: String) -> [String] {
    let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let frameworkRoot = packageRoot.appendingPathComponent("Frameworks/\(name).xcframework")
    let infoURL = frameworkRoot.appendingPathComponent("Info.plist")
    guard let data = try? Data(contentsOf: infoURL),
          let plist = try? PropertyListSerialization.propertyList(
              from: data,
              options: [],
              format: nil
          ),
          let root = plist as? [String: Any],
          let libraries = root["AvailableLibraries"] as? [[String: Any]] else {
        return []
    }

    let environment = ProcessInfo.processInfo.environment
    let platformHints = [
        environment["SDKROOT"],
        environment["PLATFORM_NAME"],
        environment["EFFECTIVE_PLATFORM_NAME"],
        environment["CARGO_BUILD_TARGET"]
    ]
    .compactMap { $0?.lowercased() }
    .joined(separator: " ")
    let expectsSimulator = platformHints.contains("simulator")
    let expectsDevice = !expectsSimulator
        && (platformHints.contains("iphoneos") || platformHints.contains("apple-ios"))

    let candidates = libraries.compactMap { library -> (String, Bool)? in
        guard library["SupportedPlatform"] as? String == "ios",
              let identifier = library["LibraryIdentifier"] as? String,
              let libraryPath = library["LibraryPath"] as? String,
              libraryPath.hasSuffix(".framework") else {
            return nil
        }
        let simulator = library["SupportedPlatformVariant"] as? String == "simulator"
        if expectsSimulator && !simulator { return nil }
        if expectsDevice && simulator { return nil }
        return (identifier, simulator)
    }
    let selected = candidates.isEmpty
        ? libraries.compactMap { library -> (String, Bool)? in
            guard library["SupportedPlatform"] as? String == "ios",
                  let identifier = library["LibraryIdentifier"] as? String else {
                return nil
            }
            return (identifier, library["SupportedPlatformVariant"] as? String == "simulator")
        }
        : candidates

    return selected
        .sorted { lhs, rhs in
            if lhs.1 != rhs.1 { return !lhs.1 }
            return lhs.0 < rhs.0
        }
        .map { candidate in
            "-F\(frameworkRoot.appendingPathComponent(candidate.0).path)"
        }
}

let mobileVLCKitSearchFlags = xcframeworkSearchFlags(named: "MobileVLCKit")

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
            path: "Sources",
            swiftSettings: mobileVLCKitSearchFlags.isEmpty
                ? []
                : [.unsafeFlags(mobileVLCKitSearchFlags)]
        ),
        .testTarget(
            name: "tauri-plugin-ani-player-tests",
            dependencies: ["tauri-plugin-ani-player"],
            path: "Tests"
        )
    ]
)
