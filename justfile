# NoteBerg justfile - Task runner commands
# Set shell for Windows compatibility
set shell := ["powershell.exe", "-c"]
version := `node -p "require('./package.json').version"`

# Default recipe (show available commands, in semantic source order)
default:
    @just --list --unsorted

# ===========================================================================
# Development
# ===========================================================================

# Run the Tauri desktop app in dev mode (rebuilds recognition sidecar first)
dev:
    Get-Process -Name "NoteBerg.Recognition" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*src-tauri*" } | Stop-Process -Force -ErrorAction SilentlyContinue; $true
    just package-sidecar
    npm run tauri dev

# Preview the built frontend (vite preview)
preview:
    npm run preview

# ===========================================================================
# Build — desktop & mobile
# ===========================================================================

# Build the frontend only (vite build)
build:
    npm run build

# Build the Windows desktop app (MSI) and copy to the Dist share
build-w:
    just sync-version
    if (Test-Path "src-tauri\target\release\bundle\msi\") { Remove-Item -Path "src-tauri\target\release\bundle\msi\*" -Force -Recurse -ErrorAction SilentlyContinue }
    Get-Process -Name "NoteBerg.Recognition" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*src-tauri*" } | Stop-Process -Force -ErrorAction SilentlyContinue; $true
    just package-sidecar
    npm run tauri build
    New-Item -ItemType Directory -Force -Path dist | Out-Null
    $msi = Get-ChildItem "src-tauri\target\release\bundle\msi\*.msi" | Select-Object -First 1
    # Copy-Item -Path $msi.FullName -Destination "builds\noteberg_windows-{{version}}.msi" -Force
    Copy-Item -Path $msi.FullName -Destination "C:\Users\ThL\Nextcloud\DEV\NoteBerg\Dist\noteberg_windows-{{version}}.msi" -Force

# Build the Android app (APK) and copy to the Dist share
build-a:
    just sync-version
    if (Test-Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\") { Remove-Item -Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\*" -Force -Recurse -ErrorAction SilentlyContinue }
    just patch-android
    npm run tauri android build -- --apk true
    New-Item -ItemType Directory -Force -Path builds | Out-Null
    # Copy-Item -Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk" -Destination "builds\noteberg_android-{{version}}-universal.apk" -Force
    Copy-Item -Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk" -Destination "C:\Users\ThL\Nextcloud\DEV\NoteBerg\Dist\noteberg_android-{{version}}-universal.apk" -Force

# Build the Android app bundle (AAB) and copy to the Dist share
build-aab:
    just sync-version
    if (Test-Path "src-tauri\gen\android\app\build\outputs\bundle\universalRelease\") { Remove-Item -Path "src-tauri\gen\android\app\build\outputs\bundle\universalRelease\*" -Force -Recurse -ErrorAction SilentlyContinue }
    just patch-android
    npm run tauri android build -- --aab true
    New-Item -ItemType Directory -Force -Path builds | Out-Null
    Copy-Item -Path "src-tauri\gen\android\app\build\outputs\bundle\universalRelease\app-universal-release.aab" -Destination "C:\Users\ThL\Nextcloud\DEV\NoteBerg\Dist\noteberg_android-{{version}}.aab" -Force

# Build all targets: Windows, Android APK, Android AAB, and Nextcloud app
build-all:
    just build-w
    just build-a
    just build-aab
    just build-nc

# Patch auto-generated Android files that cannot be modified in source
patch-android:
    $f = "src-tauri\gen\android\app\src\main\java\eu\noteberg\app\generated\RustWebChromeClient.kt"; $content = Get-Content $f -Raw; $patched = $content -replace '(?m)^\s*permissionList\.add\(Manifest\.permission\.MODIFY_AUDIO_SETTINGS\)\r?\n', ''; Set-Content $f $patched -NoNewline; Write-Host "patch-android: done"

# Build the recognition sidecar (.exe) into src-tauri/binaries for Tauri bundling
package-sidecar:
    dotnet publish src-recognition-backend -c Release -r win-x64 --self-contained true -o src-tauri/binaries/temp
    Copy-Item "src-tauri/binaries/temp/NoteBerg.Recognition.exe" -Destination "src-tauri/binaries/NoteBerg.Recognition-x86_64-pc-windows-gnu.exe" -Force
    Copy-Item "src-tauri/binaries/temp/NoteBerg.Recognition.exe" -Destination "src-tauri/binaries/NoteBerg.Recognition-x86_64-pc-windows-msvc.exe" -Force
    Copy-Item "src-tauri/binaries/temp/appsettings.json" -Destination "src-tauri/binaries/appsettings.json" -Force
    Remove-Item -Recurse -Force "src-tauri/binaries/temp"

# ===========================================================================
# Build — Nextcloud app
# ===========================================================================

# Requires: noteberg.key + noteberg.crt in repo root, and `just nc-up` running for signing
# Output: builds/noteberg_nextcloud-<version>.tar.gz + builds/noteberg_nextcloud-<version>.tar.gz.sig
# Build, code-sign, and package the Nextcloud app release (tar.gz + .sig)
build-nc:
    # 0. Sync info.xml <version> from package.json (keeps NC in lockstep)
    just sync-version

    # 1. Build JS/CSS for Nextcloud (NC version = appinfo/info.xml, now synced to package.json)
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

    # 6. Copy the packaged tarball (+ signature) to the Dist share, like the other build-* recipes
    Copy-Item -Path "builds\noteberg_nextcloud-$ncver.tar.gz" -Destination "C:\Users\ThL\Nextcloud\DEV\NoteBerg\Dist\noteberg_nextcloud-$ncver.tar.gz" -Force
    Copy-Item -Path "builds\noteberg_nextcloud-$ncver.tar.gz.sig" -Destination "C:\Users\ThL\Nextcloud\DEV\NoteBerg\Dist\noteberg_nextcloud-$ncver.tar.gz.sig" -Force

    # 7. Cleanup temp dir
    Remove-Item -Recurse -Force "build-nc-tmp"

# ===========================================================================
# Nextcloud dev & test environments (Podman)
# ===========================================================================

# Start the NC dev container (port 8080, repo volume-mounted at /apps-extra/noteberg)
nc-up:
    podman run --rm --name noteberg-nc -d -p 8080:80 -v "${PWD}:/var/www/html/apps-extra/noteberg" ghcr.io/juliusknorr/nextcloud-dev-php84:latest
    $wslIp = (wsl -d podman-machine-default -- ip addr show eth0) -match 'inet ' | ForEach-Object { ($_ -split '\s+')[3] -replace '/\d+$', '' } | Select-Object -First 1
    netsh interface portproxy add v4tov4 listenport=8080 listenaddress=127.0.0.1 connectport=8080 connectaddress=$wslIp 2>&1 | Out-Null
    Write-Host "NoteBerg Nextcloud running at http://localhost:8080 (WSL IP: $wslIp)"
    Write-Host "Run 'npm run dev:nextcloud' in a separate terminal for watch mode"

# Stop the NC dev container (port 8080) and clean up the port proxy
nc-down:
    podman stop noteberg-nc
    netsh interface portproxy delete v4tov4 listenport=8080 listenaddress=127.0.0.1 2>&1 | Out-Null

# Rebuild JS/CSS into the dev container (8080) — hard reload after. Requires: just nc-up
nc-dev-push:
    $env:VITE_NC_BASE = "/apps-extra/noteberg/"; npm run build:nextcloud
    Write-Host "Built for nc-up (8080) — hard reload http://localhost:8080"

# Tests the published package as a real user would — no volume mount, no cache tricks
# php=84 (default, NC 34+) or php=81 (NC 33)
# Spin up a clean NC instance (8081) and install NoteBerg from the App Store (beta channel)
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

# Stop the App Store test container (port 8081) and clean up the port proxy
nc-test-down:
    podman stop noteberg-nc-test
    netsh interface portproxy delete v4tov4 listenport=8081 listenaddress=127.0.0.1 2>&1 | Out-Null; $true

# Requires: just nc-test container running
# Rebuild and push local assets into the running nc-test container for rapid CSS iteration
nc-test-push:
    $env:VITE_NC_BASE = "/apps-writable/noteberg/"; npm run build:nextcloud
    podman cp js/noteberg-main.js noteberg-nc-test:/var/www/html/apps-writable/noteberg/js/noteberg-main.js
    podman cp css/noteberg-styles.css noteberg-nc-test:/var/www/html/apps-writable/noteberg/css/noteberg-styles.css
    podman cp templates/index.php noteberg-nc-test:/var/www/html/apps-writable/noteberg/templates/index.php
    podman cp img noteberg-nc-test:/var/www/html/apps-writable/noteberg/
    Write-Host "Assets pushed — hard reload the browser (Ctrl+Shift+R)."

# Uses official nextcloud:33-apache image (self-contained, no occ pre-setup needed)
# First run: complete the NC web installer at http://localhost:8082 (set admin/admin)
# Spin up a stock Nextcloud 33 (Apache) instance (8082) with NoteBerg volume-mounted
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

# Stop the Nextcloud 33 test container (port 8082) and clean up the port proxy
nc-test33-down:
    podman stop noteberg-nc-test33
    netsh interface portproxy delete v4tov4 listenport=8082 listenaddress=127.0.0.1 2>&1 | Out-Null; $true

# Rebuild JS/CSS into the NC33 test container (8082) — hard reload after. Requires: just nc-test33
nc-test33-push:
    $env:VITE_NC_BASE = "/custom_apps/noteberg/"; npm run build:nextcloud
    Write-Host "Built for nc-test33 (8082) — hard reload http://localhost:8082"

# Restart the Podman machine when it gets into a broken state
podman-restart:
    wsl --terminate podman-machine-default 2>&1 | Out-Null; $true
    Start-Sleep -Seconds 2
    podman machine start
    Write-Host "Podman machine restarted."

# ===========================================================================
# Code quality
# ===========================================================================

# Lint, check, and format the frontend (biome)
check:
    npm run lint
    npm run check
    npm run format

# Format the frontend (biome)
format:
    npm run format

# Run all tests (native + Nextcloud)
test:
    npm run test
    npm run test:nextcloud

# Format, check, and test — the full pre-commit sweep
fct:
    just format
    just check
    just test

# ===========================================================================
# Version / release management
# ===========================================================================
# package.json.version = semver base + optional pre-release label (npm-managed).
# package.json.build   = monotonic build counter (moved ONLY by `just bump-build`).
# All of bump*/set-rc/bump-rc below run `npm version`, which fires the "version"
# npm script (regenerates derived files + git add), then commits + tags.
# They REQUIRE a clean git tree.
#
#   0.5.33         -- just set-rc rc   --> 0.5.33-rc.1   (start a pre-release)
#   0.5.33-rc.1    -- just bump-rc     --> 0.5.33-rc.2   (next pre-release)
#   0.5.33-beta.2  -- just bump-rc     --> 0.5.33-beta.3 (bumps whatever stage is set)
#   0.5.33-beta.2  -- just set-rc rc   --> 0.5.33-rc.1   (switch stage, counter resets)
#   0.5.33-rc.4    -- just bump        --> 0.5.34        (drop label, next patch)

# Print the current version state (semver, stage, build, versionCode, wix); no writes
version-info:
    node sync-version.js --info

# Regenerate derived files (tauri.conf.json, Cargo.toml, info.xml) from package.json; no counter/semver change
sync-version:
    node sync-version.js

# Increment the monotonic build counter (package.json.build += 1) and regenerate derived files; no commit
bump-build:
    node sync-version.js --bump-build

# Usage: just set-rc rc | just set-rc beta
# Set the pre-release stage, starting at .1 (switching stage resets the counter; no-op if already set)
set-rc stage:
    node set-prerelease.js {{stage}}

# Bump the current pre-release counter (rc.1 -> rc.2); FAILS if no pre-release is set (use set-rc first)
bump-rc:
    node bump-prerelease.js

# Bump patch and sync; from a pre-release this DROPS the label: 0.5.33-rc.4 -> 0.5.33
bump:
    npm version patch

# Bump minor and sync (drops any pre-release label): 0.5.33-rc.4 -> 0.6.0
bump-minor:
    npm version minor

# Bump major and sync (drops any pre-release label): 0.5.33-rc.4 -> 1.0.0
bump-major:
    npm version major

# Push to the GitHub mirror (default: main branch)
push-gh branch="main":
    git push github {{branch}}

# Run this only at release time, after CHANGELOG.md/README/docs are updated and committed on gitea
# Publish a release to the public GitHub mirror: pushes main + a matching vX.Y.Z tag
release-gh:
    if ((git status --porcelain) -ne $null) { Write-Error "Working tree not clean — commit or stash first."; exit 1 }
    if ((git rev-parse --abbrev-ref HEAD) -ne "main") { Write-Error "Not on main — checkout main before releasing."; exit 1 }
    git push origin main
    git push origin --tags
    git push github main
    git push github "v{{version}}"

# ===========================================================================
# Utilities
# ===========================================================================

# Remove build artifacts and node_modules
clean:
    Remove-Item -Recurse -Force dist, node_modules -ErrorAction SilentlyContinue

# Install npm dependencies
install:
    npm install
