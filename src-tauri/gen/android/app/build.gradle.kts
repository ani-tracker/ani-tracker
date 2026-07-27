import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val releaseKeystorePath = System.getenv("ANI_ANDROID_KEYSTORE_PATH").orEmpty()
val releaseKeystorePassword = System.getenv("ANI_ANDROID_KEYSTORE_PASSWORD").orEmpty()
val releaseKeyAlias = System.getenv("ANI_ANDROID_KEY_ALIAS").orEmpty()
val releaseKeyPassword = System.getenv("ANI_ANDROID_KEY_PASSWORD").orEmpty()
val releaseSigningEnabled = listOf(
    releaseKeystorePath,
    releaseKeystorePassword,
    releaseKeyAlias,
    releaseKeyPassword
).all(String::isNotBlank)

/** 通过 Cargo 元数据定位与 Rust verifier 版本配套的本地 Maven 仓库。 */
fun findRustlsPlatformVerifierRepository(): File {
    val workspaceRoot = rootProject.projectDir.resolve("../../..").canonicalFile
    val metadataText = providers.exec {
        workingDir = workspaceRoot
        commandLine(
            "cargo",
            "metadata",
            "--format-version",
            "1",
            "--filter-platform",
            "aarch64-linux-android",
            "--manifest-path",
            workspaceRoot.resolve("crates/tauri-plugin-ani-mobile/Cargo.toml").path
        )
    }.standardOutput.asText.get()
    val metadata = JsonSlurper().parseText(metadataText) as Map<*, *>
    val packages = metadata["packages"] as? List<*>
        ?: throw GradleException("Cargo 元数据缺少 packages")
    val verifierPackage = packages
        .filterIsInstance<Map<*, *>>()
        .firstOrNull { it["name"] == "rustls-platform-verifier-android" }
        ?: throw GradleException("Cargo 元数据缺少 rustls-platform-verifier-android")
    val manifestPath = verifierPackage["manifest_path"]?.toString()
        ?: throw GradleException("Android verifier 缺少 manifest_path")
    return file(manifestPath).parentFile.resolve("maven")
}

repositories {
    maven {
        url = uri(findRustlsPlatformVerifierRepository())
        metadataSources { artifact() }
    }
}

// 正式 Release 不允许静默退化为未签名 APK。
if (gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) } && !releaseSigningEnabled) {
    throw GradleException(
        "Android Release 必须配置 ANI_ANDROID_KEYSTORE_PATH、ANI_ANDROID_KEYSTORE_PASSWORD、" +
            "ANI_ANDROID_KEY_ALIAS 和 ANI_ANDROID_KEY_PASSWORD"
    )
}

android {
    compileSdk = 36
    namespace = "com.ani.tracker"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.ani.tracker"
        minSdk = 26
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (releaseSigningEnabled) {
            create("release") {
                storeFile = file(releaseKeystorePath)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("rustls:rustls-platform-verifier:latest.release")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
