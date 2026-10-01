# deal-check — 부동산 매매 검토·가치평가 앱

빌딩·근생상가·공장·창고·대지·나대지·농지·임야를 대상으로, 매수자 입장(최대 지불 가능 금액 WTP)과 매도자 입장(최소 수용 금액 WTA)을 동시에 산출하고 거래성사 가능 구간(ZOPA)·추천 등급·협상 논거·보고서(매수용/매도용/협상용 PDF)를 만든다.

- 앱: https://yjjn2005.github.io/deal-check/ (GitHub Pages, 정적)
- API: Cloudflare Worker `deal-check-api` (`worker/`) — AI 브로셔 추출, 실거래가·토지정보·건축물대장·시장지표·법제처 조문 프록시, PIN 동기화

## 구성
| 파일 | 내용 |
|---|---|
| `index.html` | UI 셸·스타일·인쇄(A4) CSS |
| `app.js` | 7탭 UI(입력·시장/리스크·매수가치·매도/세무·ZOPA·보고서·설정), 브로셔 추출(pdf.js + 정규식, Worker AI), 보고서 생성 |
| `calc.js` | 계산 엔진(브라우저·Node 공용): NOI·환원율·WACC/NPV·DSCR·보유세·현금흐름/IRR·토지평가·사업용 판정(§168의6 일수)·양도세(현행/2028 개편안)·법인세·취득세·WTA 역산·ZOPA·등급 |
| `tests/test-calc.js` | `node tests/test-calc.js` — 30개 검증 |
| `worker/` | Cloudflare Worker 소스·wrangler 설정 |
| `.github/workflows/` | 계산 엔진 테스트, Worker 자동 배포(wrangler-action) |

## 배포
1. GitHub 저장소 `deal-check` 생성 → 이 폴더 전체 push → Settings › Pages › Deploy from branch(main, /root).
2. Cloudflare: KV 네임스페이스 2개 생성(`DEAL_CHECK_SYNC`, `DEAL_CHECK_CACHE`) → `worker/wrangler.jsonc`의 id 교체.
3. 비밀값: `wrangler secret put ANTHROPIC_API_KEY` / `DATA_GO_KR_KEY` / `ECOS_KEY` / `VWORLD_KEY` / (선택) `ALPHAVANTAGE_KEY`.
4. GitHub Secrets에 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` 등록 → `worker/**` 변경 push 시 자동 배포.
5. 앱 설정 탭에서 Worker 주소·PIN 입력.

## 법령 기준
세율·공제·배율은 `calc.js`의 `LAW` 객체(2026-10-01 법제처 국가법령정보 API 대조). 2026 세제개편안(비사업용 토지 중과 20%p·장특공제 배제, 2028-01-01 이후 양도분)은 정부안 기준으로 병기한다. 설정 탭의 법령 조회는 Worker `/law`를 통해 현행 조문 원문·시행일자를 표시한다.
