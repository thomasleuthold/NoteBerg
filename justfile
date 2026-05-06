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
    if (Test-Path "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\") { Remove-Item -Path "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\*" -Force -Recurse -ErrorAction SilentlyContinue }
    Get-Process -Name "NoteBerg.Recognition" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*src-tauri*" } | Stop-Process -Force -ErrorAction SilentlyContinue; $true
    just package-sidecar
    npm run tauri build
    New-Item -ItemType Directory -Force -Path dist | Out-Null
    # Copy-Item -Path "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\*.msi" -Destination "builds\" -Force
    Copy-Item -Path "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\*.msi" -Destination "C:\Users\ThL\Nextcloud\DEV\NoteBerg\Dist\" -Force

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
    # 1. Build JS/CSS for Nextcloud (NC version read from appinfo/info.xml, may differ from package.json)
    $env:VITE_NC_BASE = "/apps/noteberg/"; npm run build:nextcloud

    # 2. Assemble app into a clean temp directory
    $ncver = (Select-Xml -Path appinfo/info.xml -XPath "//version").Node.InnerText
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

    # 4+5. Package tar.gz and sign (version read from info.xml inside script)
    powershell -File scripts/package-nc-release.ps1

    # 6. Cleanup temp dir
    Remove-Item -Recurse -Force "build-nc-tmp"

# Nextcloud dev environment (requires Podman)
# Run 'npm run dev:nextcloud' separately for watch mode rebuilds
nc-up:
    podman run --rm --name noteberg-nc -d -p 8080:80 -v "${PWD}:/var/www/html/apps-extra/noteberg" ghcr.io/juliusknorr/nextcloud-dev-php84:latest
    $wslIp = (wsl -d podman-machine-default -- ip addr show eth0) -match 'inet ' | ForEach-Object { ($_ -split '\s+')[3] -replace '/\d+$', '' } | Select-Object -First 1
    netsh interface portproxy add v4tov4 listenport=8080 listenaddress=127.0.0.1 connectport=8080 connectaddress=$wslIp 2>&1 | Out-Null
    Write-Host "NoteBerg Nextcloud running at http://localhost:8080 (WSL IP: $wslIp)"
    Write-Host "Run 'npm run dev:nextcloud' in a separate terminal for watch mode"

nc-down:
    podman stop noteberg-nc
    netsh interface portproxy delete v4tov4 listenport=8080 listenaddress=127.0.0.1 2>&1 | Out-Null

# Spin up a clean NC instance and install NoteBerg from the App Store (alpha channel)
# Tests the published package as a real user would — no volume mount, no cache tricks
# Runs on port 8081 so it doesn't conflict with the dev container on 8080
# Test against a clean NC instance from the App Store.
# php=84 (default, NC 34+) or php=81 (NC 33)
nc-test php="84":
    podman stop noteberg-nc-test 2>&1 | Out-Null; $true
    podman run --rm --name noteberg-nc-test -d -p 8081:80 ghcr.io/juliusknorr/nextcloud-dev-php{{php}}:latest
    $wslIp = (wsl -d podman-machine-default -- ip addr show eth0) -match 'inet ' | ForEach-Object { ($_ -split '\s+')[3] -replace '/\d+$', '' } | Select-Object -First 1
    netsh interface portproxy delete v4tov4 listenport=8081 listenaddress=127.0.0.1 2>&1 | Out-Null; $true
    netsh interface portproxy add v4tov4 listenport=8081 listenaddress=127.0.0.1 connectport=8081 connectaddress=$wslIp 2>&1 | Out-Null
    Write-Host "Waiting for Nextcloud to initialize..."
    Start-Sleep -Seconds 15
    podman exec noteberg-nc-test bash -c "php /var/www/html/occ config:system:set updater.release.channel --value=beta"
    podman exec noteberg-nc-test bash -c "php /var/www/html/occ config:app:delete core lastupdatedat"
    podman exec noteberg-nc-test bash -c "php /var/www/html/occ app:install --allow-unstable noteberg"
    Write-Host "NoteBerg installed from App Store. Open http://localhost:8081 (admin/admin) to test."
    Write-Host "Run 'just nc-test-down' when done."

nc-test-down:
    podman stop noteberg-nc-test
    netsh interface portproxy delete v4tov4 listenport=8081 listenaddress=127.0.0.1 2>&1 | Out-Null; $true

# Spin up a stock Nextcloud 33 (Apache) instance with NoteBerg volume-mounted for NC33 compatibility testing
# Uses official nextcloud:33-apache image (self-contained, no occ pre-setup needed)
# Runs on port 8082 — does NOT install from App Store; use just nc-test33-push to deploy local build
# First run: complete the NC web installer at http://localhost:8082 (set admin/admin)
nc-test33:
    podman stop noteberg-nc-test33 2>&1 | Out-Null; $true
    podman run --rm --name noteberg-nc-test33 -d -p 8082:80 -v "${PWD}:/var/www/html/custom_apps/noteberg" nextcloud:33-apache
    $wslIp = (wsl -d podman-machine-default -- ip addr show eth0) -match 'inet ' | ForEach-Object { ($_ -split '\s+')[3] -replace '/\d+$', '' } | Select-Object -First 1
    netsh interface portproxy delete v4tov4 listenport=8082 listenaddress=127.0.0.1 2>&1 | Out-Null; $true
    netsh interface portproxy add v4tov4 listenport=8082 listenaddress=127.0.0.1 connectport=8082 connectaddress=$wslIp 2>&1 | Out-Null
    Write-Host "Waiting for Nextcloud to initialize..."
    Start-Sleep -Seconds 20
    podman exec noteberg-nc-test33 //bin/sh -c "php /var/www/html/occ app:enable noteberg 2>&1"
    Write-Host "Nextcloud 33 running at http://localhost:8082 (admin/admin)"
    Write-Host "Run 'just nc-test33-push' to deploy local build. Run 'just nc-test33-down' when done."

nc-test33-down:
    podman stop noteberg-nc-test33
    netsh interface portproxy delete v4tov4 listenport=8082 listenaddress=127.0.0.1 2>&1 | Out-Null; $true

# Rebuild and push local JS/CSS/templates into the NC33 test container
# Requires: just nc-test33 running and NoteBerg enabled
nc-test33-push:
    $env:VITE_NC_BASE = "/custom_apps/noteberg/"; npm run build:nextcloud
    Write-Host "Built for nc-test33 (8082) — hard reload http://localhost:8082"

# Rebuild JS/CSS for the dev container (8080, /apps-extra/noteberg/) — files land in repo root
# and are served directly via the volume mount. Hard reload http://localhost:8080 after.
# Requires: just nc-up running
nc-dev-push:
    $env:VITE_NC_BASE = "/apps-extra/noteberg/"; npm run build:nextcloud
    Write-Host "Built for nc-up (8080) — hard reload http://localhost:8080"

# Rebuild and push local JS/CSS/templates into the running test container for rapid CSS iteration
# Requires: just nc-test container running
nc-test-push:
    $env:VITE_NC_BASE = "/apps-writable/noteberg/"; npm run build:nextcloud
    podman cp js/noteberg-main.js noteberg-nc-test:/var/www/html/apps-writable/noteberg/js/noteberg-main.js
    podman cp css/noteberg-styles.css noteberg-nc-test:/var/www/html/apps-writable/noteberg/css/noteberg-styles.css
    podman cp templates/index.php noteberg-nc-test:/var/www/html/apps-writable/noteberg/templates/index.php
    podman cp img noteberg-nc-test:/var/www/html/apps-writable/noteberg/
    Write-Host "Assets pushed — hard reload the browser (Ctrl+Shift+R)."

# Restart the Podman machine when it gets into a broken state
podman-restart:
    wsl --terminate podman-machine-default 2>&1 | Out-Null; $true
    Start-Sleep -Seconds 2
    podman machine start
    Write-Host "Podman machine restarted."

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