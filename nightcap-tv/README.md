# Nightcap for Android TV

The Android TV app: Homes, title pages, Search, the player, Live TV, Play on TV and Settings, made for a remote. It runs on Android TV and Google TV devices with Android 9 or newer, including Fire TV, Shield and Mi Box.

Most people install the ready-built APK from the newest `tv-v…` release in [Releases](https://github.com/chiragd03/nightcap/releases). After that, the app updates itself from the household's Nightcap server.

## What you need

- JDK 17 (Android Studio's own works)
- The Android SDK, with platform 35
- A running Nightcap server to connect to (see [`nightcap-server`](../nightcap-server))

## Build

```sh
cd nightcap-tv
./gradlew assembleDebug      # → app/build/outputs/apk/debug/
./gradlew assembleRelease    # → app/build/outputs/apk/release/
```

There's one APK per kind of processor: `armeabi-v7a`, which runs on nearly every TV, and `arm64-v8a`. A release APK is unsigned unless your own key is set up in `app/build.gradle.kts`. Sign it with your key before installing it.

Install one with `adb install app/build/outputs/apk/debug/app-armeabi-v7a-debug.apk` on a TV with developer options and network debugging turned on.

This build doesn't play trailers: Home shows each title's picture instead.

## Tests

```sh
./gradlew :app:testDebugUnitTest
```

## Licence

[AGPL-3.0](../LICENSE), like the rest of Nightcap. The fonts, icons and profile pictures it includes are under their own licences, in [`app/src/main/assets/licenses`](app/src/main/assets/licenses).
