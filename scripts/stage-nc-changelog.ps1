# Stage CHANGELOG.md into the Nextcloud app package.
#
# The Nextcloud App Store reads release notes from appinfo/CHANGELOG.md inside
# the uploaded archive, and only shows a section whose heading version matches
# the <version> in info.xml. Our working changelog heads the current release as
# "## [Unreleased] - 0.5.40" (or an older version once released), so a verbatim
# copy would never match and the store silently shows no release notes.
#
# This rewrites an "[Unreleased]" top heading to the packaged version on the way
# in. Only the staged copy is touched; CHANGELOG.md in the repo is never
# modified.
#
# If the top section names a DIFFERENT version instead, the build fails: that
# means no section describes the release being packaged, and renaming would ship
# the previous release's notes under the new number.
#
# The store matches the plain semver, so a pre-release suffix in info.xml
# ("0.5.40-RC.2") is reduced to its base ("0.5.40") for the heading.

param(
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = "Stop"

$source = "CHANGELOG.md"
if (-not (Test-Path $source)) {
    throw "$source not found - cannot stage the Nextcloud changelog."
}

$ncver = (Select-Xml -Path appinfo/info.xml -XPath "//version").Node.InnerText
# "0.5.40-RC.2" -> "0.5.40". The store keys release notes off the base version.
$baseVer = [regex]::Match($ncver, '^\d+\.\d+\.\d+').Value
if (-not $baseVer) {
    throw "Could not parse a semver from info.xml <version> '$ncver'."
}

$lines = Get-Content $source
$today = Get-Date -Format "yyyy-MM-dd"

# Find the first "## [...]" section heading - that is the release being shipped.
$idx = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^##\s+\[') { $idx = $i; break }
}
if ($idx -lt 0) {
    throw "No '## [...]' section heading found in $source."
}

$heading = $lines[$idx]
$headingVer = [regex]::Match($heading, '^##\s+\[(\d+\.\d+\.\d+)\]').Groups[1].Value

if ($headingVer -eq $baseVer) {
    # Already a proper dated heading for this version - leave it untouched so a
    # real release date is not overwritten with today's date on a rebuild.
    Write-Host "Changelog top section already matches $baseVer - keeping '$heading'."
}
elseif ($headingVer) {
    # The newest section is for a DIFFERENT version, so the changelog has no
    # section describing what is being packaged. Renaming it would publish the
    # previous release's notes under the new version number - silently wrong,
    # and only visible after the release is live. Fail the build instead.
    throw @"
Changelog/version mismatch: the newest section in $source is [$headingVer], but appinfo/info.xml declares $baseVer.

There is no changelog section describing $baseVer, so the Nextcloud App Store would show the wrong release notes.

Fix one of the two:
  * add a '## [Unreleased] - $baseVer' section to $source describing this release, or
  * correct the <version> in appinfo/info.xml if $headingVer is what you meant to ship.
"@
}
else {
    # An [Unreleased] heading: this is the expected path. Stamp it with the
    # packaged version and today's date.
    $lines[$idx] = "## [$baseVer] - $today"
    Write-Host "Rewrote changelog heading: '$heading' -> '$($lines[$idx])'"
}

$destDir = Split-Path -Parent $Destination
if ($destDir -and -not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
}

# UTF-8 without BOM: the store parses the file as plain markdown.
[System.IO.File]::WriteAllLines(
    (Resolve-Path -LiteralPath $destDir).Path + "\" + (Split-Path -Leaf $Destination),
    $lines,
    (New-Object System.Text.UTF8Encoding($false))
)
Write-Host "Staged changelog to $Destination"
