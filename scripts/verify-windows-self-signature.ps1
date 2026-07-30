param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedThumbprint
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    throw "待校验的 Windows 产物不存在：$FilePath"
}

$expected = $ExpectedThumbprint.Replace(" ", "").ToUpperInvariant()
$signature = Get-AuthenticodeSignature -LiteralPath $FilePath
if (-not $signature.SignerCertificate) {
    throw "Windows 产物未包含 Authenticode 签名：$FilePath"
}
$actual = $signature.SignerCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant()
if ($actual -ne $expected) {
    throw "Windows 产物签名证书指纹不匹配：$FilePath"
}

if ($signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid) {
    Write-Host "[windows-signing] Authenticode 签名与受信证书链校验通过：$FilePath"
    return
}
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::UnknownError) {
    throw "Windows 产物 Authenticode 签名无效：$FilePath [$($signature.Status)]"
}

$certificate = $signature.SignerCertificate
if ($certificate.Subject -ne $certificate.Issuer) {
    throw "Windows 产物的未受信签名证书不是自签证书：$FilePath"
}
$chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
try {
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    [void]$chain.ChainPolicy.ApplicationPolicy.Add(
        [System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.3")
    )
    [void]$chain.Build($certificate)
    if ($chain.ChainElements.Count -ne 1) {
        throw "Windows 自签证书链必须仅包含签名证书本身：$FilePath"
    }
    $combinedStatus = [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::NoError
    foreach ($chainStatus in $chain.ChainStatus) {
        $combinedStatus = [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags](
            [int]$combinedStatus -bor [int]$chainStatus.Status
        )
    }
    if ($combinedStatus -ne [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::UntrustedRoot) {
        throw "Windows 自签证书链存在非预期错误：$FilePath [$combinedStatus]"
    }
} finally {
    $chain.Dispose()
}

Write-Host "[windows-signing] Authenticode 文件哈希、证书指纹与自签链校验通过（仅根证书不受信）：$FilePath"
