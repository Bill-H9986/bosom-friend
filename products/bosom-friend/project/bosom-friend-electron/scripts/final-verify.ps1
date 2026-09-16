$ErrorActionPreference = "Continue"
$inst = "C:/Users/Jay/AppData/Local/Programs/ZhiYin"
$log = "$env:APPDATA/zhiyin/logs/" + (Get-Date -Format "yyyy-MM-dd") + ".log"

# STEP0 uninstall + fresh install (oneClick build)
Get-Process '知音' -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 5
$un = Get-ChildItem $inst -Filter 'Uninstall*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($un) { Start-Process -FilePath $un.FullName -ArgumentList "/S" -PassThru -Wait | Out-Null; Start-Sleep 3 }
$p = Start-Process -FilePath "C:/Users/Jay/Desktop/ZhiYin-Ai smart system/project/aitoearn-electron/release/0.11.0/ZhiYin-0.11.0.exe" -ArgumentList "/S" -PassThru -Wait
Write-Output ("RESULT install_exit=" + $p.ExitCode)

# STEP1 launch and wait up to 240s for nginx ready log
Start-Process -FilePath ($inst + "/知音.exe") -WorkingDirectory $inst
$ready = $false
for ($i = 1; $i -le 48; $i++) {
    Start-Sleep 5
    if ((Get-Content $log -Tail 200 -ErrorAction SilentlyContinue | Select-String "_nhealth")) { $ready = $true; break }
}
Write-Output ("RESULT nginx_ready=" + $ready + " at_" + ($i*5) + "s")
$mongod = (Get-CimInstance Win32_Process -Filter "Name='mongod.exe'" | Select-Object -First 1).CommandLine
Write-Output ("RESULT replset_flag=" + ($mongod -match "--replSet"))
$rs = Get-Content $log | Select-String "rs-init" | Select-Object -Last 2
if ($rs) { $rs | ForEach-Object { $t = $_.Line; Write-Output ("LOG " + $t.Substring([Math]::Max(0,$t.Length-110))) } }

# STEP2 api group delete retest
$mail = "final@zhiyin.local"
$r1 = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8080/api/login/mail" -Body ((@{mail=$mail}) | ConvertTo-Json) -ContentType "application/json"
$v = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8080/api/login/mail/verify" -Body ((@{mail=$mail;code=$r1.data.devCode}) | ConvertTo-Json) -ContentType "application/json"
$hj = @{ Authorization = "Bearer " + $v.data.token }
$jb = [Text.Encoding]::UTF8.GetBytes((@{name="del-group-test"} | ConvertTo-Json))
$g = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8080/api/v2/channels/account-groups" -Headers $hj -Body $jb -ContentType "application/json; charset=utf-8"
$d = Invoke-RestMethod -Method Delete -Uri ("http://127.0.0.1:8080/api/v2/channels/account-groups?ids%5B%5D=" + $g.data.id) -Headers $hj
Write-Output ("RESULT group_create=" + $g.code + " group_delete_500_before=" + $d.code)

# STEP3 nginx treekill regression
taskkill /IM '知音.exe' 2>&1 | Out-Null; Start-Sleep 15
$ng = @(Get-Process nginx -ErrorAction SilentlyContinue).Count
$mg = @(Get-Process mongod -ErrorAction SilentlyContinue).Count
Write-Output ("RESULT after_quit nginx=" + $ng + " mongod=" + $mg + " => " + $(if (($ng -eq 0) -and ($mg -eq 0)) { "PASS" } else { "FAIL" }))