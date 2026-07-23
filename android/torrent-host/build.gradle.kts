plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val nativePrefix = providers.environmentVariable("ANI_ANDROID_NATIVE_PREFIX")
    .orElse(rootProject.layout.projectDirectory.dir("../.cache/android-torrent/vcpkg_installed/arm64-android").asFile.absolutePath)
    .get()

android {
    namespace = "dev.ani.tracker.torrent"
    compileSdk = 35
    ndkVersion = "27.2.12479018"

    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")

        ndk {
            abiFilters += "arm64-v8a"
        }

        externalNativeBuild {
            cmake {
                arguments += listOf(
                    "-DANI_BUILD_SIDECAR=OFF",
                    "-DANI_BUILD_ANDROID_JNI=ON",
                    "-DANI_FETCH_LIBTORRENT=ON",
                    "-DBOOST_ROOT=$nativePrefix",
                    "-DOPENSSL_ROOT_DIR=$nativePrefix",
                    "-DOPENSSL_USE_STATIC_LIBS=TRUE"
                )
                cppFlags += listOf("-std=c++17")
            }
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
        getByName("main").assets.srcDir("../../resources/torrent-core/licenses")
    }
}
