param (
    [string]$InstallPath = "C:\Program Files\OneJournal\RecognitionService",
    [string]$ServiceName = "OneJournalRecognition"
)

# Ensure Admin
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

Write-Host "Installing $ServiceName..."

# Stop existing service
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    Write-Host "Stopping existing service..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    
    # Wait for service to stop
    $timeout = 10
    while ($service.Status -ne 'Stopped' -and $timeout -gt 0) {
        Start-Sleep -Seconds 1
        $service.Refresh()
        $timeout--
    }

    Write-Host "Removing existing service..."
    # Use sc.exe for reliable removal (PowerShell's Remove-Service is not available in all versions)
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
}

# Create directory
if (-not (Test-Path -Path $InstallPath)) {
    New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
}

# Copy files
Write-Host "Copying files to $InstallPath..."
Copy-Item -Path "$PSScriptRoot\*" -Destination $InstallPath -Recurse -Force -Exclude "install-service.ps1", "*.pdb"

# Register Service
$exePath = Join-Path $InstallPath "OneJournal.Recognition.exe"

if (Test-Path $exePath) {
    Write-Host "Registering service..."
    New-Service -Name $ServiceName -BinaryPathName $exePath -DisplayName "OneJournal Handwriting Recognition" -Description "Backend service for OneJournal handwriting recognition." -StartupType Automatic
    Write-Host "Starting service..."
    Start-Service -Name $ServiceName
    Write-Host "Installation successfully completed."
} else {
    Write-Error "Executable not found at $exePath. Installation failed."
}