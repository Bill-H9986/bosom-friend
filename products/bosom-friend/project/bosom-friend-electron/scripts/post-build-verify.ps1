$ErrorActionPreference = "Continue"
$inst = "C:/Users/Jay/AppData/Local/Programs/ZhiYin"
$log = "$env:APPDATA/zhiyin/logs/" + (Get-Date -Format "yyyy-MM-dd") + ".log"

Write-Output "== STEP2 launch =="
Start-Process -FilePath ($inst + '/知音.exe') -WorkingDirectory $inst
Start-Sleep 60
$mongod = (Get-CimInstance Win32_Process -Filter "Name='mongod.exe'" | Select-Object -First 1).CommandLine
Write-Output ("replset_flag=" + ($mongod -match "--replSet"))

Write-Output "== STEP3 rs-init log =="
Start-Sleep 10
$rsLine = Get-Content $log -ErrorAction SilentlyContinue | Select-String "rs-init" | Select-Object -Last 2
if ($rsLine) { $rsLine | ForEach-Object { $t = $_.Line; $t.Substring([Math]::Max(0,$t.Length-130)) } } else { Write-Output "no-rs-log" }

Write-Output "== STEP4 api retest =="
$mail = "verifier@zhiyin.local"
$r1 = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8080/api/login/mail" -Body ((@{mail=$mail}) | ConvertTo-Json) -ContentType "application/json"
$v = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8080/api/login/mail/verify" -Body ((@{mail=$mail;code=$r1.data.devCode}) | ConvertTo-Json) -ContentType "application/json"
$tok = "Bearer " + $v.data.token
$hj = @{ Authorization = $tok }
$jsonBody = (@{name="e2e-del-group"} | ConvertTo-Json)
$bodyStr = [Text.Encoding]::UTF8.GetBytes($jsonBody)
$g = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8080/api/v2/channels/account-groups" -Headers $hj -Body $bodyStr -ContentType "application/json; charset=utf-8"
Write-Output ("create_code=" + $g.code)
$gid = $g.data.id
$d = Invoke-RestMethod -Method Delete -Uri ("http://127.0.0.1:8080/api/v2/channels/account-groups?ids%5B%5D=" + $gid) -Headers $hj
Write-Output ("delete_code_500before=" + $d.code)
$l = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/v2/channels/account-groups" -Headers $hj
Write-Output ("final_group_count=" + @($l.data).Count)

Write-Output "== STEP5 nginx treekill regression =="
taskkill /IM '知音.exe' 2>&1 | Out-Null; Start-Sleep 14
$ng = @(Get-Process nginx -ErrorAction SilentlyContinue).Count
$mg = @(Get-Process mongod -ErrorAction SilentlyContinue).Count
Write-Output ("after_quit nginx=" + $ng + " mongod=" + $mg + " => " + $(if (($ng -eq 0) -and ($mg -eq 0)) { "PASS" } else { "FAIL" }))