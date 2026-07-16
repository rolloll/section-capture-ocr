# Section Capture & OCR — 배포/자동업데이트 저장소

크롬 웹 스토어에 등록하지 않고, GitHub + Chrome 그룹 정책을 이용해
본인 소유 PC와 지인 PC에 배포하고 **실제로 자동 업데이트**되도록 구성한 저장소입니다.

## 구조

- `src/` — 확장 프로그램 소스 (manifest.json 포함)
- `dist/` — 서명된 `.crx` 배포 파일 (버전별로 누적)
- `update.xml` — Chrome이 주기적으로 확인하는 업데이트 정보 파일
- `registry/install_policy.reg` — 각 PC에 1회 적용하는 Windows 정책 파일
- `scripts/pack.ps1` — 새 버전 릴리즈용 패키징 스크립트

확장 프로그램 ID(고정): `ighdgdopecnllkegbjmlpfcpjimgpfco`

개인 서명키(`section-capture-ocr.pem`)는 **저장소에 포함하지 않고**
`C:\Users\my\section-capture-ocr-signing-key\` 에 별도 보관합니다. 이 파일을 잃어버리면
같은 확장 프로그램 ID로 다시 서명할 수 없으니 백업해두세요 (예: 개인 비밀번호 관리자, 암호화된 USB).

## 처음 설치하는 방법 (본인 PC, 지인 PC 공통)

1. 이 저장소를 클론하거나, `registry/install_policy.reg` 파일만 다운로드
2. `install_policy.reg` 더블클릭 → 관리자 권한 승인(UAC) → 정책 적용
3. Chrome을 완전히 종료 후 재실행
4. `chrome://extensions` 접속 → 우측 상단 "확장 프로그램 업데이트" 클릭
   (또는 최대 몇 시간 내 Chrome이 자동으로 설치함)
5. "관리자에 의해 설치된 확장 프로그램" 형태로 나타나며, 이후 삭제/비활성화 불가 —
   완전히 자유롭게 켜고 끄고 싶다면 이 방식 대신 "압축해제된 확장 프로그램 로드"로
   `src/` 폴더를 직접 로드하는 방법도 있음 (이 경우 자동 업데이트는 되지 않음)

## 새 버전 배포하는 방법

1. `src/` 안의 코드를 수정
2. `src/manifest.json` 의 `"version"` 을 올림 (예: `2.18.2` → `2.18.3`)
3. PowerShell에서:
   ```
   powershell -File scripts\pack.ps1
   ```
4. 안내되는 `git add/commit/push` 명령 실행
5. GitHub에 push된 후 수 분 내로 (raw.githubusercontent.com 캐시 갱신 시간)
   설치된 모든 PC의 Chrome이 자동으로 새 버전을 받아 설치함
   (즉시 반영하려면 각 PC에서 `chrome://extensions` → "업데이트" 클릭)

## 주의사항

- GitHub 저장소는 **Public**이어야 합니다 (raw.githubusercontent.com이 비공개 저장소는
  인증 없이 서비스하지 않아 자동 업데이트가 끊깁니다). 검색 노출은 없지만
  URL을 아는 사람은 접근 가능한 수준의 "비공개"입니다.
- `ExtensionInstallForcelist` 정책으로 설치된 확장 프로그램은 Chrome에서
  사용자가 직접 삭제·비활성화할 수 없습니다 (관리자 정책이 우선).
