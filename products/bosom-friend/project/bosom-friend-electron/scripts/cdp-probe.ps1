# 探测CDP目标并落盘
$deadline = (Get-Date).AddSeconds(60)
$result = 'TIMEOUT'
while ((Get-Date) -lt $deadline) {
    $raw = curl.exe -s --max-time 5 http://127.0.0.1:9223/json/list 2>$null
    if ($raw) {
        try {
            $targets = ($raw -join ([char]10)) | ConvertFrom-Json
            $pages = $targets | Where-Object { $_.type -eq 'page' }
            if ($pages) {
                $result = $pages | ForEach-Object { "[page] " + $_.title + " | " + $_.url } | Out-String
                break
            }
        } catch {}
    }
    Start-Sleep -Seconds 3
}
Set-Content -Path "$env:TEMP\cdp-targets.txt" -Value $result -Encoding UTF8