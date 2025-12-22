# Android Build Guide for Windows

This guide will help you build oneJournal as an Android app on Windows.

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
     - ✅ **NDK (Side by side)** - Install the latest version (e.g., 26.x.x or 27.x.x)
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
   - In `ndk` folder, note the version number (e.g., `26.1.10909125`)
   - In `build-tools` folder, note the version number (e.g., `34.0.0`)

4. **Create/Update these variables** (User variables):

   ```
   ANDROID_HOME = C:\Users\YourUsername\AppData\Local\Android\Sdk
   NDK_HOME = C:\Users\YourUsername\AppData\Local\Android\Sdk\ndk\26.1.10909125
   ```

   Replace:
   - `YourUsername` with your actual Windows username
   - `26.1.10909125` with your actual NDK version from step 3

5. **Add to PATH** (User variables):
   - Click on `Path` → `Edit` → `New`, then add these three entries:
   ```
   C:\Users\YourUsername\AppData\Local\Android\Sdk\platform-tools
   C:\Users\YourUsername\AppData\Local\Android\Sdk\cmdline-tools\latest\bin
   C:\Users\YourUsername\AppData\Local\Android\Sdk\build-tools\34.0.0
   ```

   Replace:
   - `YourUsername` with your actual Windows username
   - `34.0.0` with your actual build-tools version from step 3

   **Note**: Use full paths, not `%ANDROID_HOME%` in PATH - it's more reliable

4. **Restart your terminal** for changes to take effect

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

**During initialization**, you'll be asked:
- **Package name**: Use `com.onejournal.app` (or your preferred package name)
- **App name**: `oneJournal`

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

### Release Build (APK/AAB)

To build a release version:

```bash
npm run tauri android build
```

This creates:
- **APK** at: `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`
- **AAB** at: `src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab`

**APK**: Install directly on Android devices
**AAB**: Upload to Google Play Store

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

## Signing the Release APK

For production releases, you need to sign your APK.

### 1. Generate Keystore

```bash
keytool -genkey -v -keystore onejournal-release.keystore -alias onejournal -keyalg RSA -keysize 2048 -validity 10000
```

**Save the keystore file and passwords securely!**

### 2. Configure Signing

Create `src-tauri/gen/android/key.properties`:

```properties
storePassword=YOUR_KEYSTORE_PASSWORD
keyPassword=YOUR_KEY_PASSWORD
keyAlias=onejournal
storeFile=C:/path/to/onejournal-release.keystore
```

### 3. Update build.gradle

Edit `src-tauri/gen/android/app/build.gradle` and add before `android {`:

```gradle
def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file('key.properties')
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}
```

Inside `android { ... }`, add:

```gradle
signingConfigs {
    release {
        keyAlias keystoreProperties['keyAlias']
        keyPassword keystoreProperties['keyPassword']
        storeFile keystoreProperties['storeFile'] ? file(keystoreProperties['storeFile']) : null
        storePassword keystoreProperties['storePassword']
    }
}

buildTypes {
    release {
        signingConfig signingConfigs.release
        // ... existing config
    }
}
```

### 4. Build Signed Release

```bash
npm run tauri android build --release
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

Check logcat for errors:
```bash
adb logcat | grep onejournal
```

### Emulator won't start

Try creating a new emulator with less RAM, or:
- Enable Hyper-V in Windows
- Enable Intel VT-x/AMD-V in BIOS

## Publishing to Google Play Store

1. **Build AAB** (Android App Bundle):
   ```bash
   npm run tauri android build --release --target aab
   ```

2. **Create Google Play Console account**: https://play.google.com/console

3. **Create new app** and follow the setup wizard

4. **Upload AAB** in the "Release" section

5. **Fill in store listing**, screenshots, privacy policy, etc.

6. **Submit for review**

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

## Updating package.json

Add these scripts to your `package.json`:

```json
{
  "scripts": {
    "tauri:android:init": "tauri android init",
    "tauri:android:dev": "tauri android dev",
    "tauri:android:build": "tauri android build"
  }
}
```

## Summary

**Setup (one-time):**
1. Install Android Studio + SDK (30 min)
2. Install Java 17 (5 min)
3. Set environment variables (5 min)
4. Initialize Tauri Android (5 min)

**Development workflow:**
```bash
npm run tauri:android:dev    # Test on device/emulator
npm run tauri:android:build  # Build release APK
```

**Result:**
- Native Android app
- No CORS issues with Nextcloud
- Full offline support
- ~10-20 MB APK size

## Resources

- Tauri Android Guide: https://v2.tauri.app/develop/android/
- Android Developer Docs: https://developer.android.com/docs
- Android Studio Download: https://developer.android.com/studio
