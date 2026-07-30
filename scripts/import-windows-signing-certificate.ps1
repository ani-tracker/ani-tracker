param(
    [string]$CertificateBase64 = $env:WINDOWS_CERTIFICATE_BASE64,
    [string]$CertificatePassword = $env:WINDOWS_CERTIFICATE_PASSWORD,
    [string]$OutputPath = $env:GITHUB_OUTPUT,
    [string]$WorkingDirectory = $env:RUNNER_TEMP
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($CertificateBase64)) {
    throw "WINDOWS_CERTIFICATE_BASE64 不能为空"
}
if ([string]::IsNullOrWhiteSpace($CertificatePassword)) {
    throw "WINDOWS_CERTIFICATE_PASSWORD 不能为空"
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    throw "GITHUB_OUTPUT 或 -OutputPath 不能为空"
}
if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $WorkingDirectory = [IO.Path]::GetTempPath()
}
if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
    throw "证书临时目录不存在：$WorkingDirectory"
}

$certificatePath = Join-Path $WorkingDirectory "ani-tracker-release.pfx"
try {
    Write-Host "[windows-signing] 解码 PFX 证书"
    [IO.File]::WriteAllBytes(
        $certificatePath,
        [Convert]::FromBase64String($CertificateBase64)
    )
    $password = ConvertTo-SecureString $CertificatePassword -AsPlainText -Force

    Write-Host "[windows-signing] 导入签名证书到 CurrentUser\\My"
    $importedCertificates = @(
        Import-PfxCertificate `
            -FilePath $certificatePath `
            -CertStoreLocation Cert:\CurrentUser\My `
            -Password $password
    )
    $certificate = $importedCertificates |
        Where-Object HasPrivateKey |
        Select-Object -First 1
    if (-not $certificate) {
        throw "Windows 自签证书不包含私钥"
    }

    Write-Host "[windows-signing] 校验自签证书、有效期和代码签名用途"
    if ($certificate.Subject -ne $certificate.Issuer) {
        throw "Windows 签名证书必须为自签证书"
    }
    $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
    try {
        $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority
        if (-not $chain.Build($certificate) -or $chain.ChainElements.Count -ne 1) {
            throw "Windows 自签证书的密码学签名校验失败"
        }
    } finally {
        $chain.Dispose()
    }
    if ($certificate.NotAfter -le (Get-Date)) {
        throw "Windows 自签证书已过期"
    }
    $codeSigningEku = $certificate.Extensions |
        Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } |
        ForEach-Object { $_.EnhancedKeyUsages } |
        Where-Object { $_.Value -eq "1.3.6.1.5.5.7.3.3" }
    if (-not $codeSigningEku) {
        throw "Windows 自签证书缺少 Code Signing EKU"
    }

    Add-Content -LiteralPath $OutputPath -Value "thumbprint=$($certificate.Thumbprint)" -Encoding utf8
    Write-Host "[windows-signing] Windows 自签证书私钥导入完成"
} finally {
    if (Test-Path -LiteralPath $certificatePath -PathType Leaf) {
        Remove-Item -LiteralPath $certificatePath -Force
    }
}
