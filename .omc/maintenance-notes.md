
## 2026-07-26 (Drive 공유 드라이브 전환 후 점검)

대규모 변경(Drive 저장소 이전·홈페이지 도메인/라이트모드/디스코그래피 645건) 직후 전체 점검.

**고친 것**
- `render.yaml`·`.env.example`에 신규 3종 누락 — GOOGLE_SA_KEY, DRIVE_ERP_DRIVE_ID,
  DRIVE_ERP_ROOT_FOLDER_ID. 블루프린트로 서비스를 재생성하면 Drive 설정이 통째로 빠진 채
  **조용히 로컬 디스크 저장**으로 떨어질 수 있었다(오프사이트 백업 소실).
- 설정 화면이 Drive(서비스 계정)와 구글 OAuth(메일·캘린더·연락처)를 한 축으로 표시.
  배지·경고를 둘로 분리하고, Drive 섹션 재작성 때 사라졌던 연동 계정 표시를 되살림.
- (직전) 청구 탭 500 — SQL이 안 쓰는 명명 파라미터. 원인은 테스트(better-sqlite3)와
  운영(node:sqlite) 드라이버 불일치. `DB_DRIVER` 강제 옵션 + 운영 폴백 경고 추가.
- (직전) Render 빌드 캐시에 better-sqlite3 누락이 굳어 있던 것 — 캐시 비워 복구.

**검증 클린**
- 테스트 681개 × 두 드라이버 모두 통과 / 홈페이지 빌드 통과
- 오늘 커밋 전체 시크릿 스캔 0건, 추적 파일에 시크릿 없음
- 공개 라우트 통제: 임의 fileId 404, 미인증 업로드·콘텐츠수정 401
- Drive 권한 격리: 각 서비스 계정이 상대 폴더·드라이브 루트 모두 404
- 저장소 3곳 origin 동기화, 미커밋 0

**남은 것(기능 작업 — 메인터넌스 대상 아님)**
- ERP 백업 1회 수동 실행 검증, 옛 공유 드라이브 2개 삭제,
  Admin 콘솔에서 omg-studios 외부 공유 차단(주민등록증 사본 보관)
- `drive.js`가 외부 미사용 export 몇 개를 노출(driveClient·ensureFolder 등).
  동작 무해, 다음 사이클에 정리 여부 판단.

**다음 사이클 참고**: 배포 전 `DB_DRIVER=node:sqlite npm test`를 반드시 한 번 태울 것.

## 2026-06-29 (자동 메인터넌스)
- **변경 없음**. 적대적 점검 결과 명확·저위험 개선 없음.
- 검증 클린: 변이 라우트 권한 게이트(전부 requireX/router.use/tokenGate), CSP(인라인 핸들러·스크립트 0),
  아이콘버튼 aria-label, esc 누락(플래그 전부 false positive: 렌더 시 esc / 캘린더 텍스트 / 정수·시간상수), 모바일 16px(CSS 미디어쿼리).
- 이미 통일됨(직전 사이클): emptyState 전역, btn-sm/btn-xs 토큰, 삭제-only, 죽은 코드(listProjectServiceItems/toggleForm/serviceItemRow) 제거.
- 미해결(=기능 작업, 사용자 승인 대기, 메인터넌스 대상 아님): 거래명세서 PDF(.omc/plans/invoice-pdf-plan.md), 알림 채널.
- 다음 사이클 재점검 불필요 영역: 위 클린 항목. 신규 커밋 diff 위주로만 보면 됨.
