package dev.ani.tracker.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 验证 Android 原生外链边界不会绕过 Rust 协议白名单。 */
class ExternalUrlPolicyTest {
    /** 接受标准 HTTP/HTTPS，并将国际域名转换为 ASCII。 */
    @Test
    fun normalizesAllowedWebUrls() {
        assertEquals(
            "https://example.com/anime/1",
            ExternalUrlPolicy.normalize("https://example.com/anime/1")
        )
        assertEquals(
            "https://xn--fsqu00a.xn--0zwm56d/path",
            ExternalUrlPolicy.normalize("https://xn--fsqu00a.xn--0zwm56d/path")
        )
    }

    /** 拒绝本地文件、脚本、无主机地址和内嵌凭据。 */
    @Test
    fun rejectsUnsafeUrls() {
        assertNull(ExternalUrlPolicy.normalize("file:///data/user/0/secret"))
        assertNull(ExternalUrlPolicy.normalize("javascript:alert(1)"))
        assertNull(ExternalUrlPolicy.normalize("https:///missing-host"))
        assertNull(ExternalUrlPolicy.normalize("https://user:password@example.com"))
    }
}
