package org.rustls.platformverifier

import java.security.cert.PKIXRevocationChecker
import java.util.EnumSet

/** 定义 Android 证书撤销检查策略，兼容不再提供 OCSP 地址的公开证书。 */
internal object AndroidCertificateRevocationPolicy {
    /** 优先使用 CRL 且允许网络撤销服务不可用，但仍拒绝明确吊销的证书。 */
    fun options(): EnumSet<PKIXRevocationChecker.Option> = EnumSet.of(
        PKIXRevocationChecker.Option.SOFT_FAIL,
        PKIXRevocationChecker.Option.ONLY_END_ENTITY,
        PKIXRevocationChecker.Option.PREFER_CRLS,
        PKIXRevocationChecker.Option.NO_FALLBACK
    )
}
