plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val generatedLicenseAssets = layout.buildDirectory.dir("generated/licenseAssets")
val prepareLicenseAssets = tasks.register<Sync>("prepareLicenseAssets") {
    into(generatedLicenseAssets)
    from(project.layout.projectDirectory.dir("../../../resources/licenses/vlc")) {
        into("licenses/vlc")
    }
    from(project.layout.projectDirectory.file("../../../LICENSE")) {
        into("licenses/ani-tracker")
        rename { "LICENSE.txt" }
    }
    from(project.layout.projectDirectory.file("../../../NOTICE")) {
        into("licenses/ani-tracker")
        rename { "NOTICE.txt" }
    }
}

android {
    namespace = "dev.ani.tracker.player"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
    }

    buildFeatures {
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.15"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        getByName("main").java.srcDir(
            file("../../../android/app/src/main/java/dev/ani/tracker/android/player")
        )
        getByName("main").assets.srcDir(generatedLicenseAssets)
    }
}

tasks.named("preBuild").configure {
    dependsOn(prepareLicenseAssets)
}

dependencies {
    implementation(project(":tauri-android"))
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.activity:activity-compose:1.10.0")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("org.videolan.android:libvlc-all:3.6.2")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
