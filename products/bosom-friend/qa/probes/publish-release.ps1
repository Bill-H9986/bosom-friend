# Publish BosomFriend-Setup-<version>.exe to Bill-H9986/zhiyin.
# Reads the GitHub token from Windows Credential Manager directly (CredRead), so it never triggers
# git-credential-manager's interactive account picker - that prompt blocks an unattended build.
# -Notes: the GitHub release body. Pass the version's own summary; the previous hardcoded text
# described 0.2.58 and would have labelled a later build with someone else's changes.
param([string]$Version = '0.2.58', [string]$Notes = '')
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CredMan {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr buffer);
  public static string Read(string target) {
    IntPtr ptr;
    if (!CredReadW(target, 1, 0, out ptr)) return null;
    try {
      CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (cred.CredentialBlobSize == 0) return "";
      return Marshal.PtrToStringUni(cred.CredentialBlob, (int)(cred.CredentialBlobSize / 2));
    } finally { CredFree(ptr); }
  }
}
'@

$token = $null
foreach ($target in 'git:https://github.com', 'gh:github.com:Bill-H9986', 'gh:github.com:') {
  if ($token) { continue }
  try { $value = [CredMan]::Read($target) } catch { $value = $null }
  if ($value) { $token = $value; Write-Output ('token from credential target: ' + $target) }
}
if (-not $token) { throw 'no GitHub token in Windows Credential Manager' }
$h = @{ Authorization = ('Bearer ' + $token); 'User-Agent' = 'bosom-release' }

$exe = 'C:\Users\Jay\Desktop\Bosom friend APP\products\bosom-friend\desktop\release\' + $Version + '\BosomFriend-Setup-' + $Version + '.exe'
if (-not (Test-Path $exe)) { throw ('missing installer: ' + $exe) }
$size = (Get-Item $exe).Length
Write-Output ('local installer bytes=' + $size)

$tag = 'v' + $Version
$rel = $null
try { $rel = Invoke-RestMethod -Uri ('https://api.github.com/repos/Bill-H9986/zhiyin/releases/tags/' + $tag) -Headers $h -TimeoutSec 30 } catch { }
if (-not $rel) {
  $publishBody = if ($Notes -ne '') { $Notes } else { 'Bosom Friend ' + $Version + ' - see qa/reports/release-' + $Version + '-*.md in the source repository for the full verification record.' }
  $payload = @{ tag_name = $tag; target_commitish = 'master'; name = ('Bosom Friend ' + $Version); body = $publishBody; draft = $true; prerelease = $false } | ConvertTo-Json
  $rel = Invoke-RestMethod -Method Post -Uri 'https://api.github.com/repos/Bill-H9986/zhiyin/releases' -Headers $h -Body $payload -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
  Write-Output ('created release id=' + $rel.id + ' draft=true')
} else { Write-Output ('release exists id=' + $rel.id + ' draft=' + $rel.draft) }

$name = 'BosomFriend-Setup-' + $Version + '.exe'
$exist = $rel.assets | Where-Object { $_.name -eq $name }
if ($exist -and $exist.size -eq $size) {
  Write-Output ('asset already present with same size, skip upload: ' + $name)
} else {
  if ($exist) {
    Invoke-RestMethod -Method Delete -Uri ('https://api.github.com/repos/Bill-H9986/zhiyin/releases/assets/' + $exist.id) -Headers $h -TimeoutSec 30 | Out-Null
    Write-Output 'deleted stale asset with different size'
  }
  $ok = $false
  for ($attempt = 1; $attempt -le 3 -and -not $ok; $attempt++) {
    Write-Output ('upload attempt ' + $attempt + ' (' + [math]::Round($size/1MB,1) + ' MB)')
    $uploadUrl = 'https://uploads.github.com/repos/Bill-H9986/zhiyin/releases/' + $rel.id + '/assets?name=' + [uri]::EscapeDataString($name)
    & curl.exe -sS -X POST -H ('Authorization: Bearer ' + $token) -H 'Content-Type: application/octet-stream' --data-binary ('@' + $exe) $uploadUrl | Out-Null
    if ($LASTEXITCODE -eq 0) { $ok = $true } else { Start-Sleep -Seconds 10 }
  }
  if (-not $ok) { throw ('asset upload failed: ' + $name) }
  Write-Output ('uploaded: ' + $name)
}

Invoke-RestMethod -Method Patch -Uri ('https://api.github.com/repos/Bill-H9986/zhiyin/releases/' + $rel.id) -Headers $h -Body (@{ draft = $false } | ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 30 | Out-Null
Write-Output 'RELEASE_PUBLISHED'
