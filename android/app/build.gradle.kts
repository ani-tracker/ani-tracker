plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystorePath = providers.environmentVariable("ANDROID_KEYSTORE_PATH").orNull
val keystoreAlias = providers.environmentVariable("ANDROID_KEY_ALIAS").orNull
val keystorePassword = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD").orNull
val keyPassword = providers.environmentVariable("ANDROID_KEY_PASSWORD").orNull
val hasReleaseSigning = listOf(keystorePath, keystoreAlias, keystorePassword, keyPassword).all { !it.isNullOrBlank() }

android {
    namespace = "dev.ani.tracker.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.ani.tracker"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                keyAlias = keystoreAlias
                keyPassword = keyPassword
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(project(":torrent-host"))
}
