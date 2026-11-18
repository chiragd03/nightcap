plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// -PnightcapPrivate=true: the build takes the optional parts kept in src/private/ (not in git):
// trailers and the household's own Live TV handler. Without it, the public stand-ins in src/public/
// (no trailers, no handler), and src/private/ is ignored even when it's there.
val nightcapPrivate = providers.gradleProperty("nightcapPrivate").orNull == "true"
if (nightcapPrivate && !file("src/private/java").isDirectory)
    throw GradleException("-PnightcapPrivate=true needs app/src/private/ (java/ and proguard-rules.pro), which isn't here")

android {
    namespace = "local.nightcap"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.chiragd03.nightcap"
        minSdk = 28          // Android 9 and up: Android TV and Google TV devices, Fire TV, Shield, Mi Box
        targetSdk = 34
        // Each release one up: a TV offers an update only for a higher versionCode.
        versionCode = 1
        versionName = "1.0.0"
    }

    // One APK per kind of processor, each about 25 MB, rather than one with both at nearly twice that:
    // VLC's native library is most of the app. armeabi-v7a runs on nearly every TV (64-bit chips run it
    // too); arm64-v8a is for the few boxes that only run 64-bit apps.
    splits {
        abi {
            isEnable = true
            reset()
            include("armeabi-v7a", "arm64-v8a")
            isUniversalApk = false
        }
    }

    // Releases are signed with the key at ~/keys/nightcap-release.jks (its password the Gradle property
    // nightcapKeyPassword) when that file is there; otherwise the release APK is built unsigned. Every
    // release of the app must be signed with the same key, or a TV can't install it over the one it has.
    val releaseKey = file(System.getProperty("user.home") + "/keys/nightcap-release.jks")
    signingConfigs {
        if (releaseKey.exists()) create("release") {
            storeFile = releaseKey
            storePassword = providers.gradleProperty("nightcapKeyPassword").orNull
            keyAlias = "nightcap"
            keyPassword = providers.gradleProperty("nightcapKeyPassword").orNull
        }
    }

    sourceSets {
        getByName("main").java.srcDir(if (nightcapPrivate) "src/private/java" else "src/public/java")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (nightcapPrivate) proguardFiles("src/private/proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }
    buildFeatures { buildConfig = true }
    // Compress VLC's 40 MB native library inside the APK (unpacked once on install).
    packaging { jniLibs { useLegacyPackaging = true } }
    compileOptions {
        // Fills in Java APIs newer than the TV's Android (some libraries use them).
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    // Spring physics for focus and movement.
    implementation("androidx.dynamicanimation:dynamicanimation:1.0.0")
    implementation("io.coil-kt:coil:2.7.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Plays trailers and Live TV; uses the TV's hardware H.264 decoder.
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    // Send to TV: HLS (.m3u8) streams and the on-screen playback controls.
    implementation("androidx.media3:media3-exoplayer-hls:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    // The Nightcap player for films and episodes: plays every codec and track layout.
    implementation("org.videolan.android:libvlc-all:3.6.0")
    // Trailers (the private build only): looks up their stream addresses on the TV so they play directly.
    if (nightcapPrivate) implementation("com.github.TeamNewPipe:NewPipeExtractor:v0.26.5")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs_nio:2.1.5")
    // Plain JVM tests of the player's rules (PlayOrder): ./gradlew :app:testDebugUnitTest
    testImplementation("junit:junit:4.13.2")
}
