$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3080'
$J = 'application/json'
$login = Invoke-RestMethod -Uri ($base + '/bosom-friend/api/auth/login') -Method Post -ContentType $J -Body '{"username":"qa-tester","password":"qa-123456"}'
if ($login.code -ne 0) {
  Invoke-RestMethod -Uri ($base + '/bosom-friend/api/auth/register') -Method Post -ContentType $J -Body '{"username":"qa-tester","password":"qa-123456","name":"QA"}' | Out-Null
  $login = Invoke-RestMethod -Uri ($base + '/bosom-friend/api/auth/login') -Method Post -ContentType $J -Body '{"username":"qa-tester","password":"qa-123456"}'
}
$H = @{ Authorization = ('Bearer ' + $login.data.token) }

Write-Output '[5] publish flow create'
$flowBody = '{"content":{"title":"秋日咖啡笔记","body":"正文内容","media":[]},"publishAt":"","context":{"type":"ImageText"},"items":[{"accountId":"acc-test1","platform":"xiaohongshu"},{"accountId":"acc-test2","platform":"douyin"}]}'
$f = Invoke-RestMethod -Uri ($base + '/bosom-friend/api/v2/channels/publish/flows') -Method Post -ContentType $J -Headers $H -Body $flowBody
Write-Output ("flowId=" + $f.data.flowId + " tasks=" + $f.data.tasks.Count)

Write-Output '[6] records list'
$rec = Invoke-RestMethod -Uri ($base + '/bosom-friend/api/v2/channels/publish/records') -Headers $H
Write-Output ("code=" + $rec.code + " records=" + $rec.data.records.Count + " status0=" + $rec.data.records[0].status)

Write-Output '[7] dashboard'
$d = Invoke-RestMethod -Uri ($base + '/bosom-friend/api/v2/statistics/published-content-summary/dashboard') -Headers $H
Write-Output ("code=" + $d.code + " published=" + $d.data.overall.publishedWorkCount + " trend=" + $d.data.growthTrend.Count + " contrib=" + $d.data.platformContribution.Count)

Write-Output '[8] material groups'
$m = Invoke-RestMethod -Uri ($base + '/bosom-friend/api/material/group/list/1/10') -Headers $H
Write-Output ("code=" + $m.code + " groups=" + $m.data.total)

Write-Output '[9] agent task list persistence'
$tl = Invoke-RestMethod -Uri ($base + '/bosom-friend/api/agent/tasks') -Headers $H
Write-Output ("code=" + $tl.code + " tasks=" + $tl.data.total + " status0=" + $tl.data.list[0].status)

Write-Output '[10] note search'
$ns = Invoke-RestMethod -Uri ($base + '/bosom-friend/api/v2/statistics/note-comment-search/search') -Method Post -ContentType $J -Headers $H -Body '{"keyword":"咖啡","page":1,"pageSize":5}'
Write-Output ("code=" + $ns.code + " notes=" + $ns.data.total + " first=" + $ns.data.list[0].Title)

Write-Output '[11] user profile update'
$up = Invoke-RestMethod -Uri ($base + '/bosom-friend/api/user/info/update') -Method Put -ContentType $J -Headers $H -Body '{"name":"知音工作室"}'
Write-Output ("code=" + $up.code + " name=" + $up.data.name)

Write-Output '[12] double-slash tolerance (material/optimal)'
$opt = Invoke-RestMethod -Uri ($base + '/bosom-friend/api/material/optimal?groupId=grp-default') -Headers $H
Write-Output ("code=" + $opt.code + " data=" + ($opt.data | ConvertTo-Json -Compress).Substring(0,30))
