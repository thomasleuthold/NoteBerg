# oneJournal justfile - Task runner commands
# Set shell for Windows compatibility
set shell := ["powershell.exe", "-c"]

# Default recipe (show available commands)
default:
    @just --list

# Development
dev:
    npm run dev

build:
    npm run build

build-w:
    npm run tauri build
    New-Item -ItemType Directory -Force -Path dist | Out-Null
    Copy-Item -Path "src-tauri\target\release\bundle\msi\*.msi" -Destination "builds\" -Force

build-a:
    npm run tauri android build --release
    New-Item -ItemType Directory -Force -Path dist | Out-Null
    Copy-Item -Path "src-tauri\gen\android\app\build\outputs\apk\universal\release\*.apk" -Destination "builds\" -Force

preview:
    npm run preview

# Code Quality
lint:
    npm run lint

format:
    npm run format

format-check:
    npm run format-check

# Run all checks (lint + format-check)
check:
    npm run lint
    npm run format-check

# Utilities
clean:
    Remove-Item -Recurse -Force dist, node_modules -ErrorAction SilentlyContinue

install:
    npm install

# Open the built app in default browser (Windows)
open-dist:
    Start-Process "dist/index.html"
