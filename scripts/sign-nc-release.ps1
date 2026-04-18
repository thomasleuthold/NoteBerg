param([string]$Version)
$tarball = "builds/noteberg-$Version.tar.gz"
$sigfile = "builds/noteberg-$Version.tar.gz.sig"
$sig = (openssl dgst -sha512 -sign noteberg.key $tarball | openssl base64) -join ""
$sig | Out-File -NoNewline -Encoding ascii $sigfile
Write-Host "Archive signature written to $sigfile"
Write-Host $sig
