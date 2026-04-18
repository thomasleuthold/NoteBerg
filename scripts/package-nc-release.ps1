$ncver = (Select-Xml -Path appinfo/info.xml -XPath "//version").Node.InnerText
Write-Host "NC version: $ncver"

# Package into tar.gz via container
New-Item -ItemType Directory -Force -Path "builds" | Out-Null
podman exec noteberg-nc bash -c "tar -czf /var/www/html/apps-extra/noteberg/builds/noteberg-$ncver.tar.gz -C /var/www/html/apps-extra/noteberg/build-nc-tmp/ noteberg"
Write-Host "Created builds/noteberg-$ncver.tar.gz"

# Sign the archive
$sig = (openssl dgst -sha512 -sign noteberg.key "builds/noteberg-$ncver.tar.gz" | openssl base64) -join ""
$sig | Out-File -NoNewline -Encoding ascii "builds/noteberg-$ncver.tar.gz.sig"
Write-Host "Archive signature written to builds/noteberg-$ncver.tar.gz.sig"
Write-Host $sig

Write-Host "Done! Upload builds/noteberg-$ncver.tar.gz to the NC App Store."
