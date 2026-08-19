# Copy a build artifact to the Dist share, replacing any existing file.
#
# Copy-Item -Force alone is not enough on the Nextcloud-synced Dist share: if the
# sync client (or an antivirus scanner) holds a handle on the target, the copy
# fails and the STALE file silently stays behind -- the failure looked like "the
# new file is not copied". So delete the target first, verify it is really gone,
# and fail loudly if the copy did not land.
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Source)) {
    Write-Error "publish-artifact: source not found: $Source"
    exit 1
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null

if (Test-Path -LiteralPath $Destination) {
    Write-Host "publish-artifact: removing existing $Destination"
    # Clear ReadOnly first -- Remove-Item -Force handles it, but a synced file can
    # also come back marked read-only, and the explicit reset keeps the error below
    # about locking rather than attributes.
    try { Set-ItemProperty -LiteralPath $Destination -Name IsReadOnly -Value $false } catch {}
    Remove-Item -LiteralPath $Destination -Force
    if (Test-Path -LiteralPath $Destination) {
        Write-Error "publish-artifact: could not delete $Destination (file locked?) -- not overwriting"
        exit 1
    }
}

Copy-Item -LiteralPath $Source -Destination $Destination -Force

# Confirm the copy actually landed and is the size we expect.
$src = Get-Item -LiteralPath $Source
$dst = Get-Item -LiteralPath $Destination -ErrorAction SilentlyContinue
if (-not $dst) {
    Write-Error "publish-artifact: copy reported success but $Destination is missing"
    exit 1
}
if ($dst.Length -ne $src.Length) {
    $dstLen = $dst.Length
    $srcLen = $src.Length
    Write-Error "publish-artifact: size mismatch for $Destination - $dstLen vs $srcLen bytes"
    exit 1
}

$sizeMb = [math]::Round($dst.Length / 1MB, 1)
Write-Host "publish-artifact: $Destination ($sizeMb MB)"
