# NoteBerg justfile - Task runner commands
# Set shell for Windows compatibility
set shell := ["powershell.exe", "-c"]
version := `node -p "require('./package.json').version"`
build := `node -p "require('./package.json').build"`
dist := "C:\\Users\\ThL\\Nextcloud\\DEV\\NoteBerg\\Dist"

# Default recipe (show available commands, in semantic source order)
default:
    @just --list --unsorted

# ===========================================================================
# Development
# ===========================================================================

# Run the Tauri desktop app in dev mode (Rust in release profile — see dev-debug for the debug profile)
dev:
    # Nearly all day-to-day iteration is JS via Vite HMR, unaffected by the Rust
    # profile — so this reuses build-w's `release` target tree instead of also
    # maintaining a separate multi-GB `debug` tree. Switch to `just dev-debug`
    # when actually debugging Rust code (debug assertions, better backtraces).
    Get-Process -Name "NoteBerg.Recognition" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*src-tauri*" } | Stop-Process -Force -ErrorAction SilentlyContinue; $true
    just package-sidecar
    npm run tauri dev -- --release

# Run the Tauri desktop app in dev mode with Rust in debug profile (costs a separate ~15GB target tree)
dev-debug:
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
    $msi = Get-ChildItem -Path "src-tauri\target\release\bundle\msi" -Filter "*.msi" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1; if (-not $msi) { Write-Error "No MSI found in src-tauri\target\release\bundle\msi — did 'npm run tauri build' produce an MSI target?"; exit 1 }; powershell -File scripts/publish-artifact.ps1 -Source $msi.FullName -Destination "{{dist}}\noteberg_windows-{{version}}.{{build}}.msi"

# Build the Android app (APK) and copy to the Dist share
build-a:
    just sync-version
    if (Test-Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\") { Remove-Item -Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\*" -Force -Recurse -ErrorAction SilentlyContinue }
    just patch-android
    npm run tauri android build -- --apk
    New-Item -ItemType Directory -Force -Path builds | Out-Null
    powershell -File scripts/publish-artifact.ps1 -Source "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk" -Destination "{{dist}}\noteberg_android-{{version}}.{{build}}-universal.apk"

# Build the Android app bundle (AAB) and copy to the Dist share
build-aab:
    just sync-version
    if (Test-Path "src-tauri\gen\android\app\build\outputs\bundle\universalRelease\") { Remove-Item -Path "src-tauri\gen\android\app\build\outputs\bundle\universalRelease\*" -Force -Recurse -ErrorAction SilentlyContinue }
    just patch-android
    npm run tauri android build -- --aab
    New-Item -ItemType Directory -Force -Path builds | Out-Null
    powershell -File scripts/publish-artifact.ps1 -Source "src-tauri\gen\android\app\build\outputs\bundle\universalRelease\app-universal-release.aab" -Destination "{{dist}}\noteberg_android-{{version}}.{{build}}.aab"

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
    # 0. Sync the info.xml <version> BASE from package.json (keeps NC in lockstep).
    #    Any hand-set pre-release suffix ("-rc.2") in info.xml is preserved — that
    #    is the only place RC stages live. Check the printed version before shipping.
    just sync-version

    # 1. Build JS/CSS for Nextcloud (NC version = appinfo/info.xml, base now synced)
    # Wipe js/ and css/ first: outDir is the repo root with emptyOutDir=false, so
    # Vite never cleans them. Stale chunks from an earlier build otherwise survive,
    # get copied into the tarball, and shadow fresh ones at runtime (mangled export
    # names are not stable across builds -> "doesn't provide an export named 'n'").
    if (Test-Path "js")  { Remove-Item -Recurse -Force "js" }
    if (Test-Path "css") { Remove-Item -Recurse -Force "css" }
    # No VITE_NC_BASE: the default relative base makes chunk URLs resolve against
    # the importing module, so the build works on any webroot (/, /nextcloud/, ...).
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
    # pdfjs-wasm holds the JBig2/JPX decoders pdf.js fetches at runtime from
    # apps/noteberg/pdfjs-wasm/. Omitting it 404s those fetches, and a PDF whose
    # pages ARE JBig2 scans (the common case for scanned books) then renders as
    # blank white pages — pdf.js logs "ignoring XObject" and returns an empty
    # operator list, so nothing surfaces as an error to catch.
    Copy-Item -Recurse "pdfjs-wasm" "build-nc-tmp\noteberg\"

    # 2b. Stage the changelog as appinfo/CHANGELOG.md — that is where the NC App
    # Store reads release notes from. The top section's heading is rewritten to
    # the info.xml version on the way in, since the store only shows a section
    # whose version matches. Must run AFTER the appinfo copy above, which would
    # otherwise overwrite it. The repo's CHANGELOG.md is not modified.
    powershell -File scripts/stage-nc-changelog.ps1 -Destination "build-nc-tmp\noteberg\appinfo\CHANGELOG.md"

    # 3. Code-sign via occ in the Nextcloud dev container (must be running: just nc-up)
    Write-Host "Code-signing app via occ in Nextcloud container..."
    podman exec noteberg-nc bash -c "php /var/www/html/occ integrity:sign-app --privateKey=/var/www/html/apps-extra/noteberg/noteberg.key --certificate=/var/www/html/apps-extra/noteberg/noteberg.crt --path=/var/www/html/apps-extra/noteberg/build-nc-tmp/noteberg"

    # 4+5. Package tar.gz and sign (version read from info.xml inside script)
    powershell -File scripts/package-nc-release.ps1

    # 6. Copy the packaged tarball (+ signature) to the Dist share, like the other build-* recipes
    # The published name carries the build number; any -rc.N suffix stays last, so
    # "0.5.40-rc.2" build 7 publishes as "noteberg_nextcloud-0.5.40.7-rc.2.tar.gz".
    $ncver = (Select-Xml -Path appinfo/info.xml -XPath "//version").Node.InnerText; $m = [regex]::Match($ncver, '^(\d+\.\d+\.\d+)(.*)$'); $ncname = $m.Groups[1].Value + ".{{build}}" + $m.Groups[2].Value; powershell -File scripts/publish-artifact.ps1 -Source "builds\noteberg_nextcloud-$ncver.tar.gz" -Destination "{{dist}}\noteberg_nextcloud-$ncname.tar.gz"; powershell -File scripts/publish-artifact.ps1 -Source "builds\noteberg_nextcloud-$ncver.tar.gz.sig" -Destination "{{dist}}\noteberg_nextcloud-$ncname.tar.gz.sig"

    # 7. Cleanup temp dir
    Remove-Item -Recurse -Force "build-nc-tmp"

# ===========================================================================
# Nextcloud dev & test environments (Podman)
# ===========================================================================

# Expose a container port to Windows as http://localhost:<listen>.
#
# Why a relay and not `netsh portproxy`:
# WSL2 automatically forwards localhost to any port listening in the distro's
# ROOT network namespace — no configuration, no admin. Podman containers do not
# benefit from that: they listen inside podman's own network namespace, which
# WSL's forwarder cannot see, so http://localhost:<port> gets nothing.
#
# portproxy was the old workaround (route Windows -> the VM's eth0 IP), but it
# needs an ELEVATED shell, and on this setup Windows cannot reach the VM subnet
# at all — the entry accepts the connection and then resets it, which surfaces in
# a browser as NS_ERROR_NET_EMPTY_RESPONSE. It also breaks whenever the VM's IP
# changes on restart.
#
# This relay instead runs a tiny socket forwarder INSIDE the VM's root namespace,
# bridging <listen> to the container's published port. WSL then forwards
# localhost:<listen> natively. No elevation, and no dependency on the VM's IP.
[private]
_relay listen target:
    #!powershell.exe
    $ErrorActionPreference = 'Continue'
    # Copy the relay into the VM (the repo's /mnt/c path is slow and may not be
    # mounted in every distro), then start it detached. pkill first so repeated
    # `just nc-up` calls don't stack relays on the same port.
    wsl -d podman-machine-default -- sh -c "pkill -f 'wsl-relay.py {{listen}} ' 2>/dev/null; exit 0" 2>&1 | Out-Null
    $script = (Resolve-Path "scripts/wsl-relay.py").Path
    $wslPath = wsl -d podman-machine-default -- wslpath -a "$($script -replace '\\','/')"
    wsl -d podman-machine-default -- sh -c "cp '$wslPath' /tmp/wsl-relay.py; nohup setsid python3 /tmp/wsl-relay.py {{listen}} {{target}} >/dev/null 2>&1 < /dev/null & sleep 1; exit 0" 2>&1 | Out-Null
    Write-Host "Ready at http://localhost:{{listen}}" -ForegroundColor Green

# Stop the relay for <listen>.
[private]
_relay-down listen:
    #!powershell.exe
    $ErrorActionPreference = 'Continue'
    wsl -d podman-machine-default -- sh -c "pkill -f 'wsl-relay.py {{listen}} ' 2>/dev/null; exit 0" 2>&1 | Out-Null
    exit 0

# Start the NC dev container (port 8080, repo volume-mounted at /apps-extra/noteberg)
nc-up:
    podman run --rm --name noteberg-nc -d -p 8080:80 -v "${PWD}:/var/www/html/apps-extra/noteberg" ghcr.io/juliusknorr/nextcloud-dev-php84:latest
    just _relay 8180 8080
    just _trust-lan-ip noteberg-nc 8180
    Write-Host "Run 'npm run dev:nextcloud' in a separate terminal for watch mode"

# Add this machine's LAN IP to the container's trusted_domains, so the instance
# can be opened from a phone on the same network (http://<lan-ip>:8180) instead
# of only from localhost. Without it Nextcloud refuses the host outright with
# "Access through untrusted domain".
#
# The IP is detected at run time rather than hardcoded: it comes from DHCP, so it
# changes between networks and machines. The adapter is chosen by preferring one
# with a default gateway and skipping WSL's virtual adapter, link-local
# addresses, and loopback — on this setup the raw list also contains a WSL
# adapter (172.20.x) and a WireGuard interface, neither of which a phone can
# reach.
#
# Containers run with --rm, so this is lost on nc-down and has to run on every
# start. Non-fatal: a failure here only costs LAN access, not the container.
[private]
_trust-lan-ip container listen:
    #!powershell.exe
    $ErrorActionPreference = 'Continue'
    $ip = (Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address -and $_.InterfaceAlias -notlike '*WSL*' -and $_.InterfaceAlias -notlike '*Loopback*' -and $_.IPv4Address.IPAddress -notlike '169.254.*' } | Sort-Object { $_.IPv4DefaultGateway -eq $null } | Select-Object -First 1).IPv4Address.IPAddress
    if (-not $ip) { Write-Host "No LAN IP found - skipping trusted_domains (localhost still works)" -ForegroundColor Yellow; exit 0 }
    # //bin/sh rather than bash: the stock nextcloud:*-apache image (nc-test33)
    # has no bash. The doubled slash stops Git Bash / MSYS rewriting the path.
    podman exec {{container}} //bin/sh -c "php /var/www/html/occ config:system:set trusted_domains 4 --value=$ip" 2>&1 | Out-Null
    Write-Host "Reachable on this network at http://${ip}:{{listen}}" -ForegroundColor Green
    exit 0

# Stop the NC dev container (port 8080) and clean up the port proxy
nc-down:
    podman stop noteberg-nc
    just _relay-down 8180

# Rebuild JS/CSS into the dev container (8080) — hard reload after. Requires: just nc-up
nc-dev-push:
    npm run build:nextcloud
    Write-Host "Built for nc-up — hard reload http://localhost:8180"

# Tests the published package as a real user would — no volume mount, no cache tricks
# php=84 (default, NC 34+) or php=81 (NC 33)
# Spin up a clean NC instance (8081) and install NoteBerg from the App Store (beta channel)
nc-test php="84":
    podman stop noteberg-nc-test 2>&1 | Out-Null; $true
    podman run --rm --name noteberg-nc-test -d -p 8081:80 ghcr.io/juliusknorr/nextcloud-dev-php{{php}}:latest
    just _relay 8181 8081
    Write-Host "Waiting for Nextcloud to initialize..."
    Start-Sleep -Seconds 15
    podman exec noteberg-nc-test bash -c "php /var/www/html/occ config:system:set updater.release.channel --value=beta"
    podman exec noteberg-nc-test bash -c "php /var/www/html/occ config:app:delete core lastupdatedat"
    podman exec noteberg-nc-test bash -c "php /var/www/html/occ app:install --allow-unstable noteberg"
    just _trust-lan-ip noteberg-nc-test 8181
    Write-Host "NoteBerg installed from App Store. Open http://localhost:8181 (admin/admin) to test."
    Write-Host "Run 'just nc-test-down' when done."

# Stop the App Store test container (port 8081) and clean up the port proxy
nc-test-down:
    podman stop noteberg-nc-test
    just _relay-down 8181

# Requires: just nc-test container running
# Rebuild and push local assets into the running nc-test container for rapid CSS iteration
nc-test-push:
    # Wipe js/ and css/ first — see the note in build-nc. Stale chunks otherwise linger.
    if (Test-Path "js")  { Remove-Item -Recurse -Force "js" }
    if (Test-Path "css") { Remove-Item -Recurse -Force "css" }
    npm run build:nextcloud
    # Copy the whole js/ dir, not just the entry: chunks carry content hashes, so
    # their filenames change between builds and must be replaced wholesale.
    podman exec noteberg-nc-test rm -rf /var/www/html/apps-writable/noteberg/js
    podman cp js noteberg-nc-test:/var/www/html/apps-writable/noteberg/
    podman cp css/noteberg-styles.css noteberg-nc-test:/var/www/html/apps-writable/noteberg/css/noteberg-styles.css
    podman cp templates/index.php noteberg-nc-test:/var/www/html/apps-writable/noteberg/templates/index.php
    podman cp img noteberg-nc-test:/var/www/html/apps-writable/noteberg/
    Write-Host "Assets pushed — hard reload the browser (Ctrl+Shift+R)."

# Uses official nextcloud:33-apache image (self-contained, no occ pre-setup needed)
# First run: complete the NC web installer at http://localhost:8182 (set admin/admin)
# Spin up a stock Nextcloud 33 (Apache) instance (8082) with NoteBerg volume-mounted
nc-test33:
    podman stop noteberg-nc-test33 2>&1 | Out-Null; $true
    podman run --rm --name noteberg-nc-test33 -d -p 8082:80 -v "${PWD}:/var/www/html/custom_apps/noteberg" nextcloud:33-apache
    just _relay 8182 8082
    Write-Host "Waiting for Nextcloud to initialize..."
    Start-Sleep -Seconds 20
    podman exec noteberg-nc-test33 //bin/sh -c "php /var/www/html/occ app:enable noteberg 2>&1"
    just _trust-lan-ip noteberg-nc-test33 8182
    Write-Host "Nextcloud 33 running at http://localhost:8182 (admin/admin)"
    Write-Host "Run 'just nc-test33-push' to deploy local build. Run 'just nc-test33-down' when done."

# Stop the Nextcloud 33 test container (port 8082) and clean up the port proxy
nc-test33-down:
    podman stop noteberg-nc-test33
    just _relay-down 8182

# Rebuild JS/CSS into the NC33 test container (8082) — hard reload after. Requires: just nc-test33
nc-test33-push:
    npm run build:nextcloud
    Write-Host "Built for nc-test33 — hard reload http://localhost:8182"

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
# package.json.version = plain semver, no pre-release label (npm-managed).
# package.json.build   = monotonic build counter (moved ONLY by `just bump-build`).
# None of the recipes below touch git: they rewrite package.json and regenerate the
# derived files (tauri.conf.json, Cargo.toml, info.xml), nothing more. No commit,
# no tag, no clean-tree requirement — so they can be run with work in flight.
# Commit and tag yourself when the tree is ready:
#
#   git commit -am "0.5.39" && git tag v0.5.39
#
#   0.5.33  -- just bump        --> 0.5.34  (next patch)
#   0.5.33  -- just bump-minor  --> 0.6.0
#   0.5.33  -- just bump-major  --> 1.0.0
#
# RC / pre-release stages are Nextcloud-only and are NOT managed here. Edit
# appinfo/info.xml by hand:
#
#   <version>0.5.33-rc.2</version>
#
# `just sync-version` keeps the base (0.5.33) in lockstep with package.json and
# preserves the "-rc.2" suffix, so a manual stage survives every build. Remove the
# suffix by hand to publish a final release to the NC store.

# Print the current version state (semver, build, versionCode, wix, NC version); no writes
version-info:
    node sync-version.js --info

# Regenerate derived files (tauri.conf.json, Cargo.toml, info.xml) from package.json; no counter/semver change
sync-version:
    node sync-version.js

# Increment the monotonic build counter (package.json.build += 1) and regenerate derived files; no commit
bump-build:
    node sync-version.js --bump-build

# Bump patch and sync: 0.5.33 -> 0.5.34 (any info.xml RC suffix is preserved)
bump:
    npm version patch --no-git-tag-version
    node sync-version.js

# Bump minor and sync: 0.5.33 -> 0.6.0
bump-minor:
    npm version minor --no-git-tag-version
    node sync-version.js

# Bump major and sync: 0.5.33 -> 1.0.0
bump-major:
    npm version major --no-git-tag-version
    node sync-version.js

# Push to the GitHub mirror (default: main branch)
push-gh branch="main":
    git push github {{branch}}

# ===========================================================================
# Utilities
# ===========================================================================

# Remove build artifacts and node_modules
clean:
    Remove-Item -Recurse -Force dist, node_modules -ErrorAction SilentlyContinue

# Install npm dependencies
install:
    npm install
