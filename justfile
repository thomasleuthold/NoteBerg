# NoteBerg justfile - Task runner commands
# Set shell for Windows compatibility
set shell := ["powershell.exe", "-c"]
version := `node -p "require('./package.json').version"`

# Default recipe (show available commands)
default:
    @just --list

# Development
dev:
    Get-Process -Name "NoteBerg.Recognition" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*src-tauri*" } | Stop-Process -Force -ErrorAction SilentlyContinue; $true
    just package-sidecar
    npm run tauri dev

build:
    npm run build

build-w:
    if (Test-Path "src-tauri\target\release\bundle\msi\") { Remove-Item -Path "src-tauri\target\release\bundle\msi\*" -Force -Recurse -ErrorAction SilentlyContinue }
    Get-Process -Name "NoteBerg.Recognition" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*src-tauri*" } | Stop-Process -Force -ErrorAction SilentlyContinue; $true
    just package-sidecar
    npm run tauri build
    New-Item -ItemType Directory -Force -Path dist | Out-Null
    # Copy-Item -Path "src-tauri\target\release\bundle\msi\*.msi" -Destination "builds\" -Force
    Copy-Item -Path "src-tauri\target\release\bundle\msi\*.msi" -Destination "C:\Users\ThL\Nextcloud\DEV\NoteBerg\Dist\" -Force

build-a:
    if (Test-Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\") { Remove-Item -Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\*" -Force -Recurse -ErrorAction SilentlyContinue }
    just patch-android
    npm run tauri android build -- --apk true
    New-Item -ItemType Directory -Force -Path builds | Out-Null
    # Copy-Item -Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk" -Destination "builds\NoteBerg_{{version}}_android_universal.apk" -Force
    Copy-Item -Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk" -Destination "C:\Users\ThL\Nextcloud\DEV\NoteBerg\Dist\NoteBerg_{{version}}_android_universal.apk" -Force

build-aab:
    if (Test-Path "src-tauri\gen\android\app\build\outputs\bundle\universalRelease\") { Remove-Item -Path "src-tauri\gen\android\app\build\outputs\bundle\universalRelease\*" -Force -Recurse -ErrorAction SilentlyContinue }
    just patch-android
    npm run tauri android build -- --aab true
    New-Item -ItemType Directory -Force -Path builds | Out-Null
    Copy-Item -Path "src-tauri\gen\android\app\build\outputs\bundle\universalRelease\app-universal-release.aab" -Destination "C:\Users\ThL\Nextcloud\DEV\NoteBerg\Dist\NoteBerg_{{version}}_android.aab" -Force

# Patch auto-generated Android files that cannot be modified in source
patch-android:
    $f = "src-tauri\gen\android\app\src\main\java\eu\noteberg\app\generated\RustWebChromeClient.kt"; $content = Get-Content $f -Raw; $patched = $content -replace '(?m)^\s*permissionList\.add\(Manifest\.permission\.MODIFY_AUDIO_SETTINGS\)\r?\n', ''; Set-Content $f $patched -NoNewline; Write-Host "patch-android: done"

build-all:
    just build-w
    just build-a

preview:
    npm run preview

# Code Quality
check:
    npm run lint
    npm run check
    npm run format

format:
    npm run format

test:
    npm run test

fct:
    just format
    just check
    just test



# Utilities
clean:
    Remove-Item -Recurse -Force dist, node_modules -ErrorAction SilentlyContinue

install:
    npm install

# Open the built app in default browser (Windows)
open-dist:
    Start-Process "dist/index.html"

# Build the recognition backend (Release)
build-backend:
    dotnet build src-recognition-backend -c Release

fix-build:
    Remove-Item "src-tauri/capabilities/recognition.json" -ErrorAction SilentlyContinue

# Build recognition sidecar for Tauri bundling
package-sidecar:
    dotnet publish src-recognition-backend -c Release -r win-x64 --self-contained true -o src-tauri/binaries/temp
    Copy-Item "src-tauri/binaries/temp/NoteBerg.Recognition.exe" -Destination "src-tauri/binaries/NoteBerg.Recognition-x86_64-pc-windows-gnu.exe" -Force
    Copy-Item "src-tauri/binaries/temp/NoteBerg.Recognition.exe" -Destination "src-tauri/binaries/NoteBerg.Recognition-x86_64-pc-windows-msvc.exe" -Force
    Copy-Item "src-tauri/binaries/temp/appsettings.json" -Destination "src-tauri/binaries/appsettings.json" -Force
    Remove-Item -Recurse -Force "src-tauri/binaries/temp"

# Package the recognition backend and installer script (legacy standalone service)
package-backend:
    dotnet publish src-recognition-backend -c Release -r win-x64 --self-contained false -o dist-backend
    Copy-Item "src-recognition-backend/install-service.ps1" -Destination "dist-backend/"

# Build and package the Nextcloud app release
# Requires: noteberg.key + noteberg.crt in repo root (from NC certificate process)
# Output: builds/noteberg-<version>.tar.gz + builds/noteberg-<version>.tar.gz.sig
build-nc:
    # 1. Build JS/CSS for Nextcloud
    npm run build:nextcloud

    # 2. Assemble app into a clean temp directory
    if (Test-Path "build-nc-tmp") { Remove-Item -Recurse -Force "build-nc-tmp" }
    New-Item -ItemType Directory -Force -Path "build-nc-tmp\noteberg" | Out-Null
    Copy-Item -Recurse "appinfo"   "build-nc-tmp\noteberg\"
    Copy-Item -Recurse "lib"       "build-nc-tmp\noteberg\"
    Copy-Item -Recurse "templates" "build-nc-tmp\noteberg\"
    Copy-Item -Recurse "img"       "build-nc-tmp\noteberg\"
    Copy-Item -Recurse "js"        "build-nc-tmp\noteberg\"
    Copy-Item -Recurse "css"       "build-nc-tmp\noteberg\"
    Copy-Item -Recurse "assets"    "build-nc-tmp\noteberg\" -ErrorAction SilentlyContinue

    # 3. Code-sign via occ in the Nextcloud dev container (must be running: just nc-up)
    Write-Host "Code-signing app via occ in Nextcloud container..."
    podman exec noteberg-nc bash -c "php /var/www/html/occ integrity:sign-app --privateKey=/var/www/html/apps-extra/noteberg/noteberg.key --certificate=/var/www/html/apps-extra/noteberg/noteberg.crt --path=/var/www/html/apps-extra/noteberg/build-nc-tmp/noteberg"

    # 4. Package into tar.gz
    New-Item -ItemType Directory -Force -Path "builds" | Out-Null
    $tarball = "builds\noteberg-{{version}}.tar.gz"
    tar -czf $tarball -C "build-nc-tmp" "noteberg"
    Write-Host "Created $tarball"

    # 5. Sign the archive (for store upload)
    $sig = (openssl dgst -sha512 -sign noteberg.key $tarball | openssl base64) -join ""
    $sig | Out-File -NoNewline -Encoding ascii "builds\noteberg-{{version}}.tar.gz.sig"
    Write-Host "Archive signature written to builds\noteberg-{{version}}.tar.gz.sig"

    # 6. Cleanup temp dir
    Remove-Item -Recurse -Force "build-nc-tmp"
    Write-Host "Done! Upload $tarball to the NC App Store."
    Write-Host "Archive signature (for store):"
    Get-Content "builds\noteberg-{{version}}.tar.gz.sig"

# Nextcloud dev environment (requires Podman)
# Run 'npm run dev:nextcloud' separately for watch mode rebuilds
nc-up:
    podman run --rm --name noteberg-nc -d -p 8080:80 -v "${PWD}:/var/www/html/apps-extra/noteberg" ghcr.io/juliusknorr/nextcloud-dev-php84:latest
    Write-Host "NoteBerg Nextcloud running at http://localhost:8080"
    Write-Host "Run 'npm run dev:nextcloud' in a separate terminal for watch mode"

nc-down:
    podman stop noteberg-nc

# Push to GitHub (default: main branch)
push-gh branch="main":
    git push github {{branch}}

# Increase version (patch) and sync
bump:
    npm version patch

# Increase version (patch) and sync
bump-minor:
    npm version minor

# Increase version (patch) and sync
bump-major:
    npm version major