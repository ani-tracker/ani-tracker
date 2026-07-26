import XCTest
@testable import tauri_plugin_ani_mobile

/** 验证 iOS 原生外链边界不会绕过 Rust 协议白名单。 */
final class ExternalUrlPolicyTests: XCTestCase {
    /** 接受标准 HTTP/HTTPS 外链。 */
    func testNormalizesAllowedWebURLs() {
        XCTAssertEqual(
            ExternalUrlPolicy.normalize("https://example.com/anime/1")?.absoluteString,
            "https://example.com/anime/1"
        )
        XCTAssertNotNil(ExternalUrlPolicy.normalize("http://example.com"))
    }

    /** 拒绝本地文件、脚本、无主机地址和内嵌凭据。 */
    func testRejectsUnsafeURLs() {
        XCTAssertNil(ExternalUrlPolicy.normalize("file:///private/secret"))
        XCTAssertNil(ExternalUrlPolicy.normalize("javascript:alert(1)"))
        XCTAssertNil(ExternalUrlPolicy.normalize("https:///missing-host"))
        XCTAssertNil(ExternalUrlPolicy.normalize("https://user:password@example.com"))
    }
}
