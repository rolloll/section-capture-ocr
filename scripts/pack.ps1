# 새 버전을 배포할 때 실행하는 스크립트.
# 사용법: src\manifest.json 의 "version"을 올린 뒤 이 스크립트를 실행하세요.
#   powershell -File scripts\pack.ps1
#
# 하는 일:
#   1) src/ 를 개인키로 서명해 새 .crx 생성
#   2) update.xml 의 codebase/version 을 새 버전으로 갱신
#   3) git commit & push (원격이 이미 설정되어 있어야 함)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$pemPath = "C:\Users\my\section-capture-ocr-signing-key\section-capture-ocr.pem"
$appId = "ighdgdopecnllkegbjmlpfcpjimgpfco"
$repo = "rolloll/section-capture-ocr"

$manifest = Get-Content "$root\src\manifest.json" -Raw | ConvertFrom-Json
$version = $manifest.version
Write-Host "패키징할 버전: $version"

# 1) 기존 .crx 산출물이 있으면 정리 후 재생성
if (Test-Path "$root\src.crx") { Remove-Item "$root\src.crx" -Force }
& $chrome --pack-extension="$root\src" --pack-extension-key="$pemPath" --no-sandbox
Start-Sleep -Seconds 2

$crxName = "section-capture-ocr-$version.crx"
Move-Item -Force "$root\src.crx" "$root\dist\$crxName"
Write-Host "생성됨: dist\$crxName"

# 2) update.xml 갱신
$updateXml = @"
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$appId'>
    <updatecheck codebase='https://raw.githubusercontent.com/$repo/main/dist/$crxName' version='$version' />
  </app>
</gupdate>
"@
Set-Content -Path "$root\update.xml" -Value $updateXml -Encoding UTF8

Write-Host "update.xml 갱신 완료. 이제 git add/commit/push 하세요:"
Write-Host "  git -C `"$root`" add -A"
Write-Host "  git -C `"$root`" commit -m `"release v$version`""
Write-Host "  git -C `"$root`" push"
