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
        getByName("main").assets.srcDir("../../../resources/torrent-core/licenses")
    }
}

dependencies {
    implementation(project(":tauri-android"))
}
