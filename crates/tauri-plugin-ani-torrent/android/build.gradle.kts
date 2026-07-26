plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val nativeRoot = providers.environmentVariable("ANI_ANDROID_NATIVE_ROOT")
    .orElse(project.layout.projectDirectory.dir("../../../.cache/android-torrent/vcpkg_installed").asFile.absolutePath)
    .get()
val targetAbis = ((findProperty("aniAndroidAbis") as String?) ?: "arm64-v8a")
    .split(',')
    .map(String::trim)
    .filter(String::isNotEmpty)
val generatedLicenseAssets = layout.buildDirectory.dir("generated/licenseAssets")
val prepareLicenseAssets = tasks.register<Sync>("prepareLicenseAssets") {
    into(generatedLicenseAssets)
    from(project.layout.projectDirectory.dir("../../../resources/torrent-core/licenses")) {
        into("licenses/torrent-core")
    }
}

android {
    namespace = "dev.ani.tracker.torrent"
    compileSdk = 35
    ndkVersion = "27.2.12479018"

    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")

        ndk {
            abiFilters += targetAbis
        }

        externalNativeBuild {
            cmake {
                arguments += "-DANI_ANDROID_NATIVE_ROOT=$nativeRoot"
                cppFlags += "-std=c++17"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.31.1"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        jniLibs.useLegacyPackaging = false
    }

    sourceSets {
        getByName("main").assets.srcDir(generatedLicenseAssets)
    }
}

tasks.named("preBuild").configure {
    dependsOn(prepareLicenseAssets)
}

dependencies {
    implementation(project(":tauri-android"))
    implementation("androidx.work:work-runtime-ktx:2.10.1")
}
