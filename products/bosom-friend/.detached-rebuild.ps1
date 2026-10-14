$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'bf-rebuild2.log'
"=== start $(Get-Date -Format o) ===" | Out-File -FilePath $log -Encoding utf8
Set-Location 'C:\Users\Jay\Desktop\Bosom friend APP\products\bosom-friend\desktop'
& powershell -NoProfile -ExecutionPolicy Bypass -File '.\rebuild-kernel-and-installer.ps1' *>> $log
"=== exit=$LASTEXITCODE $(Get-Date -Format o) ===" | Out-File -FilePath $log -Append -Encoding utf8
