# oneJournal justfile - Task runner commands
# Set shell for Windows compatibility
set shell := ["powershell.exe", "-c"]
version := `node -p "require('./package.json').version"`

# Default recipe (show available commands)
default:
    @just --list

# Development
dev:
    npm run tauri dev

build:
    npm run build

build-w:
    npm run tauri build
    New-Item -ItemType Directory -Force -Path dist | Out-Null
    Copy-Item -Path "src-tauri\target\release\bundle\msi\*.msi" -Destination "builds\" -Force

build-a:
    npm run tauri android build --release
    New-Item -ItemType Directory -Force -Path builds | Out-Null
    Copy-Item -Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk" -Destination "builds\oneJournal_{{version}}_android_universal.apk" -Force

preview:
    npm run preview

# Code Quality
check:
    npm run lint
    npm run check
    npm run format

format:
    npm run format

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

# Package the recognition backend and installer script
package-backend:
    dotnet publish src-recognition-backend -c Release -r win-x64 --self-contained false -o dist-backend
    Copy-Item "src-recognition-backend/install-service.ps1" -Destination "dist-backend/"

# Increase version (patch) and sync
bump:
    npm version patch

# Increase version (patch) and sync
bump-minor:
    npm version minor

# Increase version (patch) and sync
bump-major:
    npm version major