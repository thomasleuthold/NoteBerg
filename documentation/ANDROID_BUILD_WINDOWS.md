# Android Build Guide for Windows

This guide will help you build NoteBerg as an Android app on Windows.

## Prerequisites

You need to install several tools before you can build for Android.

### 1. Install Android Studio

1. **Download Android Studio**: https://developer.android.com/studio
2. **Run the installer** and follow the setup wizard
3. **During installation**, make sure to install:
   - Android SDK
   - Android SDK Platform
   - Android Virtual Device (optional, for testing)

4. **After installation**, open Android Studio:
   - Go to `More Actions` → `SDK Manager` (or `Tools` → `SDK Manager` if you have a project open)

   - In `SDK Platforms` tab:
     - ✅ Check `Show Package Details` (bottom right)
     - ✅ Install **Android 13.0 (API Level 33)** or higher
     - ✅ Make sure to check the SDK Platform for your selected version

   - In `SDK Tools` tab:
     - ✅ Check `Show Package Details` (bottom right)
     - ✅ **Android SDK Build-Tools** (latest version)
     - ✅ **Android SDK Command-line Tools (latest)** - This is important!
     - ✅ **Android SDK Platform-Tools**
     - ✅ **NDK (Side by side)** - Install the latest version
     - ✅ **Android Emulator** (optional, for testing without a device)

   - Click `Apply` and wait for installation to complete

**Note**: If you don't see NDK or Command-line Tools:
- Make sure `Show Package Details` is checked (bottom right corner)
- Look for "NDK (Side by side)" - it should show multiple versions
- Select the latest version number
- Command-line Tools should show "Android SDK Command-line Tools (latest)"

### 2. Set Up Environment Variables

1. **Open System Environment Variables**:
   - Press `Win + X` → `System` → `Advanced system settings` → `Environment Variables`

2. **Find your SDK location**:
   - In Android Studio SDK Manager, look at the top for "Android SDK Location"
   - Default is: `C:\Users\YourUsername\AppData\Local\Android\Sdk`
   - Note: You may need to show hidden folders (View → Show → Hidden items in File Explorer)

3. **Browse to verify folders exist**:
   - Open File Explorer and go to your SDK location
   - You should see folders like: `build-tools`, `ndk`, `platform-tools`, `platforms`, `cmdline-tools`
   - In `ndk` folder, note the version number (e.g., `29.0.14206865`)
   - In `build-tools` folder, note the version number (e.g., `36.1.0`)

4. **Create/Update these variables** (User variables):

   ```
   ANDROID_HOME = C:\Users\YourUsername\AppData\Local\Android\Sdk
   NDK_HOME = C:\Users\YourUsername\AppData\Local\Android\Sdk\ndk\29.0.14206865
   ```

   Replace:
   - `YourUsername` with your actual Windows username
   - `29.0.14206865` with your actual NDK version from step 3

5. **Add to PATH** (User variables):
   - Click on `Path` → `Edit` → `New`, then add these three entries:
   ```
   C:\Users\YourUsername\AppData\Local\Android\Sdk\platform-tools
   C:\Users\YourUsername\AppData\Local\Android\Sdk\cmdline-tools\latest\bin
   C:\Users\YourUsername\AppData\Local\Android\Sdk\build-tools\36.1.0
   ```

   Replace:
   - `YourUsername` with your actual Windows username
   - `36.1.0` with your actual build-tools version from step 3

   **Note**: Use full paths, not `%ANDROID_HOME%` in PATH - it's more reliable

6. **Restart your terminal** for changes to take effect

### 3. Install Java JDK 17

Tauri Android requires Java 17.

1. **Download Java 17**: https://adoptium.net/temurin/releases/
   - Select: Java 17 (LTS), Windows, x64, JDK

2. **Install** and make sure to check "Set JAVA_HOME variable"

3. **Verify installation**:
   ```bash
   java -version
   ```
   Should show version 17.x.x

### 4. Verify Android Setup

Open a new terminal and run:

```bash
# Check Android SDK is accessible
adb --version

# Check Android build tools
sdkmanager --list
```

If these commands work, your Android setup is complete!

## Initialize Tauri Android

### 1. Add Android Target to Tauri

```bash
npm run tauri android init
```

This will:
- Create `src-tauri/gen/android` folder
- Set up Android project structure
- Configure build files

**Important**: `gen/android` is a **generated folder** — it is gitignored and will be wiped if you delete it or re-run `tauri android init`. Any manual customizations (signing config, custom Kotlin files) must be re-applied after reinitializing. See the sections below.

**During initialization**, you'll be asked:
- **Package name**: Use `eu.noteberg.app`
- **App name**: `NoteBerg`

**If you change the bundle identifier** in `tauri.conf.json` or the package name in `Cargo.toml`, you must delete `gen/android` and re-run `tauri android init`, then reapply all manual customizations.

### 2. Configure Android Permissions

Edit `src-tauri/capabilities/default.json` to ensure it includes Android:

```json
{
  "windows": ["main"],
  "platforms": ["windows", "macos", "linux", "android"],
  "permissions": [
    "core:default",
    "http:default",
    "shell:allow-open"
  ]
}
```

## Signing the Release APK

**Important**: `key.properties` is gitignored and must be recreated manually whenever `gen/android` is regenerated. Store your keystore file and passwords in a password manager.

### 1. Generate Keystore (one-time)

Run once and keep the keystore file safe permanently:

```bash
keytool -genkey -v -keystore onejournal-release.keystore -alias onejournal -keyalg RSA -keysize 2048 -validity 10000
```

Store the keystore file at the **project root** (it is gitignored). To verify your keystore alias later:

```bash
keytool -list -keystore onejournal-release.keystore -storepass YOUR_PASSWORD
```

**Save the keystore file and passwords in a password manager — they cannot be recovered!**

### 2. Create key.properties

Create `src-tauri/gen/android/key.properties` (gitignored, must be recreated after each `tauri android init`):

```properties
storePassword=YOUR_KEYSTORE_PASSWORD
keyPassword=YOUR_KEY_PASSWORD
keyAlias=onejournal
storeFile=C:/work/code/oneJournal/onejournal-release.keystore
```

Use forward slashes in `storeFile` even on Windows.

### 3. Update build.gradle.kts

Edit `src-tauri/gen/android/app/build.gradle.kts` (must be done after each `tauri android init`).

Add after the `tauriProperties` block and before `android {`:

```kotlin
val keystoreProperties = Properties().apply {
    val propFile = file("../key.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
```

Inside `android { }`, add a `signingConfigs` block before `buildTypes`:

```kotlin
signingConfigs {
    create("release") {
        keyAlias = keystoreProperties.getProperty("keyAlias")
        keyPassword = keystoreProperties.getProperty("keyPassword")
        storeFile = keystoreProperties.getProperty("storeFile")?.let { file(it) }
        storePassword = keystoreProperties.getProperty("storePassword")
    }
}
```

Inside `getByName("release") { }`, add:

```kotlin
signingConfig = signingConfigs.getByName("release")
```

### 4. Restore PdfSavePlugin.kt

This custom Kotlin file enables opening PDFs from the app and must be recreated after each `tauri android init`.

Create `src-tauri/gen/android/app/src/main/java/eu/noteberg/app/PdfSavePlugin.kt`:

```kotlin
package eu.noteberg.app

import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class PdfSavePlugin(private val activity: android.app.Activity) : Plugin(activity) {

    @Command
    fun openCachedPdf(invoke: Invoke) {
        val path = invoke.getArgs().getString("path")
        if (path == null) {
            invoke.reject("Missing path argument")
            return
        }

        val file = File(path)
        if (!file.exists()) {
            invoke.reject("File not found: $path")
            return
        }

        try {
            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                file
            )

            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/pdf")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            activity.startActivity(intent)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Failed to open PDF: ${e.message}")
        }
    }
}
```

## Building the Android App

### Development Build (APK)

To build and run on a connected Android device or emulator:

```bash
npm run tauri android dev
```

This will:
1. Build the frontend (Vite)
2. Build the Rust backend for Android
3. Create an APK
4. Install and run on your device/emulator

**First build takes 15-30 minutes** (compiling all Rust dependencies for Android)

### Release Build (APK)

Use the justfile recipe which handles cleanup and copying:

```bash
just build-a
```

Or manually:

```bash
npm run tauri android build
```

Output APK: `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`

**Note**: Do not pass `--release` as an npm argument — npm will warn that it's unknown. The Tauri CLI handles release mode internally.

## Testing on Android Device

### Option 1: Physical Device

1. **Enable Developer Mode** on your Android phone:
   - Go to `Settings` → `About Phone`
   - Tap `Build Number` 7 times

2. **Enable USB Debugging**:
   - Go to `Settings` → `Developer Options`
   - Enable `USB Debugging`

3. **Connect phone via USB**

4. **Verify connection**:
   ```bash
   adb devices
   ```
   You should see your device listed

5. **Run the app**:
   ```bash
   npm run tauri android dev
   ```

### Option 2: Android Emulator

1. **Create emulator in Android Studio**:
   - Open Android Studio → `More Actions` → `Virtual Device Manager`
   - Click `Create Device`
   - Select a device (e.g., Pixel 5)
   - Select a system image (Android 13+)
   - Click `Finish`

2. **Start the emulator**:
   - Click the ▶ play button in Device Manager

3. **Run the app**:
   ```bash
   npm run tauri android dev
   ```

## Installing the APK

### On Device

1. Transfer the APK to your phone
2. Open the APK file
3. Allow installation from unknown sources if prompted
4. Install

### Using ADB

```bash
adb install src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

## Troubleshooting

### "ANDROID_HOME not set"

Make sure you set the environment variable and **restarted your terminal**.

### "NDK not found"

Install NDK via Android Studio SDK Manager, then set `NDK_HOME` environment variable.

### "Java version mismatch"

Make sure you have Java 17 installed:
```bash
java -version
```

If you have multiple Java versions, set `JAVA_HOME` to Java 17:
```
JAVA_HOME = C:\Program Files\Eclipse Adoptium\jdk-17.x.x.x-hotspot
```

### Build fails with "rust target not installed"

Install Android Rust targets:
```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

### App crashes on startup

Most likely `PdfSavePlugin.kt` is missing (e.g. after `tauri android init`). Check logcat:
```bash
adb logcat -s AndroidRuntime | grep -i "noteberg\|fatal\|exception"
```

Recreate `PdfSavePlugin.kt` as described in the signing section above.

### "Project directory does not exist" error

This happens when the bundle identifier changed but `gen/android` still has the old package structure. Fix:
```powershell
Remove-Item -Recurse -Force src-tauri\gen\android
npm run tauri android init
```
Then reapply signing config and `PdfSavePlugin.kt`.

### APK is unsigned (filename ends with `-unsigned.apk`)

`key.properties` is missing or the signing config was not added to `build.gradle.kts`. Follow the signing steps above.

### Emulator won't start

Try creating a new emulator with less RAM, or:
- Enable Hyper-V in Windows
- Enable Intel VT-x/AMD-V in BIOS

## Publishing to Google Play Store

1. **Build AAB** (Android App Bundle):
   ```bash
   npm run tauri android build --target aab
   ```

2. **Create Google Play Console account**: https://play.google.com/console

3. **Create new app** and follow the setup wizard

4. **Upload AAB** in the "Release" section

5. **Fill in store listing**, screenshots, privacy policy, etc.

6. **Submit for review**

## Checklist After `tauri android init`

Run this after every `gen/android` regeneration:

- [ ] Create `src-tauri/gen/android/key.properties` with keystore credentials
- [ ] Add `keystoreProperties` block to `build.gradle.kts`
- [ ] Add `signingConfigs` block to `build.gradle.kts`
- [ ] Add `signingConfig = signingConfigs.getByName("release")` to release build type
- [ ] Recreate `PdfSavePlugin.kt`

## File Sizes

- **First build**: Downloads ~2GB of dependencies
- **APK size**: ~10-20 MB (optimized release)
- **AAB size**: ~8-15 MB

## Performance Notes

- First build: 15-30 minutes
- Incremental builds: 1-3 minutes
- App startup: Similar to native Android apps
- No CORS issues (native HTTP client)
- Full offline support

## Resources

- Tauri Android Guide: https://v2.tauri.app/develop/android/
- Android Developer Docs: https://developer.android.com/docs
- Android Studio Download: https://developer.android.com/studio
