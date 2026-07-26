plugins {
    id("com.android.application") version "8.7.3" apply false
    id("com.android.library") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}

extra["compileSdkVersion"] = 35
extra["minSdkVersion"] = 26
extra["targetSdkVersion"] = 35
extra["androidxActivityVersion"] = "1.10.0"
extra["androidxAppCompatVersion"] = "1.7.0"
extra["androidxCoordinatorLayoutVersion"] = "1.2.0"
extra["androidxCoreVersion"] = "1.15.0"
extra["androidxFragmentVersion"] = "1.8.5"
extra["androidxWebkitVersion"] = "1.12.1"
