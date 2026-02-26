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
    npm run tauri android build --release
    New-Item -ItemType Directory -Force -Path builds | Out-Null
    # Copy-Item -Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk" -Destination "builds\NoteBerg_{{version}}_android_universal.apk" -Force
    Copy-Item -Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk" -Destination "C:\Users\ThL\Nextcloud\DEV\NoteBerg\Dist\NoteBerg_{{version}}_android_universal.apk" -Force

build-aab:
    if (Test-Path "src-tauri\gen\android\app\build\outputs\bundle\universalRelease\") { Remove-Item -Path "src-tauri\gen\android\app\build\outputs\bundle\universalRelease\*" -Force -Recurse -ErrorAction SilentlyContinue }
    npm run tauri android build --release -- --aab
    New-Item -ItemType Directory -Force -Path builds | Out-Null
    Copy-Item -Path "src-tauri\gen\android\app\build\outputs\bundle\universalRelease\app-universal-release.aab" -Destination "C:\Users\ThL\Nextcloud\DEV\NoteBerg\Dist\NoteBerg_{{version}}_android.aab" -Force

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