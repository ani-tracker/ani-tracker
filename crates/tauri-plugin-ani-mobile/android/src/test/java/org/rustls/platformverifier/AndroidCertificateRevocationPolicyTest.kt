package org.rustls.platformverifier

import java.security.cert.PKIXRevocationChecker
import java.util.EnumSet
import org.junit.Assert.assertEquals
import org.junit.Test

/** 验证 Android TLS 不会因证书缺少 OCSP 地址而误报吊销。 */
class AndroidCertificateRevocationPolicyTest {
    /** 固定 CRL 优先、禁止回退和软失败策略。 */
    @Test
    fun prefersCrlAndKeepsRevocationSoftFailure() {
        assertEquals(
            EnumSet.of(
                PKIXRevocationChecker.Option.SOFT_FAIL,
                PKIXRevocationChecker.Option.ONLY_END_ENTITY,
                PKIXRevocationChecker.Option.PREFER_CRLS,
                PKIXRevocationChecker.Option.NO_FALLBACK
            ),
            AndroidCertificateRevocationPolicy.options()
        )
    }
}
