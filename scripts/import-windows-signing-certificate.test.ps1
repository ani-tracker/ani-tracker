Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# 删除测试证书在指定当前用户证书存储中的全部实例。
function Remove-TestCertificateFromStore {
    param(
        [string]$Thumbprint,
        [System.Security.Cryptography.X509Certificates.StoreName]$StoreName
    )

    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
        $StoreName,
        [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
    )
    try {
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $certificates = $store.Certificates.Find(
            [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
            $Thumbprint,
            $false
        )
        foreach ($certificate in $certificates) {
            $store.Remove($certificate)
        }
    } finally {
        $store.Dispose()
    }
}

# 确认测试证书已写入指定当前用户证书存储。
function Assert-TestCertificateInStore {
    param(
        [string]$Thumbprint,
        [System.Security.Cryptography.X509Certificates.StoreName]$StoreName,
        [bool]$RequirePrivateKey = $false
    )

    $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
        $StoreName,
        [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
    )
    try {
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        $certificates = $store.Certificates.Find(
            [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
            $Thumbprint,
            $false
        )
        if ($certificates.Count -eq 0) {
            throw "测试证书未写入 CurrentUser\\$StoreName"
        }
        if ($RequirePrivateKey -and -not ($certificates | Where-Object HasPrivateKey)) {
            throw "CurrentUser\\$StoreName 中的测试证书缺少私钥"
        }
    } finally {
        $store.Dispose()
    }
}

$storeNames = @(
    [System.Security.Cryptography.X509Certificates.StoreName]::My
)
$testId = [Guid]::NewGuid().ToString("N")
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "ani-tracker-windows-signing-$testId"
$sourcePfxPath = Join-Path $testRoot "source.pfx"
$outputPath = Join-Path $testRoot "github-output.txt"
$importedPfxPath = Join-Path $testRoot "ani-tracker-release.pfx"
$signedFilePath = Join-Path $testRoot "authenticode-test.ps1"
$passwordText = [Guid]::NewGuid().ToString("N")
$password = ConvertTo-SecureString $passwordText -AsPlainText -Force
$thumbprint = $null
$testCertificate = $null
$previousCertificateBase64 = $env:WINDOWS_CERTIFICATE_BASE64
$previousCertificatePassword = $env:WINDOWS_CERTIFICATE_PASSWORD
$previousOutputPath = $env:GITHUB_OUTPUT
$previousRunnerTemp = $env:RUNNER_TEMP

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    Write-Host "[windows-signing-test] 生成一次性代码签名证书"
    $testCertificate = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject "CN=Ani Tracker Signing Test $testId" `
        -CertStoreLocation Cert:\CurrentUser\My `
        -KeyExportPolicy Exportable `
        -NotAfter (Get-Date).AddDays(1)
    $thumbprint = $testCertificate.Thumbprint
    Export-PfxCertificate `
        -Cert $testCertificate `
        -FilePath $sourcePfxPath `
        -Password $password | Out-Null

    foreach ($storeName in $storeNames) {
        Remove-TestCertificateFromStore -Thumbprint $thumbprint -StoreName $storeName
    }

    $env:WINDOWS_CERTIFICATE_BASE64 = [Convert]::ToBase64String(
        [IO.File]::ReadAllBytes($sourcePfxPath)
    )
    $env:WINDOWS_CERTIFICATE_PASSWORD = $passwordText
    $env:GITHUB_OUTPUT = $outputPath
    $env:RUNNER_TEMP = $testRoot

    Write-Host "[windows-signing-test] 执行生产证书导入脚本"
    $productionScriptPath = Join-Path (Get-Location) "scripts/import-windows-signing-certificate.ps1"
    $productionScriptContent = [IO.File]::ReadAllText(
        $productionScriptPath,
        [Text.Encoding]::UTF8
    )
    & ([ScriptBlock]::Create($productionScriptContent))

    $actualOutput = Get-Content -LiteralPath $outputPath
    if ($actualOutput -notcontains "thumbprint=$thumbprint") {
        throw "生产脚本未输出预期证书指纹"
    }
    Assert-TestCertificateInStore `
        -Thumbprint $thumbprint `
        -StoreName ([System.Security.Cryptography.X509Certificates.StoreName]::My) `
        -RequirePrivateKey $true

    Write-Host "[windows-signing-test] 校验 Authenticode 签名状态"
    [IO.File]::WriteAllText(
        $signedFilePath,
        "Write-Output 'Ani Tracker signing test'`r`n",
        [Text.Encoding]::UTF8
    )
    $importedCertificate = Get-Item "Cert:\CurrentUser\My\$thumbprint"
    Set-AuthenticodeSignature `
        -FilePath $signedFilePath `
        -Certificate $importedCertificate `
        -HashAlgorithm SHA256 | Out-Null
    $verificationScriptPath = Join-Path (Get-Location) "scripts/verify-windows-self-signature.ps1"
    $verificationScriptContent = [IO.File]::ReadAllText(
        $verificationScriptPath,
        [Text.Encoding]::UTF8
    )
    $verificationScript = [ScriptBlock]::Create($verificationScriptContent)
    & $verificationScript -FilePath $signedFilePath -ExpectedThumbprint $thumbprint

    Write-Host "[windows-signing-test] 确认错误证书指纹会被拒绝"
    $wrongThumbprintRejected = $false
    try {
        & $verificationScript `
            -FilePath $signedFilePath `
            -ExpectedThumbprint ("0" * $thumbprint.Length)
    } catch {
        $wrongThumbprintRejected = $true
    }
    if (-not $wrongThumbprintRejected) {
        throw "错误证书指纹未被 Authenticode 校验拒绝"
    }

    Write-Host "[windows-signing-test] 确认篡改后的文件会被拒绝"
    Add-Content -LiteralPath $signedFilePath -Value "# tampered"
    $tamperedFileRejected = $false
    try {
        & $verificationScript -FilePath $signedFilePath -ExpectedThumbprint $thumbprint
    } catch {
        $tamperedFileRejected = $true
    }
    if (-not $tamperedFileRejected) {
        throw "篡改后的测试文件未被 Authenticode 校验拒绝"
    }
    Write-Host "[windows-signing-test] 自签名通过且篡改文件已被拒绝"
} finally {
    if ($thumbprint) {
        foreach ($storeName in $storeNames) {
            Remove-TestCertificateFromStore -Thumbprint $thumbprint -StoreName $storeName
        }
    }
    if ($testCertificate) {
        $testCertificate.Dispose()
    }
    $env:WINDOWS_CERTIFICATE_BASE64 = $previousCertificateBase64
    $env:WINDOWS_CERTIFICATE_PASSWORD = $previousCertificatePassword
    $env:GITHUB_OUTPUT = $previousOutputPath
    $env:RUNNER_TEMP = $previousRunnerTemp

    foreach ($path in @($sourcePfxPath, $outputPath, $importedPfxPath, $signedFilePath)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-Item -LiteralPath $path -Force
        }
    }
    if (Test-Path -LiteralPath $testRoot -PathType Container) {
        Remove-Item -LiteralPath $testRoot -Force
    }
}
