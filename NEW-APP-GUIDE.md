# 신규 앱 공공데이터 연동 표준 (유앤김 공용)

## 원칙
1. 키는 앱 코드에 넣지 않는다. 공용 Worker `deal-check-api`(= 유앤김 공용 API 서버)의 비밀값에 한 번만 등록한다.
   - `DATA_GO_KR_KEY` 공공데이터포털 서비스키 · `ECOS_KEY` 한국은행 · `VWORLD_KEY` 브이월드 · `ANTHROPIC_API_KEY` · `LAW_OC`(법제처, yjjn2005)
2. 모든 앱은 `ynk-api.js` 한 줄을 불러서 쓴다. 서버에 키가 있으면 키 입력 없이 동작하고, 없으면 공용 저장소(localStorage `ynk_public_api`, yjjn2005.github.io 전체 앱 공유)에 한 번 저장된 키를 쓴다.

## 새 앱에 넣는 코드
```html
<script src="https://yjjn2005.github.io/deal-check/ynk-api.js"></script>
<script>
  // 실거래 (상업업무용 nrg / 토지 land / 공장창고 indu / 아파트 apt / 아파트 전월세 aptRent / 오피스텔 offi / 연립 rh / 단독 sh)
  const items = await YNK.rtms('nrg', '41360', '202605');
  // 공공데이터포털 어떤 API든: 서비스키 없이 URL만 주면 서버가 키를 붙임
  const xml = await YNK.dataGo('https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?sigunguCd=41360&bjdongCd=25627&platGbCd=0&bun=0020&ji=0005');
  // 브이월드: 주소 → PNU, 토지이용·공시지가·토지특성
  const parcel = await YNK.vworldSearch('남양주시 화도읍 월산리 20-5'); const lu = await YNK.vworldNed('getLandUseAttr', parcel.id);
  // 법제처 조문 원문·시행일, 한국은행 ECOS, 시장지표, PIN 동기화
  const art = await YNK.law('소득세법', '104의3'); const kr10 = await YNK.ecos('817Y002', '010210000'); const m = await YNK.stats(); await YNK.sync('1234', {saved: true});
</script>
```

## 공용 Worker 라우트 (https://deal-check-api.yjjn2005.workers.dev)
| 라우트 | 기능 |
|---|---|
| `/health` | 상태·등록된 키 여부 |
| `/data?url=` | apis.data.go.kr · api.odcloud.kr URL에 서비스키 주입 (6시간 캐시) |
| `/rtms?lawd=&kind=&ym=` | 실거래 정규화 JSON |
| `/bldg?pnu=` | 건축물대장 표제부 |
| `/landuse?address=` | 브이월드 PNU·용도지역·공시지가 (서버 키) |
| `/ecos?code=&item=&period=` | 한국은행 ECOS |
| `/stats` | 국고채·기준금리·환율·미국채 |
| `/law?name=&art=` | 법제처 현행 조문 원문·시행일 |
| `/sync/:pin` | KV 동기화 (앱별로 PIN 앞에 앱 이름을 붙여 분리: `dealcheck-1234`) |
| `/extract` | Claude 브로셔·문서 추출 |

허용 출처: `https://yjjn2005.github.io` (wrangler.jsonc `ALLOWED_ORIGIN`). 새 도메인을 쓰면 추가한다.

## 키 등록 (한 번만)
Cloudflare 대시보드 → Workers & Pages → deal-check-api → Settings → Variables and Secrets → Add: `DATA_GO_KR_KEY`(Decoding 키 원문) 등.
또는 `cd worker && npx wrangler secret put DATA_GO_KR_KEY`.
