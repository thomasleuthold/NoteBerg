# Security Policy

## Supported Versions

NoteBerg is currently pre-1.0. Only the latest released
version (Nextcloud app, desktop, and Android builds) receives security fixes.
Please make sure you're on the latest release before reporting an issue.

| Version         | Supported          |
| ---------------- | ------------------ |
| Latest release   | :white_check_mark: |
| Older releases    | :x:                |

## Reporting a Vulnerability

Please report security vulnerabilities privately by email to
**noteberg@posteo.org** rather than opening a public GitHub issue.

Include as much detail as you can:
- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof of concept
- The affected platform (Nextcloud app, Windows/Android client) and version

This is a hobby project maintained by one person in their spare time, so
please bear with realistic timelines: you can expect an acknowledgement
within 1–2 weeks. Fixes are best-effort — straightforward issues are
typically addressed within a couple of months, but more complex ones may take
longer.

There is no bug bounty program.

## Data & Privacy Notes

NoteBerg stores all note data exclusively on your own Nextcloud server via
WebDAV — there is no third-party backend or telemetry. Vulnerability reports
related to how notes sync with, or are stored on, self-hosted Nextcloud
instances are very much in scope and welcome.
