/* deal-check 앱 UI (바닐라 JS) — 상태·렌더·브로셔 추출·API 연동·보고서 */
(function () {
  'use strict';
  const C = window.DealCalc;
  const $ = s => document.querySelector(s);
  const LS = 'dealcheck.v1';

  // ---------- 기본값·시장 데이터 (2026-09-30 기준, Worker /stats로 갱신) ----------
  const MARKET_DEFAULT = { asOf: '2026-09-30', baseRate: 0.03, riskFree: 0.04407, kr3y: 0.04011, us10y: 0.05285, us2y: 0.04922, kr2y: 0.03978, usdkrw: 1352.8, loanRateAvg: 0.0430, mortgage: 0.0466, deposit: 0.0321, vacancyOffice: 0.09, vacancyRetail: 0.143, vacancySmall: 0.085, vacancyLogis: 0.155, marketCap: 0.040, source: '한국은행·한국부동산원·JLL 보도(기초조사 보고서)' };
  const RISK_TEMPLATES = {
    common: [
      { key: 'registry', label: '등기부 — 근저당·가압류·가처분·지상권', hint: '채권최고액 합계 vs 호가, 신탁·공유 지분', law: '부동산등기법' },
      { key: 'landuse', label: '토지이용계획 — 용도지역·지구·구역', hint: '건폐율·용적률 상한, 개발행위 제한, 토지거래허가구역', law: '국토계획법 §36·§76·§77' },
      { key: 'road', label: '도로 접면 (맹지 여부)', hint: '폭 4m 이상 도로에 2m 이상 접함', law: '건축법 §44' },
      { key: 'access', label: '진입·연결허가 (구거점용·도로연결)', hint: '국유 구거 점용, 국도·지방도 연결허가 제한거리', law: '도로법 §52, 공유수면법' }
    ],
    income: [
      { key: 'bldg', label: '건축물대장 — 위반건축물·면적 일치', hint: '위반 시 원상복구비·이행강제금 감산', law: '건축법 §79·§80' },
      { key: 'use', label: '주용도·임차 업종 적합', hint: '근생 1·2종, 업무, 공장 용도변경 가능성', law: '건축법 §19' },
      { key: 'lease', label: '임차인 — 상가임대차보호법', hint: '환산보증금 기준 내 갱신요구 10년·증액 5%', law: '상가임대차보호법 §2·§10·§11' },
      { key: 'age', label: '노후도·설비 (승강기·주차·누수)', hint: '자본적 지출 예비비', law: '' }
    ],
    land: [
      { key: 'zone', label: '규제 레이어 — 농업진흥구역·보전산지·개발제한', hint: '전용 가능성, 건축 가능성', law: '농지법 §28, 산지관리법 §4' },
      { key: 'farmsurvey', label: '농지 전수조사·농취증', hint: '위반 의심(임대·휴경), 농지취득자격증명 발급 가능성', law: '농지법 §8·§10·§63' },
      { key: 'slope', label: '경사도·입목축적·분묘 (임야)', hint: '산지전용허가 기준', law: '산지관리법 §18' },
      { key: 'share', label: '공동소유·종중·국유지 접속', hint: '지분 거래 제약', law: '' }
    ]
  };
  const NAV = [
    ['input', '1', '입력', '브로셔·렌트롤·희망가'], ['market', '2', '시장·리스크', '실거래·법률·행정'], ['buy', '3', '매수 가치', '5단 검증 · WTP'],
    ['sell', '4', '매도·세무', '세후 역산 · WTA'], ['zopa', '5', 'ZOPA·결정', '성사 구간 · 등급'], ['report', '6', '보고서', '출력 구조'], ['settings', '7', '설정', '동기화 · 기본값 · 법령']
  ];

  // ---------- 상태 ----------
  const state = { tab: 'input', side: 'buy', cases: [], current: null, settings: { workerUrl: 'https://deal-check-api.yjjn2005.workers.dev', proxyUrl: 'https://ynk-data-proxy.yjjn2005.workers.dev', landApi: 'https://land-check-api.yjjn2005.workers.dev', dataKey: '', vworldKey: 'F6799A65-7960-4D2E-AA41-1BACB4EAEB1D', pin: '', premium: { income: 0.020, retail: 0.025, land: 0.015 }, equityPremium: 0.036, opexRatio: 0.20, zopaWeight: 0.4, dscrMin: 1.2, author: '유앤김패밀리' }, lawCache: {}, rtmsStatus: '' };

  function newCase(sample) {
    const c = { id: 'c' + Date.now(), name: '새 물건', type: 'retail', address: '', pnu: '', lawd: '', zone: '', landArea: 0, gfa: 0, builtYear: '', floors: '', parking: '', elevator: '',
      rentroll: [], ask: 0, sellerHope: 0, buyerHope: 0, ltv: 0.5, loanRate: 0.044, growth: 0.02, vacancy: 0.05, opexRatio: 0.20, depositYield: 0.03, buyerType: 'indiv', bigCity: false, interestOnly: true,
      landPublic: 0, buildingStd: 0, publicPricePerSqm: 0, far: 0, bcr: 0, devUnitPrice: 0, landGrowth: 0.02, willConvert: false, farmSelf2y: false,
      comps: [], risks: [], seller: { ownerType: 'indiv', acquired: '', acquiredPrice: 0, expenses: 0, targetNet: 0, transfer: '', bizPeriods: [], share: 1, sellCostRate: 0.009, vat: 0 },
      market: Object.assign({}, MARKET_DEFAULT), notes: '', extracted: null, created: new Date().toISOString() };
    initRisks(c);
    if (sample) Object.assign(c, sample);
    return c;
  }
  function initRisks(c) {
    const t = C.TYPES[c.type] || C.TYPES.retail;
    const tpl = RISK_TEMPLATES.common.concat(t.income ? RISK_TEMPLATES.income : RISK_TEMPLATES.land);
    const old = Object.fromEntries((c.risks || []).map(r => [r.key, r]));
    c.risks = tpl.map(r => Object.assign({ status: 'na', deduct: 0, rate: 0, memo: '' }, r, old[r.key] ? { status: old[r.key].status, deduct: old[r.key].deduct, rate: old[r.key].rate, memo: old[r.key].memo } : {}));
  }
  function wulsanCase() {
    const c = newCase({ name: '월산리 20-5 (나대지·노외주차장)', type: 'vacant', address: '경기도 남양주시 화도읍 월산리 20-5', pnu: '4136025627100200005', lawd: '41360', zone: '제1종일반주거지역', jimok: '대', landArea: 1040, publicPricePerSqm: 1132000, landPublic: 1132000 * 1040, priceYear: '2026', far: 2.0, bcr: 0.6,
      ask: 0, sellerHope: 0, buyerHope: 0, landGrowth: 0.02, holdYearsPlan: 5, rtmsMonths: 12, zoneFilter: '', dongFilter: '월산리, 답내리',
      seller: { ownerType: 'indiv', acquired: '', acquiredPrice: 0, expenses: 0, targetNet: 0, transfer: '2026-12-15', bizPeriods: [{ from: '2017-08-01', to: '2099-12-31', type: '노외주차장(주차장운영업)' }], share: 1, sellCostRate: 0.009, vat: 0 },
      notes: '브이월드 2026 토지특성: 지목 대, 1,040㎡, 제1종일반주거지역, 주상용, 광대로한면, 사다리형, 개별공시지가 ₩1,132,000/㎡(2026). 토지이용: 지구단위계획구역·토지거래계약허가구역·자연보전권역·수질보전특별대책지역·배출시설설치제한지역. 현황 노외주차장(대현로지스 임대).' });
    c.risks.forEach(r => {
      if (r.key === 'landuse') { r.status = 'warn'; r.memo = '제1종일반주거(건폐율 60%·용적률 200% 상한) · 지구단위계획구역 · 토지거래계약허가구역(허가 필요) · 자연보전권역·수질보전특별대책지역'; }
      if (r.key === 'road') { r.status = 'ok'; r.memo = '광대로한면 접도 · 사다리형 · 평지'; }
      if (r.key === 'zone') { r.status = 'warn'; r.memo = '지구단위계획구역 — 계획 내용(용도·높이·건축선) 확인 필요 · 자연보전권역(수도권정비계획법) 규모 제한'; }
      if (r.key === 'farmsurvey') { r.status = 'na'; r.memo = '지목 대 — 해당 없음'; }
      if (r.key === 'share') { r.status = 'ok'; r.memo = '단독 소유 전제(등기부 확인)'; }
      if (r.key === 'registry') { r.status = 'na'; r.memo = '등기부 업로드·확인'; }
      if (r.key === 'access') { r.status = 'ok'; r.memo = '광대로 직접 접함 — 점용허가 불필요'; }
    });
    return c;
  }
  function sampleCase() {
    const c = newCase({ name: '월산리 근생빌딩 (예시)', type: 'retail', address: '경기도 남양주시 화도읍 월산리 20-5', pnu: '4136025627100200005', lawd: '41360', zone: '제1종일반주거지역', landArea: 495, gfa: 1180.4, builtYear: '2009', floors: '지상 5층', parking: '8대', elevator: '1대',
      rentroll: [{ floor: '1층', tenant: '카페', deposit: 80000000, rent: 6000000, mgmt: 300000, expiry: '2027-06', vacant: false }, { floor: '2층', tenant: '치과', deposit: 60000000, rent: 4500000, mgmt: 250000, expiry: '2028-02', vacant: false }, { floor: '3층', tenant: '학원', deposit: 40000000, rent: 3000000, mgmt: 200000, expiry: '2026-12', vacant: false }, { floor: '4층', tenant: '공실', deposit: 0, rent: 2500000, mgmt: 0, expiry: '', vacant: true }, { floor: '5층', tenant: '사무실', deposit: 20000000, rent: 1500000, mgmt: 150000, expiry: '2027-09', vacant: false }],
      ask: 5000000000, sellerHope: 4200000000, buyerHope: 3000000000, landPublic: 2000000000, buildingStd: 600000000, publicPricePerSqm: 4040000,
      comps: [{ addr: '월산리 1**', use: true, type: '근생·1종일주', area: 412, price: 2950000000, pricePerSqm: 7160000, date: '2026-05' }, { addr: '월산리 3**', use: true, type: '근생·1종일주', area: 520, price: 3600000000, pricePerSqm: 6923000, date: '2026-02' }, { addr: '묵현리 2**', use: false, type: '업무·준주거', area: 610, price: 5800000000, pricePerSqm: 9508000, date: '2025-11' }, { addr: '월산리 5**', use: true, type: '근생·1종일주', area: 380, price: 2650000000, pricePerSqm: 6974000, date: '2025-09' }],
      seller: { ownerType: 'indiv', acquired: '2011-06-01', acquiredPrice: 2100000000, expenses: 90000000, targetNet: 600000000, transfer: '2026-12-15', bizPeriods: [{ from: '2011-06-01', to: '2099-12-31' }], share: 1, sellCostRate: 0.009, vat: 0 }, notes: '첫 화면 가상 예시 — 새 물건 입력 또는 브로셔 분석부터 사용' });
    c.risks.forEach(r => { if (r.key === 'registry') { r.status = 'ok'; r.memo = '채권최고액 ₩18억(호가 36%), 가압류 없음'; } if (r.key === 'bldg') { r.status = 'bad'; r.deduct = 38000000; r.memo = '4층 옥외 테라스 무단증축 12㎡'; } if (r.key === 'road') { r.status = 'ok'; r.memo = '폭 6m 시도 12m 접함'; } if (r.key === 'landuse') { r.status = 'ok'; r.memo = '1종일주 · 건폐율 60% · 용적률 200%'; } if (r.key === 'lease') { r.status = 'warn'; r.deduct = 24000000; r.memo = '3층 만료 임박, 4층 공실 해소비'; } });
    return c;
  }

  // ---------- 저장 ----------
  function save() { try { localStorage.setItem(LS, JSON.stringify({ cases: state.cases, currentId: state.current && state.current.id, settings: state.settings, side: state.side })); } catch (e) { } }
  function load() {
    try { const sh = JSON.parse(localStorage.getItem('ynk_public_api') || '{}'); ['workerUrl', 'proxyUrl', 'landApi', 'dataKey', 'vworldKey'].forEach(k => { if (sh[k]) state.settings[k] = sh[k]; }); } catch (e) { }
    try { const d = JSON.parse(localStorage.getItem(LS) || 'null'); if (d) { state.cases = d.cases || []; state.settings = Object.assign(state.settings, d.settings || {}); state.side = d.side || 'buy'; state.current = state.cases.find(c => c.id === d.currentId) || state.cases[0] || null; } } catch (e) { }
    if (!state.settings.zoneAllMig) { state.cases.forEach(x => { x.zoneFilter = ''; }); state.settings.zoneAllMig = true; }
    if (!state.settings.dongMig) { state.cases.forEach(x => { if (x.dongFilter == null && /월산리|답내리/.test(x.address || '')) x.dongFilter = '월산리, 답내리'; }); state.settings.dongMig = true; }
    if (!state.current) { state.current = wulsanCase(); state.cases = [state.current, sampleCase()]; }
    state.cases.forEach(c => { if (!c.market) c.market = Object.assign({}, MARKET_DEFAULT); if (!c.seller) c.seller = newCase().seller; initRisks(c); });
  }

  // ---------- 포맷 ----------
  const fmt = n => n == null || isNaN(n) ? '—' : '₩' + Math.round(n).toLocaleString('ko-KR');
  const eok = n => n == null || isNaN(n) ? '—' : (Math.abs(n) >= 1e8 ? '₩' + (n / 1e8).toFixed(n >= 1e10 ? 0 : 1) + '억' : fmt(n));
  const pct = (x, d) => x == null || isNaN(x) ? '—' : (x * 100).toFixed(d == null ? 2 : d) + '%';
  const pp = (x, d) => x == null || isNaN(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d == null ? 1 : d) + '%p';
  const num = v => { const n = parseFloat(String(v).replace(/[^\d.\-]/g, '')); return isNaN(n) ? 0 : n; };
  const money = v => { const s = String(v == null ? '' : v).replace(/,/g, '').replace(/원/g, '').trim(); if (!s) return 0; let total = 0, hit = false, rest = s;
    const take = (re, mul) => { const m = rest.match(re); if (m) { total += parseFloat(m[1]) * mul; hit = true; rest = rest.replace(m[0], ' '); } };
    take(/([\d.]+)\s*억/, 1e8); take(/([\d.]+)\s*천\s*만/, 1e7); take(/([\d.]+)\s*백\s*만/, 1e6); take(/([\d.]+)\s*만/, 1e4); take(/([\d.]+)\s*천(?!\s*만)/, /억/.test(s) ? 1e7 : 1e3);
    if (hit) { const tail = rest.replace(/[^\d.]/g, ''); if (tail && /억/.test(s) && !/만|천|백/.test(s.replace(/.*억/, ''))) total += parseFloat(tail) * 1e4; /* 7억 3000 → 7억3000만 (뒤 숫자 누락 방지) */ return Math.round(total); } const n = parseFloat(s.replace(/[^\d.\-]/g, '')); if (isNaN(n)) return 0; return Math.round(n); };
  const moneyEok = v => { const s = String(v == null ? '' : v).trim(); if (/^[\d.,]+$/.test(s)) { const n = parseFloat(s.replace(/,/g, '')); if (n > 0 && n < 100000) return Math.round(n * 1e8); } return money(v); }; // 가격 필드: 숫자만 10만 미만이면 억 단위 (예: 117 → 117억)
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const pill = (t, k) => `<span class="pill ${k}">${esc(t)}</span>`;
  const statusPill = s => ({ ok: pill('통과', 'ok'), warn: pill('주의', 'warn'), bad: pill('위험', 'bad'), na: pill('미확인', 'na') }[s] || '');
  function toast(m) { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2600); }

  // ---------- 평가 ----------
  function caseInput() {
    const c = state.current; const t = C.TYPES[c.type];
    const prem = t.land ? state.settings.premium.land : (c.type === 'retail' || c.type === 'warehouse' || c.type === 'factory' ? state.settings.premium.retail : state.settings.premium.income);
    return Object.assign({}, c, { premium: c.premium || prem, equityPremium: state.settings.equityPremium, zopaWeight: state.settings.zopaWeight, opexRatio: c.opexRatio ?? state.settings.opexRatio });
  }
  function evaluate() { try { return C.evaluate(caseInput()); } catch (e) { console.error(e); return null; } }

  // ---------- 렌더 공통 ----------
  function field(label, key, val, type, opts) {
    type = type || 'text';
    if (type === 'select') return `<div class="field"><label>${label}</label><select data-k="${key}">${opts.map(o => `<option value="${o[0]}" ${String(o[0]) === String(val) ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></div>`;
    if (type === 'money' || type === 'eok') return `<div class="field"><label>${label}</label><input data-k="${key}" data-t="money" ${type === 'eok' ? 'data-eok="1"' : ''} value="${val ? Math.round(val).toLocaleString('ko-KR') : ''}" inputmode="text" placeholder="${type === 'eok' ? '예: 117 또는 117억' : '예: 1,500만 / 15,000,000'}"></div>`;
    if (type === 'pct') return `<div class="field"><label>${label}</label><input data-k="${key}" data-t="pct" value="${val != null ? (val * 100).toFixed(2) : ''}" inputmode="decimal"></div>`;
    if (type === 'num') return `<div class="field"><label>${label}</label><input data-k="${key}" data-t="num" value="${val ?? ''}" inputmode="decimal"></div>`;
    if (type === 'date') return `<div class="field"><label>${label}</label><input data-k="${key}" data-t="date" type="date" value="${val || ''}"></div>`;
    if (type === 'check') return `<div class="field"><label>${label}</label><select data-k="${key}" data-t="bool"><option value="0" ${!val ? 'selected' : ''}>아니오</option><option value="1" ${val ? 'selected' : ''}>예</option></select></div>`;
    return `<div class="field"><label>${label}</label><input data-k="${key}" value="${esc(val)}"></div>`;
  }
  function setPath(obj, path, v) { const ks = path.split('.'); let o = obj; for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null) o[ks[i]] = {}; o = o[ks[i]]; } o[ks[ks.length - 1]] = v; }
  function getPath(obj, path) { return path.split('.').reduce((o, k) => o == null ? undefined : o[k], obj); }
  function bindInputs(root, target, after) {
    root.querySelectorAll('[data-k]').forEach(el => {
      el.addEventListener('change', () => {
        let v = el.value; const t = el.dataset.t;
        if (t === 'money') v = el.dataset.eok ? moneyEok(v) : money(v); else if (t === 'num') v = num(v); else if (t === 'pct') v = num(v) / 100; else if (t === 'bool') v = v === '1';
        setPath(target, el.dataset.k, v); if (t === 'money') el.value = v ? Math.round(v).toLocaleString('ko-KR') : '';
        save(); if (after) after(el.dataset.k);
      });
    });
  }

  function recentHighPrice(c) {
    const t = C.TYPES[c.type] || C.TYPES.retail; const subj = t.land ? (c.landArea || 0) : (c.saleScope === 'part' ? (c.exclusiveArea || 0) : (c.landArea || 0));
    const used = (c.comps || []).filter(x => x.use !== false && x.price > 0 && !/도로|구거|하천/.test(x.type || '') && (!subj || ((t.income && c.saleScope === 'part' ? (x.bldgArea || x.area) : x.area) >= Math.max(30, subj * 0.1)))); if (!used.length) return null;
    if (t.income && c.saleScope === 'part' && c.exclusiveArea) { const u = used.filter(x => x.pricePerSqmBldg > 0); if (!u.length) return null; const top = u.reduce((m, x) => x.pricePerSqmBldg > m.pricePerSqmBldg ? x : m, u[0]); return { price: Math.round(top.pricePerSqmBldg * c.exclusiveArea), unit: top.pricePerSqmBldg, area: c.exclusiveArea, basis: `최근 거래 최고 전용단가 ${fmt(top.pricePerSqmBldg)}/㎡ = 평당 ${fmt(top.pricePerSqmBldg * 3.3058)} (${top.addr} ${top.date}) × 전용 ${c.exclusiveArea}㎡ (${(c.exclusiveArea / 3.3058).toFixed(1)}평)`, ref: top }; }
    const area = c.landArea || 0; if (!area) return null; const u = used.filter(x => x.pricePerSqm > 0); if (!u.length) return null; const top = u.reduce((m, x) => x.pricePerSqm > m.pricePerSqm ? x : m, u[0]);
    return { price: Math.round(top.pricePerSqm * area), unit: top.pricePerSqm, area, basis: `최근 거래 최고 토지단가 ${fmt(top.pricePerSqm)}/㎡ = 평당 ${fmt(top.pricePerSqm * 3.3058)} (${top.addr} ${top.date}) × 대지 ${area}㎡ (${(area / 3.3058).toFixed(1)}평)`, ref: top };
  }
  function applyPriceDefaults(c, force) {
    const h = recentHighPrice(c); let changed = false;
    if ((force === 'ask' || !c.ask) && h) { c.ask = h.price; c.askBasis = h.basis; c.askAuto = true; c.unitPriceSqm = Math.round(h.unit); c.unitPricePyeong = Math.round(h.unit * 3.3058); changed = true; }
    if ((force === 'hope' || !c.sellerHope) && c.ask) { c.sellerHope = Math.round(c.ask * (1 + (state.settings.hopeMarkup ?? 0.20))); c.sellerHopeAuto = true; changed = true; }
    if (!c.buyerHope && c.ask) { c.buyerHope = Math.round(c.ask * 0.9); c.buyerHopeAuto = true; changed = true; }
    return changed;
  }
  function kpi(l, v, n, cls) { return `<div class="kpi ${cls || ''}"><div class="l">${l}</div><div class="v">${v}</div><div class="n">${n || ''}</div></div>`; }
  function hero(k, v, d) { return `<section class="hero"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></section>`; }
  function card(h, body, r) { return `<section class="card">${h ? `<h3>${h}${r ? `<span class="r">${r}</span>` : ''}</h3>` : ''}${body}</section>`; }

  // ---------- 탭: 입력 ----------
  function renderInput() {
    const c = state.current; const t = C.TYPES[c.type];
    const types = Object.entries(C.TYPES).map(([k, v]) => `<button class="btn chip ${c.type === k ? 'on' : ''}" onclick="App.setType('${k}')">${v.label}</button>`).join('');
    const rr = c.rentroll.map((r, i) => `<tr><td><input data-rr="${i}.floor" value="${esc(r.floor)}"></td><td><input data-rr="${i}.tenant" value="${esc(r.tenant)}"></td><td><input data-rr="${i}.deposit" data-t="money" value="${r.deposit ? r.deposit.toLocaleString() : ''}"></td><td><input data-rr="${i}.rent" data-t="money" value="${r.rent ? r.rent.toLocaleString() : ''}"></td><td><input data-rr="${i}.mgmt" data-t="money" value="${r.mgmt ? r.mgmt.toLocaleString() : ''}"></td><td><input data-rr="${i}.expiry" value="${esc(r.expiry)}" placeholder="YYYY-MM"></td><td><select data-rr="${i}.vacant" data-t="bool"><option value="0" ${!r.vacant ? 'selected' : ''}>임대중</option><option value="1" ${r.vacant ? 'selected' : ''}>공실</option></select></td><td><button class="btn sm" onclick="App.delRent(${i})">삭제</button></td></tr>`).join('');
    const n = t.income ? C.noi(caseInput()) : null;
    const ex = c.extracted ? `<div class="muted" style="margin-top:10px">${pill('추출 완료 · ' + (c.extracted.source || 'PDF 텍스트'), 'ok')} ${esc(c.extracted.file || '')} · 누락: ${esc((c.extracted.missing || []).join(', ') || '없음')}</div>` : '';
    const html = `
<div class="grid g3">
${card('매도 브로셔', `<div class="drop" id="drop"><div class="ic">${svg('upload')}</div><div style="font-weight:500">PDF·이미지를 끌어다 놓거나 선택</div><div class="muted">텍스트 PDF는 브라우저에서 즉시 추출, 스캔·이미지는 Worker AI 추출(설정에서 서버 주소 확인)</div><label class="btn" for="brochure" style="margin-top:6px">파일 선택</label><input id="brochure" type="file" accept="application/pdf,image/*" style="display:none"></div>${ex}
<div class="field" style="margin-top:12px"><label>또는 브로셔 텍스트 붙여넣기</label><textarea id="paste" rows="3" placeholder="주소, 면적, 임대료, 매매가가 포함된 텍스트"></textarea></div><div style="display:flex;gap:8px;margin-top:8px"><button class="btn sm" onclick="App.extractPaste()">텍스트 분석</button><button class="btn sm" onclick="App.extractAI()">AI 정밀 추출(Worker)</button></div>`)}
${card('물건 유형 · 기본 정보', `<div class="tabs" style="margin-bottom:12px">${types}</div><div class="fgrid g2" id="basic">
${field('케이스 이름', 'name', c.name)}${field('소재지(지번)', 'address', c.address)}${field('PNU', 'pnu', c.pnu)}${field('시군구코드(LAWD_CD)', 'lawd', c.lawd)}${field('용도지역', 'zone', c.zone)}${field('대지면적(㎡)', 'landArea', c.landArea, 'num')}
${t.income ? field('연면적(㎡)', 'gfa', c.gfa, 'num') + field('매각 범위', 'saleScope', c.saleScope || 'whole', 'select', [['whole', '건물 전체(토지 포함)'], ['part', '일부 층·구분소유(집합)']]) + field('매각(전용)면적 ㎡ — 구분소유 시', 'exclusiveArea', c.exclusiveArea, 'num') + field('시장 임대료 ₩/㎡·월 (렌트롤 없을 때 추정)', 'marketRentPerSqm', c.marketRentPerSqm, 'money') + field('일괄매각 규모 할인 (소규모 구분상가 단가 대비)', 'bulkDiscount', c.bulkDiscount ?? 0.30, 'pct') + field('준공연도', 'builtYear', c.builtYear) + field('층수', 'floors', c.floors) + field('주차', 'parking', c.parking) + field('승강기', 'elevator', c.elevator) + field('개별공시지가(₩/㎡)', 'publicPricePerSqm', c.publicPricePerSqm, 'money') + field('주용도', 'mainUse', c.mainUse) : field('개별공시지가(₩/㎡)', 'publicPricePerSqm', c.publicPricePerSqm, 'money') + field('법정 용적률(%)', 'far', c.far ? c.far * 100 : '', 'num') + field('인근 분양·대지 단가(₩/㎡, 개발가치용)', 'devUnitPrice', c.devUnitPrice, 'money') + field('전용 후 사용 예정', 'willConvert', c.willConvert, 'check')}
</div><div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn sm primary" onclick="App.autoCollect()">주소로 자동 수집 (토지정보·건축물대장·실거래)</button><button class="btn sm" onclick="App.lookupLand()">토지정보만</button>${t.income ? '<button class="btn sm" onclick="App.fetchBldg()">건축물대장만</button>' : ''}</div>`)}
<div style="grid-column:1/-1">${parcelCard(c)}</div>
${card('가격 · 금융', `<div class="fgrid g2" id="price">
${field('매도 호가 (억 단위 입력 가능)', 'ask', c.ask, 'eok')}${field('매도 희망가 (기본: 호가 +' + Math.round((state.settings.hopeMarkup ?? 0.2) * 100) + '%)', 'sellerHope', c.sellerHope, 'eok')}${field('매수 희망가 (기본: 호가 −10%)', 'buyerHope', c.buyerHope, 'eok')}${field('매수 주체', 'buyerType', c.buyerType, 'select', [['indiv', '개인'], ['corp', '법인']])}
${field('대출 비율 LTV', 'ltv', c.ltv, 'pct')}${field('적용 금리', 'loanRate', c.loanRate, 'pct')}${field('상환 방식', 'interestOnly', c.interestOnly, 'select', [[true, '이자만 상환'], [false, '원리금균등 20년']])}${field('수도권 대도시 법인 중과', 'bigCity', c.bigCity, 'check')}
${t.income ? field('NOI 성장률(연)', 'growth', c.growth, 'pct') + field('공실률 가정', 'vacancy', c.vacancy, 'pct') + field('운영경비율(GPI 대비)', 'opexRatio', c.opexRatio, 'pct') + field('보증금 운용수익률', 'depositYield', c.depositYield, 'pct') + field('토지 공시지가 총액(보유세)', 'landPublic', c.landPublic, 'money') + field('건물 시가표준액(보유세)', 'buildingStd', c.buildingStd, 'money') : field('지가 상승률 가정(연)', 'landGrowth', c.landGrowth, 'pct') + field('보유 계획(년)', 'holdYearsPlan', c.holdYearsPlan || 5, 'num') + field('2년 이상 자경 농업인(취득세 1.5%)', 'farmSelf2y', c.farmSelf2y, 'check')}
</div>
<div style="margin-top:12px;padding:10px 12px;background:var(--ivory);border-radius:8px">
<div style="font-size:12px;font-weight:700;color:var(--navy);margin-bottom:6px">호가 계산 — 단가 × 면적</div>
<div class="fgrid g3">
${field('기준 면적', 'askAreaBasis', c.askAreaBasis || (t.income && c.saleScope === 'part' ? 'excl' : 'land'), 'select', [['land', '대지면적 ' + (c.landArea || 0) + '㎡ (' + ((c.landArea || 0) / 3.3058).toFixed(1) + '평)'], ['excl', '전용·매각면적 ' + (c.exclusiveArea || 0) + '㎡ (' + ((c.exclusiveArea || 0) / 3.3058).toFixed(1) + '평)'], ['gfa', '연면적 ' + (c.gfa || 0) + '㎡ (' + ((c.gfa || 0) / 3.3058).toFixed(1) + '평)']])}
${field('실거래 평당가 (₩/평)', 'unitPricePyeong', c.unitPricePyeong, 'money')}
${field('실거래 ㎡당가 (₩/㎡)', 'unitPriceSqm', c.unitPriceSqm, 'money')}
</div>
<div class="muted" style="margin-top:6px">${(() => { const ar = (c.askAreaBasis || (t.income && c.saleScope === 'part' ? 'excl' : 'land')) === 'excl' ? c.exclusiveArea : (c.askAreaBasis === 'gfa' ? c.gfa : c.landArea); const py = (ar || 0) / 3.3058; const u = c.unitPriceSqm || (c.unitPricePyeong ? c.unitPricePyeong / 3.3058 : 0); const upy = c.unitPricePyeong || u * 3.3058; return u && ar ? `호가 = ${fmt(upy)}/평 × ${py.toFixed(1)}평 = ${fmt(u)}/㎡ × ${ar}㎡ = <b>${fmt(u * ar)}</b>` : '평당가 또는 ㎡당가를 넣으면 호가가 계산됩니다 (둘 중 하나 입력 시 다른 쪽 자동 환산)'; })()}</div>
<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn sm primary" onclick="App.setAskFromUnit()">이 단가로 호가 적용</button><button class="btn sm" onclick="App.setAskFromComps()">호가 = 최근 거래 최고가</button><button class="btn sm" onclick="App.setHopeFromAsk()">희망가 = 호가 +${Math.round((state.settings.hopeMarkup ?? 0.2) * 100)}%</button></div></div><div class="muted" style="margin-top:6px">${c.askBasis ? (c.askAuto ? '호가 자동: ' : '호가 산식: ') + esc(c.askBasis) : '브로셔 호가가 없으면 실거래 수집 후 최근 거래 최고가(평당가 × 평수)로 자동 설정됩니다'}${c.sellerHopeAuto ? ' · 희망가 자동(호가 +' + Math.round((state.settings.hopeMarkup ?? 0.2) * 100) + '%)' : ''}</div>`)}
</div>
${t.income ? card('임대차 현황 (렌트롤)', `<table><thead><tr><th>층</th><th>임차인</th><th>보증금</th><th>월임대료</th><th>월관리비</th><th>만료</th><th>상태</th><th></th></tr></thead><tbody>${rr}</tbody>
<tfoot><tr class="total"><td colspan="2">총합계</td><td>${fmt(n.deposit)}</td><td>${fmt(n.rentY / 12)}</td><td colspan="4" class="muted">연 GPI ${fmt(n.gpi)} · NOI ${fmt(n.noi)} · 공실 ${c.rentroll.filter(r => r.vacant).length}/${c.rentroll.length}층 ${c.ask ? '· 호가 표면수익률 ' + pct(n.rentY / (c.ask - n.deposit)) : ''}</td></tr></tfoot></table>`, `<button class="btn sm" onclick="App.addRent()">+ 층 추가</button>`) : card('토지 메모', `<div class="field"><label>현황·특이사항</label><textarea data-k="notes" rows="3">${esc(c.notes)}</textarea></div>`)}
`;
    return html;
  }
  function afterInput(root) {
    bindInputs(root, state.current, k => { if (k === 'name') renderSide(); if (k === 'ask') { const c = state.current; c.askAuto = false; if (!c.sellerHope || c.sellerHopeAuto) { c.sellerHope = Math.round(c.ask * (1 + (state.settings.hopeMarkup ?? 0.2))); c.sellerHopeAuto = true; } if (!c.buyerHope || c.buyerHopeAuto) { c.buyerHope = Math.round(c.ask * 0.9); c.buyerHopeAuto = true; } save(); render(); } if (k === 'sellerHope') state.current.sellerHopeAuto = false; if (k === 'buyerHope') state.current.buyerHopeAuto = false; if (k === 'unitPricePyeong') { state.current.unitPriceSqm = Math.round(state.current.unitPricePyeong / 3.3058); save(); render(); } if (k === 'unitPriceSqm') { state.current.unitPricePyeong = Math.round(state.current.unitPriceSqm * 3.3058); save(); render(); } if (k === 'askAreaBasis') render(); });
    root.querySelectorAll('[data-pc]').forEach(el => el.addEventListener('change', () => { const [i, k] = el.dataset.pc.split('.'); const x = state.current.parcels[+i]; if (k === 'own') x.own = el.checked; else if (el.dataset.t === 'money') x[k] = money(el.value); else if (el.dataset.t === 'num') x[k] = num(el.value); else x[k] = el.value; syncParcels(state.current); save(); render(); }));
    root.querySelectorAll('[data-nb]').forEach(el => el.addEventListener('change', () => { state.nearby.items[+el.dataset.nb].sel = el.checked; }));
    root.querySelectorAll('[data-rr]').forEach(el => el.addEventListener('change', () => { const [i, k] = el.dataset.rr.split('.'); let v = el.value; if (el.dataset.t === 'money') v = money(v); if (el.dataset.t === 'bool') v = v === '1'; state.current.rentroll[+i][k] = v; save(); render(); }));
    const drop = root.querySelector('#drop'); const fi = root.querySelector('#brochure');
    if (drop) { ['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.style.background = '#efe9dc'; })); ['dragleave', 'drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.style.background = ''; })); drop.addEventListener('drop', ev => handleFile(ev.dataTransfer.files[0])); fi.addEventListener('change', () => handleFile(fi.files[0])); }
  }

  // ---------- 브로셔 추출 ----------
  async function handleFile(file) {
    if (!file) return; toast('브로셔 읽는 중…');
    try {
      let text = '';
      if (file.type === 'application/pdf' && window.pdfjsLib) {
        try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise; for (let p = 1; p <= Math.min(pdf.numPages, 20); p++) { const pg = await pdf.getPage(p); const tc = await pg.getTextContent(); text += tc.items.map(i => i.str).join(' ') + '\n'; } } catch (e) { console.warn('pdf.js', e); }
      }
      state._pendingFile = file;
      if (state.workerOk && state.workerKeys && state.workerKeys.anthropic) { // 서버 AI 추출(문서 전체 + 텍스트) → 가장 정확
        const ok = await extractAI(file, text); if (ok) return;
      }
      if (text.replace(/\s/g, '').length > 80) { applyExtract(extractFromText(text), file.name, 'PDF 텍스트(규칙)'); return; }
      await extractAI(file, text);
    } catch (e) { console.error(e); toast('추출 실패: ' + e.message); }
  }
  function extractFromText(text) {
    const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean); const t = lines.join(' ');
    const out = { missing: [] };
    const after = (labels, re) => { for (let i = 0; i < lines.length; i++) if (labels.some(l => lines[i].replace(/\s/g, '') === l)) { for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) { const m = lines[j].match(re); if (m) return m; } } const m = t.match(new RegExp('(?:' + labels.join('|') + ')\\s*[:：]?\\s*' + re.source)); return m; };
    const addrRe = /((?:서울특별시|서울시|서울|부산|대구|인천|광주|대전|울산|세종|경기도|경기|강원|충북|충남|전북|전남|경북|경남|제주)[^,()]{2,50}?\d+(?:-\d+)?(?:번지|외\s*\d*\s*(?:필지|번지)?)?)/;
    const a = after(['주소', '소재지', '대지위치', '물건소재지'], addrRe) || t.match(addrRe); if (a && !/중개|대표|Tel|테헤란로 325/.test(a[0])) out.address = a[1].replace(/\s+/g, ' ').trim(); else { const alt = lines.map(l => l.match(addrRe)).filter(m => m && !/중개|대표|Tel/.test(m.input))[0]; if (alt) out.address = alt[1].trim(); else out.missing.push('주소'); }
    const moneyRe = /([\d,.]+\s*억(?:\s*[\d,]+\s*만)?(?:\s*원)?|[\d,]{9,}\s*원?)/; const toWon = str => { const m = str.match(/([\d.]+)\s*억(?:\s*([\d,]+)\s*만)?/); if (m) return Math.round(parseFloat(m[1]) * 1e8 + (m[2] ? parseFloat(m[2].replace(/,/g, '')) * 1e4 : 0)); const n = parseFloat(str.replace(/[^\d.]/g, '')); return isNaN(n) ? 0 : n; };
    const ask = after(['매매가', '매도가', '매각가', '매각금액', '매매금액', '희망가', '매도희망가', '분양가'], moneyRe); if (ask) out.ask = toWon(ask[1]); else out.missing.push('매도가');
    const areaRe = /([\d,.]+)\s*(㎡|m2|m²|평)/; const toSqm = m => m[2] === '평' ? num(m[1]) * 3.3058 : num(m[1]);
    const la = after(['대지면적', '토지면적', '대지'], areaRe); if (la) out.landArea = toSqm(la); else out.missing.push('대지면적');
    const sa = after(['매매면적', '매각면적', '전용면적', '분양면적'], areaRe); if (sa) out.exclusiveArea = toSqm(sa);
    const gfa = after(['연면적', '건물면적', '총면적'], areaRe); if (gfa) out.gfa = toSqm(gfa); else if (out.exclusiveArea) out.gfa = out.exclusiveArea;
    const pp = after(['공시지가', '개별공시지가', '공시지가\\(26년\\)', '공시지가\\(25년\\)'], /([\d,]{6,})\s*원/); if (pp) out.publicPricePerSqm = num(pp[1]);
    const dep = after(['보증금', '임대보증금', '보증금합계', '보증금총액'], moneyRe); const rent = after(['월임대료', '월세', '임대료', '월차임'], /([\d,.]+\s*억(?:\s*[\d,]+\s*만)?|[\d,]{6,}|[\d,.]+\s*만)/);
    if (dep || rent) out.rentroll = [{ floor: '합계', tenant: '브로셔 합계', deposit: dep ? toWon(dep[1]) : 0, rent: rent ? toWon(rent[1]) : 0, mgmt: 0, expiry: '', vacant: false }]; else out.missing.push('임대료');
    const zone = t.match(/(제?\d종?\s*(?:일반|전용)?(?:주거|상업|공업|녹지)지역|준주거지역|준공업지역|일반상업지역|중심상업지역|근린상업지역|유통상업지역|자연녹지지역|생산녹지지역|보전녹지지역|계획관리지역|생산관리지역|보전관리지역|농림지역|자연환경보전지역)/); if (zone) out.zone = zone[1].replace(/\s/g, '');
    const by = after(['준공연도', '준공', '사용승인', '사용승인일자', '준공일'], /((?:19|20)\d{2})/) || t.match(/(?:준공|사용승인)\s*[:：]?\s*((?:19|20)\d{2})/); if (by) out.builtYear = by[1];
    const fl = t.match(/(지하\s*\d+층\s*[\/~·]?\s*)?지상\s*\d+층/); if (fl) out.floors = fl[0];
    const scope = t.match(/(지상\s*\d+\s*[~∼-]\s*\d+층\s*전부|\d+\s*[~∼-]\s*\d+층\s*전부|\d+층\s*전부|구분소유|집합건물)/); if (scope) { out.saleScope = 'part'; out.scopeNote = scope[0]; }
    const pk = after(['주차장', '주차', '주차대수'], /(\d+)\s*대/); if (pk) out.parking = pk[1] + '대';
    const el = after(['승강기', '엘리베이터'], /(\d+)\s*대/); if (el) out.elevator = el[1] + '대';
    const use = after(['주용도', '용도'], /([가-힣, ·]{2,30})/); if (use) out.mainUse = use[1].trim();
    const nm = t.match(/([가-힣A-Za-z0-9]+(?:타워|빌딩|프라자|센터|스퀘어))/); if (nm) out.buildingName = nm[1];
    return out;
  }
  function applyExtract(ex, fname, source) {
    const c = state.current; ['address', 'ask', 'landArea', 'gfa', 'zone', 'builtYear', 'floors', 'pnu', 'lawd', 'parking', 'elevator', 'publicPricePerSqm', 'exclusiveArea', 'saleScope', 'scopeNote', 'mainUse', 'buildingName', 'sellerHope'].forEach(k => { if (ex[k] !== undefined && ex[k] !== null && ex[k] !== '' && ex[k] !== 0) c[k] = ex[k]; });
    if (ex.rentroll && ex.rentroll.length) c.rentroll = ex.rentroll.map(r => Object.assign({ mgmt: 0, expiry: '', vacant: false }, r)); if (ex.type && C.TYPES[ex.type]) { c.type = ex.type; initRisks(c); }
    if (c.exclusiveArea && !c.gfa) c.gfa = c.exclusiveArea; if (c.publicPricePerSqm && c.landArea && !c.landPublic) c.landPublic = Math.round(c.publicPricePerSqm * c.landArea);
    const short = (c.address || '').replace(/^(서울특별시|서울시|서울|경기도|경기)\s*/, '').split(' ').slice(0, 3).join(' ');
    c.name = (c.buildingName ? c.buildingName + ' ' : '') + (short || '브로셔 물건') + (c.scopeNote ? ' (' + c.scopeNote + ')' : '');
    if (ex.notes) c.notes = ex.notes;
    if (c.ask) { c.askAuto = false; if (!c.sellerHope) { c.sellerHope = Math.round(c.ask * (1 + (state.settings.hopeMarkup ?? 0.2))); c.sellerHopeAuto = true; } if (!c.buyerHope) { c.buyerHope = Math.round(c.ask * 0.9); c.buyerHopeAuto = true; } }
    c.extracted = { file: fname, source, missing: ex.missing || [], confidence: ex.confidence };
    save(); render(); toast('추출 완료 — 주소로 공적장부·실거래를 자동 수집합니다');
    if (c.address) autoCollect().catch(() => { });
  }
  async function extractAI(file, text) {
    file = file || state._pendingFile; const url = state.settings.workerUrl; if (!url) { toast('설정에서 Worker 주소를 입력하세요'); return false; }
    toast('AI 정밀 추출 중… (10~30초)');
    try {
      let body;
      if (file) { const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(file); }); body = { file: b64, mime: file.type, name: file.name, text: text || '' }; }
      else { const txt = ($('#paste') || {}).value || ''; if (!txt) { toast('브로셔 파일 또는 텍스트가 필요합니다'); return false; } body = { text: txt }; }
      const r = await fetch(url.replace(/\/$/, '') + '/extract', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); if (j.error) throw new Error(j.error);
      applyExtract(j, file ? file.name : '붙여넣기', 'Worker AI'); return true;
    } catch (e) { toast('AI 추출 실패: ' + e.message + ' — 규칙 분석으로 대체'); return false; }
  }

  // ---------- 탭: 시장·리스크 ----------
  function renderMarket() {
    const c = state.current; const m = c.market; const t = C.TYPES[c.type];
    const comps = c.comps.map((x, i) => `<tr><td><input type="checkbox" data-c="${i}.use" ${x.use !== false ? 'checked' : ''} aria-label="채택"></td><td><input data-c="${i}.addr" value="${esc(x.addr)}"></td><td><input data-c="${i}.type" value="${esc(x.type)}"></td><td><input data-c="${i}.area" data-t="num" value="${x.area || ''}" style="width:80px"></td><td><input data-c="${i}.price" data-t="money" value="${x.price ? x.price.toLocaleString() : ''}"></td><td class="r">${x.pricePerSqm ? fmt(x.pricePerSqm) + '/㎡' : '—'}${x.pricePerSqmBldg ? '<br><span class="muted">전용 ' + fmt(x.pricePerSqmBldg) + '</span>' : ''}</td><td><input data-c="${i}.date" value="${esc(x.date)}" style="width:80px">${x.floor ? '<div class="muted">' + esc(x.floor) + '층</div>' : ''}</td><td><button class="btn sm" onclick="App.delComp(${i})">삭제</button></td></tr>`).join('');
    const used = c.comps.filter(x => x.use !== false && x.pricePerSqm > 0).map(x => x.pricePerSqm);
    const q = used.length ? `25% ${fmt(C.quantile(used, .25))} · 50% ${fmt(C.quantile(used, .5))} · 75% ${fmt(C.quantile(used, .75))} /㎡ (평당 ${fmt(C.quantile(used, .5) * 3.3058)})` : '채택 사례 없음';
    const risks = c.risks.map((r, i) => `<div class="risk"><div class="tt"><b>${esc(r.label)}</b><small>${esc(r.hint)} ${r.law ? '· <u>' + esc(r.law) + '</u>' : ''}</small><small><input data-r="${i}.memo" value="${esc(r.memo)}" placeholder="확인 내용 메모" style="width:100%;text-align:left;margin-top:4px;height:28px"></small></div><select data-r="${i}.status"><option value="na" ${r.status === 'na' ? 'selected' : ''}>미확인</option><option value="ok" ${r.status === 'ok' ? 'selected' : ''}>통과</option><option value="warn" ${r.status === 'warn' ? 'selected' : ''}>주의</option><option value="bad" ${r.status === 'bad' ? 'selected' : ''}>위험</option></select>${t.land ? `<input data-r="${i}.rate" data-t="pct" value="${r.rate ? (r.rate * 100).toFixed(0) : ''}" placeholder="감가 %" style="width:80px">` : ''}<input data-r="${i}.deduct" data-t="money" value="${r.deduct ? r.deduct.toLocaleString() : ''}" placeholder="감산 ₩"></div>`).join('');
    const ded = c.risks.reduce((s, r) => s + (r.deduct || 0), 0); const cnt = s => c.risks.filter(r => r.status === s).length;
    return `
<div class="grid g4">${kpi('한국은행 기준금리', pct(m.baseRate, 2), '기준일 ' + m.asOf)}${kpi('국고채 10년 (무위험)', pct(m.riskFree, 3), '요구수익률 기준 · 3년 ' + pct(m.kr3y, 3))}${kpi('미국채 10년', pct(m.us10y, 3), '헤지 후 약 ' + pct(m.us10y - (m.us2y - m.kr2y), 2) + ' · 환율 ₩' + m.usdkrw)}${t.income ? kpi('공실률·시장 환원율', pct(c.type === 'building' ? m.vacancyOffice : c.type === 'warehouse' ? m.vacancyLogis : m.vacancyRetail, 1) + ' · ' + pct(m.marketCap, 1), '부동산원 2Q · 중소형 시장값') : kpi('지가변동률·토지 요구수익률', '+1.22% · ' + pct((m.riskFree ?? 0.044) + 0.015, 2), '2026 상반기 전국(수도권 +1.69%) · 국고채+1.5%p')}</div>
<div class="grid g2">
${card('시장 데이터 갱신', `<div class="fgrid g3">${field('국고채 10년', 'market.riskFree', m.riskFree, 'pct')}${field('시장 환원율(실거래 역산)', 'market.marketCap', m.marketCap, 'pct')}${field('기준금리', 'market.baseRate', m.baseRate, 'pct')}${field('미국채 10년', 'market.us10y', m.us10y, 'pct')}${field('은행 기업대출 평균', 'market.loanRateAvg', m.loanRateAvg, 'pct')}${field('기준일', 'market.asOf', m.asOf)}</div><div style="display:flex;gap:8px;margin-top:10px;align-items:center"><button class="btn sm" onclick="App.fetchStats()">Worker에서 최신값 가져오기</button><span class="muted">${esc(m.source || '')}</span></div>`)}
${card('실거래 자동 조회 (국토부 API)', `<div class="fgrid g3">${field('시군구코드', 'lawd', c.lawd)}${field('조회 기간(개월, 기본 12)', 'rtmsMonths', c.rtmsMonths || 12, 'num')}${field('비교 용도지역(쉼표 구분, 비우면 전체)', 'zoneFilter', c.zoneFilter || '')}${field('유형', 'rtmsKind', c.rtmsKind || (t.income ? 'nrg' : 'land'), 'select', [['nrg', '상업업무용'], ['land', '토지'], ['indu', '공장·창고']])}${field('비교 지역 한정 (읍면동·리, 쉼표 구분 · 비우면 시군구 전체)', 'dongFilter', c.dongFilter || '')}${field('정렬 기준 (높은순)', 'compSort', c.compSort || 'price', 'select', [['price', '거래금액(총액)'], ['unit', '㎡당 단가']])}</div><div style="display:flex;gap:8px;margin-top:10px;align-items:center"><button class="btn sm primary" onclick="App.fetchRtms()">실거래 조회</button><span class="muted" id="rtms-status">${esc(state.rtmsStatus || (C.TYPES[c.type].income ? (state.settings.dataKey || state.workerOk ? '준비됨' : '설정 탭에 공공데이터포털 서비스키 입력 필요') : '토지 실거래는 land-check-api로 바로 조회'))}</span></div>`)}
</div>
${card(`인근 실거래 사례 — 최근 ${c.rtmsMonths || 12}개월 · ${c.compSort === 'unit' ? '단가' : '거래금액'} 높은순 · 최신순 (체크한 사례만 평가에 사용)`, `<table><thead><tr><th>채택</th><th>소재지</th><th>용도·지역</th><th>면적㎡</th><th>거래금액</th><th class="r">단가</th><th>계약</th><th></th></tr></thead><tbody>${comps}</tbody></table><div class="muted" style="margin-top:8px">분위 단가: ${q}</div>`, `<button class="btn sm" onclick="App.sortComps()">높은순·최신순 정렬</button> <button class="btn sm" onclick="App.addComp()">+ 사례 추가</button>`)}
${card('법률·행정 리스크 판정', `<div>${risks}</div><div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;flex-wrap:wrap;gap:8px"><div class="muted">조문 근거는 설정 탭의 법령 조회(법제처 API)로 원문·시행일 확인. 토지는 감가 %(가격 비율), 수익형은 감산 ₩(원상복구·공실 해소비)</div><div>감산 합계 <b style="color:var(--red);font-size:15px">−${fmt(ded)}</b></div></div>`, `${pill('통과 ' + cnt('ok'), 'ok')} ${pill('주의 ' + cnt('warn'), 'warn')} ${pill('위험 ' + cnt('bad'), 'bad')}`)}
`;
  }
  function afterMarket(root) {
    bindInputs(root, state.current, () => { });
    root.querySelectorAll('[data-c]').forEach(el => el.addEventListener('change', () => { const [i, k] = el.dataset.c.split('.'); const x = state.current.comps[+i]; let v = el.type === 'checkbox' ? el.checked : el.value; if (el.dataset.t === 'money') v = money(v); else if (el.dataset.t === 'num') v = num(v); x[k] = v; if (x.area > 0 && x.price > 0) x.pricePerSqm = Math.round(x.price / x.area); save(); render(); }));
    root.querySelectorAll('[data-r]').forEach(el => el.addEventListener('change', () => { const [i, k] = el.dataset.r.split('.'); let v = el.value; if (el.dataset.t === 'money') v = num(v); if (el.dataset.t === 'pct') v = num(v) / 100; state.current.risks[+i][k] = v; save(); if (k !== 'memo') render(); }));
  }

  // ---------- 탭: 매수 가치 ----------
  function renderBuy() {
    const c = state.current; const ev = evaluate(); if (!ev) return '<div class="notice bad">계산 오류</div>'; const t = ev.type; const m = c.market;
    if (t.income) {
      const n = ev.noi, caps = ev.caps, cf = ev.cf10;
      const bars = cf.rows.map(r => { const max = Math.max(1, ...cf.rows.map(x => Math.max(x.noi, x.cf - (x.saleNet || 0)))); const h = v => Math.min(100, Math.max(2, v / max * 100)); return `<div class="b"><div class="s"><i style="background:var(--navy);height:${h(r.noi)}%"></i><i style="background:var(--gold);height:${h(r.cf - (r.saleNet || 0))}%"></i></div><small>${r.year}년</small></div>`; }).join('');
      const heat = ev.sensitivity.map((row, i) => `<div class="h">${pct(row.cap, 1)}</div>` + row.cells.map((cell, j) => { const a = 0.1 + 0.2 * (i + j) / 3; return `<div style="background:rgba(15,37,68,${a.toFixed(2)});color:${a > 0.32 ? '#fff' : 'var(--navy)'}">${eok(cell.value)}</div>`; }).join('')).join('');
      const rows = cf.rows.map(r => `<tr><td>${r.year}</td><td class="r">${fmt(r.noi)}</td><td class="r">${fmt(r.interest + r.principal)}</td><td class="r">${fmt(r.cf - (r.saleNet || 0))}</td><td class="r">${r.sale ? fmt(r.saleNet) : '—'}</td><td class="r">${fmt(r.cum)}</td></tr>`).join('');
      const dec = decisionBuyer(ev, c);
      const noInc = ev.noIncome ? `<div class="notice warn">임대료가 입력되지 않아 수익환원·현금흐름은 계산되지 않았습니다. 실거래 ${ev.compsVal ? ev.compsVal.basis : ''} 비준만으로 가격을 산정했습니다. 입력 탭의 <b>시장 임대료(₩/㎡·월)</b> 또는 렌트롤을 넣으면 5단 검증이 모두 켜집니다.${ev.rentEstimated ? ' (현재 시장 임대료 추정값 사용 중)' : ''}</div>` : (ev.rentEstimated ? '<div class="notice info">렌트롤 대신 입력한 시장 임대료로 NOI를 추정했습니다.</div>' : '');
      return `${noInc}
<div class="grid g75">
${hero('매수자 최대 지불 가능 금액 (WTP)', fmt(ev.wtp), ev.noIncome ? `= 실거래 ${ev.compsVal ? ev.compsVal.basis + ' 25% 분위 ' + eok(ev.compsVal.low) + ' (중앙값 ' + eok(ev.compsVal.mid) + ')' : '사례 없음'} − 리스크 감산 ${eok(ev.riskDeduct)} · 호가 대비 <b>${c.ask ? pct((ev.wtp - c.ask) / c.ask, 1) : '—'}</b>` : `= MIN(수익환원 ${eok(ev.value.buyer)}, NPV·WACC ${eok(ev.npv.maxPrice)}${ev.compsVal ? ', 실거래 비준 ' + eok(ev.compsVal.low) : ''}) − 리스크 감산 ${eok(ev.riskDeduct)} · 호가 대비 <b>${c.ask ? pct((ev.wtp - c.ask) / c.ask, 1) : '—'}</b> · 매수 희망가 ${eok(c.buyerHope)} ${c.buyerHope && c.buyerHope <= ev.wtp ? '<b>상한 이내</b>' : '<b>상한 초과</b>'}`)}
${card('결정 — 매수자 입장', dec)}
</div>
<div class="grid g5">${kpi('① Cap Rate (매수자)', pct(caps.buyer, 2), `NOI ${eok(n.noi)} · 국고채 ${pct(m.riskFree, 2)} + 프리미엄 − g · 중립 ${pct(caps.neutral, 1)}`)}${kpi('② NPV (WACC ' + pct(ev.wacc.wacc, 2) + ')', eok(ev.npv.maxPrice), `NPV=0 투자원금 · Re ${pct(ev.wacc.re, 1)} · Rd ${pct(ev.wacc.rd, 1)}`)}${kpi('③ DSCR', ev.dscr ? ev.dscr.toFixed(2) : '—', `원리금균등 20년 · ${C.dscrGrade(ev.dscr)} · 이자만 ${ev.dscrIO ? ev.dscrIO.toFixed(2) : '—'}`, ev.dscr >= 1.3 ? 'ok' : ev.dscr >= 1.2 ? '' : ev.dscr >= 1 ? 'warn' : 'bad')}${kpi('④ 보유세 (연)', fmt(ev.holdingTax.total), `재산세 ${fmt(ev.holdingTax.propertyTax)} · 종부세 ${fmt(ev.holdingTax.cpt)}`)}${kpi('⑤ 스프레드', pp(ev.spread), `세전 IRR ${pct(cf.irr, 2)} − 국고채 ${pct(m.riskFree, 2)}`, ev.spread >= 0.015 ? 'ok' : ev.spread >= 0 ? 'warn' : 'bad')}</div>
<div class="grid g3">${kpi('호가 기준 수익률', ev.askYield ? pct(ev.askYield.noi, 2) + ' (NOI)' : '—', ev.askYield ? `표면 ${pct(ev.askYield.gross, 2)} · 조달금리 ${pct(c.loanRate, 1)} ${ev.askYield.noi < c.loanRate ? '→ 역레버리지' : ''}` : '호가 입력 필요', ev.askYield && ev.askYield.noi < c.loanRate ? 'bad' : '')}${kpi('국채 대안 비교', `국고채 ${pct(m.riskFree, 2)} · 미국채 ${pct(m.us10y, 2)}`, `미국채 헤지 후 약 ${pct(m.us10y - (m.us2y - m.kr2y), 2)} · 예금 ${pct(m.deposit, 2)}`)}${kpi('취득세·부대비용', fmt(ev.acqTax.total), `${pct(ev.acqTax.effective, 1)} · ${c.buyerType === 'corp' ? '법인' : '개인'}${c.bigCity ? ' · 대도시 중과' : ''}`)}</div>
<div class="grid g75">
${card('10년 현금흐름 (매입가 = 중립 수익가액 ' + eok(ev.value.neutral) + ')', `<div class="bars">${bars}</div><div class="muted" style="margin-bottom:8px"><span style="display:inline-block;width:10px;height:10px;background:var(--navy);border-radius:2px"></span> NOI &nbsp; <span style="display:inline-block;width:10px;height:10px;background:var(--gold);border-radius:2px"></span> 세전 현금흐름(매각 제외)</div><table><thead><tr><th>년</th><th class="r">NOI(보유세·CapEx 차감)</th><th class="r">원리금</th><th class="r">현금흐름</th><th class="r">매각 순수입</th><th class="r">누적</th></tr></thead><tbody>${rows}</tbody></table>
<div class="grid g4" style="margin-top:10px">${kpi('자기자본', eok(cf.equity), `${fmt(cf.equity)} · 대출 ${eok(cf.loan)} (LTV ${pct(c.ltv, 0)})`)}${kpi('10년차 매각가', eok(cf.salePrice), `${fmt(cf.salePrice)} · 출구 환원율 ${pct(caps.neutral + 0.002, 1)} · 자본차익 ${eok(cf.capitalGain)}`)}${kpi('세전 IRR 10년 / 5년', `${pct(cf.irr, 2)} / ${pct(ev.cf5.irr, 2)}`, `자기자본배수 ${cf.equityMultiple.toFixed(2)}x · 1년차 현금수익률 ${pct(cf.cashYield1, 2)}`)}${kpi('매수 주체', c.buyerType === 'corp' ? '법인' : '개인', c.buyerType === 'corp' ? '법인세 9~24% · WACC 절세효과 반영' : '임대소득 종합과세 · 입력 탭에서 변경')}</div>`)}
${card('민감도 — 환원율 × 공실률', `<div class="heat"><div></div><div class="h">5%</div><div class="h">10%</div><div class="h">15%</div><div class="h">20%</div>${heat}</div><div class="muted" style="margin-top:8px">행 환원율 · 열 공실률 · 셀 수익가액. 현재 가정 ${pct(caps.buyer, 1)} · ${pct(c.vacancy, 0)}</div>`)}
</div>`;
    }
    // 토지
    const lv = ev.land; const dec = decisionBuyer(ev, c);
    return `
<div class="grid g75">
${hero('매수자 최대 지불 가능 금액 (WTP)', fmt(ev.wtp), `실거래 하위 분위 ${eok(lv.byComps.low)} / 공시지가 배율법 ${eok(lv.byRatio)} (배율 ${lv.ratio.toFixed(2)}) − 규제 감가 ${pct(lv.discountRate, 0)} − 감산 ${eok(ev.riskDeduct)}${ev.conversionLevy ? ' − 전용부담금 ' + eok(ev.conversionLevy) + (c.willConvert ? '' : '(전용 시)') : ''} · 호가 대비 <b>${c.ask ? pct((ev.wtp - c.ask) / c.ask, 1) : '—'}</b>`)}
${card('결정 — 매수자 입장', dec)}
</div>
<div class="grid g5">${kpi('실거래 분위 단가', lv.unitQ.q50 ? fmt(lv.unitQ.q50) + '/㎡' : '—', lv.unitQ.q25 ? `25% ${fmt(lv.unitQ.q25)} · 75% ${fmt(lv.unitQ.q75)}` : '시장 탭에서 사례 입력')}${kpi('공시지가 배율', lv.ratio.toFixed(2) + '배', `공시지가 ${fmt(c.publicPricePerSqm)}/㎡ × ${c.landArea}㎡`)}${kpi('개발가치 상한', lv.devCap ? eok(lv.devCap) : '—', '용적률 × 단가 × 35% (잔여법 간이)')}${kpi('보유세 (연)', fmt(ev.holdingTax.total), c.type === 'farm' || c.type === 'forest' ? '분리과세 0.07%' : '종합합산 (종부세 5억 공제)')}${kpi('스프레드', pp(ev.spread), `10년 IRR ${pct(ev.cf10.irr, 2)} (지가 ${pct(c.landGrowth, 1)}/년 가정) − 국고채`, ev.spread >= 0.015 ? 'ok' : ev.spread >= 0 ? 'warn' : 'bad')}</div>
${lv.parcels ? card('필지별 평가 · 합필 개발가치', `<table><thead><tr><th>지번</th><th>지목</th><th class="r">면적㎡</th><th class="r">공시지가</th><th class="r">보정</th><th class="r">단가(중앙)/㎡</th><th class="r">하한</th><th class="r">중앙</th><th class="r">상한</th></tr></thead><tbody>${lv.parcels.rows.map(x => `<tr><td>${esc(x.addr)}</td><td>${esc(x.jimok || '')}</td><td class="r">${x.area.toLocaleString()}</td><td class="r">${fmt(x.pub)}</td><td class="r">${x.factor < 1 ? '×' + x.factor : '—'}</td><td class="r">${fmt(x.unitMid)}</td><td class="r">${eok(x.low)}</td><td class="r">${eok(x.mid)}</td><td class="r">${eok(x.high)}</td></tr>`).join('')}</tbody><tfoot><tr><td colspan="6" style="font-weight:700">합계 (기준 필지 ${esc(lv.parcels.ref)} 실거래 배율 적용)</td><td class="r" style="font-weight:700">${eok(lv.parcels.low)}</td><td class="r" style="font-weight:700">${eok(lv.parcels.mid)}</td><td class="r" style="font-weight:700">${eok(lv.parcels.high)}</td></tr></tfoot></table><div class="grid g3" style="margin-top:12px">${kpi('필지별 합계(중앙)', eok(lv.parcels.mid), '필지 단순 합산')}${kpi('합필 프리미엄', pct(lv.assemblage.premium, 1), '필지당 3% · 최대 10% (매도자 협상 근거, 매수자 WTP 미반영)')}${kpi('합필 후 가치', eok(lv.assemblage.value), '+' + eok(lv.assemblage.gain) + ' (일단지화·규모·접도 개선)')}</div><div class="muted" style="margin-top:8px">필지별 공시지가에 비례해 평가하고 도로·구거·하천 지목은 ×0.3 보정합니다. 매수자 WTP는 필지별 합계 기준, 매도자 적정가는 합필 프리미엄을 더해 산정합니다.</div>`) : ''}
<div class="grid g2">
${card('보유 시나리오', `<table><thead><tr><th>보유</th><th class="r">투입(취득비 포함)</th><th class="r">예상 매각가</th><th class="r">자본차익</th><th class="r">보유세 누계</th><th class="r">IRR</th></tr></thead><tbody><tr><td>5년</td><td class="r">${fmt(ev.cf5.equity)}</td><td class="r">${fmt(ev.cf5.sale)}</td><td class="r">${fmt(ev.cf5.capitalGain)}</td><td class="r">${fmt(ev.cf5.holdTax)}</td><td class="r">${pct(ev.cf5.irr, 2)}</td></tr><tr><td>10년</td><td class="r">${fmt(ev.cf10.equity)}</td><td class="r">${fmt(ev.cf10.sale)}</td><td class="r">${fmt(ev.cf10.capitalGain)}</td><td class="r">${fmt(ev.cf10.holdTax)}</td><td class="r">${pct(ev.cf10.irr, 2)}</td></tr></tbody></table><div class="muted" style="margin-top:8px">토지는 보유 중 수익이 없어 요구 연복리 상승률 = 국고채 + 1.5%p = ${pct(ev.landRequired, 2)}. 매각 시 양도세는 매도·세무 탭 기준 적용.</div>`)}
${card('전용·취득 비용', `<div class="grid g2">${kpi('전용부담금', fmt(ev.conversionLevy), c.type === 'farm' ? '농지보전부담금 = 공시지가 30% (㎡당 상한 ₩50,000)' : c.type === 'forest' ? '대체산림자원조성비(산림청 고시 단가 입력)' : '해당 없음')}${kpi('취득세', fmt(ev.acqTax.total), pct(ev.acqTax.effective, 2) + (c.type === 'farm' ? ' · 농지 3%(자경 1.5%)' : ' · 4%'))}</div><div class="muted" style="margin-top:8px">맹지·농업진흥·보전산지 감가율은 시장·리스크 탭에서 %로 입력하면 자동 반영됩니다.</div>`)}
</div>`;
  }
  function decisionBuyer(ev, c) {
    const rows = []; const z = ev.zopa;
    const title = ev.wtp > 0 ? `${eok(ev.wtp)} 이하에서만 매수, 그 이상은 보류` : '입력 부족';
    if (c.ask) rows.push(['권고', c.ask <= ev.wtp ? `호가 ${eok(c.ask)}은 WTP 이내(${pct((ev.wtp - c.ask) / c.ask, 0)} 여유) — 호가 또는 그 이하에서 매수 가능.` : `호가 ${eok(c.ask)}은 WTP 대비 ${pct((c.ask - ev.wtp) / ev.wtp, 0)} 높음${ev.askYield ? ` · 호가 NOI 수익률 ${pct(ev.askYield.noi, 1)}${ev.askYield.noi < c.loanRate ? ' < 조달금리 → 역레버리지' : ''}` : ''}.`]);
    if (!ev.noIncome && ev.dscr != null && ev.dscr < state.settings.dscrMin) rows.push(['조건', `DSCR ${ev.dscr.toFixed(2)} → LTV ${pct(Math.max(0.3, c.ltv - 0.1), 0)}로 축소하거나 거치 조건 확보.`]);
    ev.riskDeduct > 0 && rows.push(['조건', `리스크 감산 ${eok(ev.riskDeduct)}(${c.risks.filter(r => r.deduct).map(r => r.label.split(' ')[0]).join('·')})을 매도자 부담 또는 가격 반영.`]);
    if (ev.spread != null) rows.push([ev.spread >= 0.015 ? '대안' : '주의', `국고채 ${pct(c.market.riskFree, 2)} 대비 스프레드 ${pp(ev.spread)} (${ev.spread >= 0.015 ? '비교우위' : ev.spread >= 0 ? '중립 — 자본차익 전제' : '열위 — 국채가 유리'}).`]); else rows.push(['주의', '임대료 미입력 — 수익률·국채 비교는 시장 임대료 입력 후 산출됩니다.']);
    rows.push([z.hasZone ? '협상' : '괴리', z.hasZone ? `성사 구간 ${eok(z.zone.low)}~${eok(z.zone.high)} · 추천 ${eok(z.recommended)}` : `매도자 하한 ${eok(ev.wtaFinal)}과 ${eok(z.gap)} 괴리 — 조건 교환으로 좁혀야 함`]);
    return `<div class="dec"><div class="t">${title}</div>${rows.map(r => `<div class="row">${pill(r[0], r[0] === '권고' || r[0] === '협상' ? 'info' : r[0] === '대안' ? 'ok' : r[0] === '괴리' ? 'bad' : 'warn')}<span>${r[1]}</span></div>`).join('')}</div>`;
  }

  // ---------- 탭: 매도·세무 ----------
  function renderSell() {
    const c = state.current; const s = c.seller; const ev = evaluate(); if (!ev) return ''; const t = ev.type;
    const bp = (s.bizPeriods || []).map((b, i) => `<tr><td><input data-bp="${i}.from" type="date" value="${b.from || ''}"></td><td><input data-bp="${i}.to" type="date" value="${b.to && b.to < '2099' ? b.to : ''}"></td><td><input data-bp="${i}.type" value="${esc(b.type || '')}" placeholder="임대·주차장·자경 등"></td><td><button class="btn sm" onclick="App.delBp(${i})">삭제</button></td></tr>`).join('');
    const inputs = card('매도자 입력', `<div class="fgrid g4" id="sellerform">${field('소유 주체', 'seller.ownerType', s.ownerType, 'select', [['indiv', '개인'], ['corp', '법인']])}${field('취득일', 'seller.acquired', s.acquired, 'date')}${field('취득가액', 'seller.acquiredPrice', s.acquiredPrice, 'eok')}${field('필요경비(취득세·중개·자본적지출)', 'seller.expenses', s.expenses, 'money')}${field('양도 예정일', 'seller.transfer', s.transfer, 'date')}${field('목표 세후 수익(취득원가 초과)', 'seller.targetNet', s.targetNet, 'eok')}${field('지분율', 'seller.share', s.share, 'pct')}${field('중개·법무비율', 'seller.sellCostRate', s.sellCostRate, 'pct')}${field('부가세(건물분, 포괄양수도 아니면)', 'seller.vat', s.vat, 'money')}</div>
${t.land ? `<h3 style="margin-top:14px">사업 사용 기간 (재촌·자경, 주차장업, 건축 등)</h3><table><thead><tr><th>시작</th><th>종료(진행 중이면 비움)</th><th>사용 형태</th><th></th></tr></thead><tbody>${bp}</tbody></table><button class="btn sm" style="margin-top:8px" onclick="App.addBp()">+ 기간 추가</button>` : '<div class="muted" style="margin-top:10px">건물 부속토지는 바닥면적 배율(도시 3~5배) 이내이면 사업용으로 봅니다(소득세법 시행령 §168의11). 배율 초과분·별도 나대지는 토지 유형으로 따로 검토하세요.</div>'}`);
    if (!s.acquiredPrice || !s.acquired) return inputs + '<div class="notice info">취득일·취득가액을 입력하면 세후 역산과 양도세 시뮬레이션이 표시됩니다.</div>';
    const j = ev.judgement; const st = ev.sellerTax; const base = c.ask || ev.sellerFair; const ap = (t.income || j.business) ? st.biz : st.now;
    const tests = j.tests.map(x => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--ivory);border-radius:8px;margin-bottom:6px;font-size:13px"><span>${x.label}</span><span>${Math.round(x.have)}/${Math.round(x.need)}일 ${x.ok ? pill('충족', 'ok') : pill('미충족', 'bad')}</span></div>`).join('');
    const ltWhy = r => r.ltRate == null ? (s.ownerType === 'corp' ? '법인 — 장특공제 없음(소득세법 §95는 개인 양도소득세에만 적용)' : r.note || '')
      : r.ltRate === 0 ? (r.years < 3 ? `장특공제 0% — 보유 ${r.years.toFixed(1)}년 (3년 이상부터 연 2%, §95②)` : '장특공제 0% — 2028년 이후 비사업용 배제(개편안)')
      : `장특공제 ${pct(r.ltRate, 0)} <span class="muted">(보유 ${Math.floor(r.years)}년 × 2%, 최대 30%)</span>`;
    const taxRow = (l, r, cls) => `<tr><td style="font-weight:500">${l}</td><td>${ltWhy(r)}</td><td class="r">${fmt(r.taxable)}</td><td class="r" style="font-weight:700;color:${cls}">${fmt(r.total)}</td><td class="r">${pct(r.effective, 1)}</td></tr>`;
    const timing = ev.timing.map(x => `<div style="flex:1;padding:12px 14px;border-right:1px solid var(--line);${x.year === 2028 ? 'background:#F3DEDE' : x.year == null ? 'background:#E3EFE7' : ''}"><div class="muted">${x.label}${x.year ? (x.business ? ' · 사업용' : ' · 비사업용') : ''}</div><div style="font-weight:700;color:${x.year === 2028 ? 'var(--red)' : x.year == null ? 'var(--green)' : 'var(--ink)'}">${eok(x.tax)}</div><div class="muted">세후 ${eok(x.net)}</div></div>`).join('');
    const dec = decisionSeller(ev, c);
    return `
<div class="grid g75">
${hero('매도자 최소 수용 금액 (WTA)', fmt(ev.wtaFinal), `${ev.wtaComputed ? '호가 ' + eok(c.ask) + '가 산정 하한 ' + eok(ev.wtaComputed) + '보다 낮아 호가를 하한으로 적용 · ' : ''}취득원가 ${eok(s.acquiredPrice)} + 목표 세후수익 ${eok(s.targetNet)} + 양도세·비용을 역산한 하한 ${eok(ev.wta.wta)} · 적정 매도가(중립·상위 분위) <b>${eok(ev.sellerFair)}</b> · 매도 희망가 ${eok(c.sellerHope)} ${c.sellerHope ? '(' + pct((c.sellerHope - ev.sellerFair) / ev.sellerFair, 0) + ' vs 적정가)' : ''}`)}
${card('결정 — 매도자 입장', dec)}
</div>
${inputs}
<div class="grid g57">
${card('사업용 · 비사업용 판정 (시행령 §168의6 · 일수 기준)', `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><span>소유 ${j.ownYears.toFixed(1)}년 (${j.ownDays}일) ${t.income ? '· 건물 부속토지' : ''}</span>${(t.income || j.business) ? pill('사업용', 'ok') : pill('비사업용', 'bad')}</div>${t.income ? '<div class="muted">건물이 있는 토지는 사업용으로 계산합니다.</div>' : tests + (j.business ? '' : `<div style="margin-top:8px"><div class="muted">사업용 전환까지 필요한 사용 기간</div><div style="font-weight:700;font-size:18px;color:var(--navy)">D-${j.daysToBiz}일</div><div style="height:8px;background:var(--line);border-radius:4px;margin-top:6px"><div style="width:${Math.min(100, 100 - j.daysToBiz / 1100 * 100).toFixed(0)}%;height:8px;background:var(--gold);border-radius:4px"></div></div></div>`)}<div class="muted" style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px">근거: ${j.basis} (법제처 API 2026-10-01 대조)</div>`)}
${card(`양도세 3열 비교 (기준가 ${eok(base)} · 지분 ${pct(s.share, 0)} · ${s.ownerType === 'corp' ? '법인' : '개인'})`, `<table><thead><tr><th>경로</th><th>공제</th><th class="r">과세표준</th><th class="r">세액(지방세 포함)</th><th class="r">실효</th></tr></thead><tbody>${taxRow('사업용', st.biz, 'var(--green)')}${taxRow('비사업용 · 현행(2027년까지)', st.now, 'var(--amber)')}${taxRow('비사업용 · 2028.1.1 이후', st.reform, 'var(--red)')}</tbody></table><div style="display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:10px">${timing}</div><div class="muted" style="margin-top:8px">개편안: 중과 +20%p·장특공제 배제(2028년 양도분부터, 국회 입법 확정 시 법제처 API로 갱신). 법인은 법인세 + 추가과세 10%→20%(장특공제 없음). 장특공제 보유기간 기산: 매매·증여는 취득(등기)일, 상속은 상속개시일(§95④), 배우자·직계존비속 증여 10년 내 양도는 증여자 취득일(이월과세) — 취득일란에 그 날짜를 넣어야 공제율이 맞습니다.</div>`)}
</div>
<div class="grid g4">${kpi('양도차익 (기준가)', fmt(st.now.gain), `취득 ${eok(s.acquiredPrice)} + 경비 ${eok(s.expenses)}`)}${kpi('세후 순수입 (기준가·' + ((t.income || j.business) ? '사업용' : '비사업용 현행') + ')', fmt(base - ap.total - base * s.sellCostRate - (s.vat || 0)), `양도세 ${eok(ap.total)} · 비용 ${eok(base * s.sellCostRate)}`)}${kpi('국고채 대안', fmt((base - ap.total) * c.market.riskFree) + '/년', `매각대금 국채 운용 vs NOI ${t.income ? eok(ev.noi.noi) : '—'}`)}${kpi('매수자 부담 비용(협상 데이터)', fmt(ev.acqTax.total + (ev.conversionLevy || 0) + ev.riskDeduct), `취득세 ${eok(ev.acqTax.total)}${ev.conversionLevy ? ' · 전용부담금 ' + eok(ev.conversionLevy) : ''} · 리스크 ${eok(ev.riskDeduct)}`)}</div>`;
  }
  function decisionSeller(ev, c) {
    const s = c.seller; const z = ev.zopa; const rows = [];
    const title = `호가를 ${eok(ev.sellerFair * 0.98)}~${eok(ev.sellerFair * 1.03)}으로 조정, ${ev.timing && !ev.timing[0].business ? '2027년 내 매각' : '6개월 내 매각 목표'}`;
    if (c.sellerHope && c.sellerHope > ev.sellerFair * 1.08) rows.push(['주의', `희망가 ${eok(c.sellerHope)}은 적정가 대비 ${pct((c.sellerHope - ev.sellerFair) / ev.sellerFair, 0)} 높아 장기 미매각 가능성.`]);
    if (ev.timing) { const t28 = ev.timing.find(x => x.year === 2028), t27 = ev.timing.find(x => x.year === 2027); if (t28 && t27 && t28.tax - t27.tax > 1e6) rows.push(['시점', `2028년 양도 시 세액 ${eok(t28.tax - t27.tax)} 증가 → 2027년 말 전 매각 또는 사업용 전환(D-${ev.judgement.daysToBiz}일).`]); }
    rows.push(['협상', z.hasZone ? `매수자 상한 ${eok(ev.wtp)} ≥ 하한 ${eok(ev.wtaFinal)} — 추천 성사가 ${eok(z.recommended)}` : `매수자 상한 ${eok(ev.wtp)}과 ${eok(z.gap)} 괴리 — 리스크 해소(${c.risks.filter(r => r.status === 'bad').map(r => r.label.split(' ')[0]).join('·') || '없음'}) 후 재제시`]);
    rows.push(['대안', `매각대금 국채 운용 ${pct(c.market.riskFree, 2)} vs 보유 ${ev.noi ? 'NOI ' + eok(ev.noi.noi) + '/년' : '지가 ' + pct(c.landGrowth, 1) + '/년'} — ${ev.noi && ev.noi.noi > (c.ask || ev.sellerFair) * c.market.riskFree ? '보유 유인 있음' : '보유 유인 약함'}.`]);
    return `<div class="dec"><div class="t">${title}</div>${rows.map(r => `<div class="row">${pill(r[0], r[0] === '협상' ? 'info' : r[0] === '대안' ? 'ok' : 'warn')}<span>${r[1]}</span></div>`).join('')}</div>`;
  }

  // ---------- 탭: ZOPA ----------
  function renderZopa() {
    const c = state.current; const ev = evaluate(); if (!ev) return ''; const z = ev.zopa; const g = ev.grade;
    const vals = [ev.wtp, ev.wtaFinal, c.ask, c.sellerHope, c.buyerHope].filter(v => v > 0); const lo = Math.min(...vals) * 0.9, hi = Math.max(...vals) * 1.05; const pos = v => ((v - lo) / (hi - lo) * 100).toFixed(1) + '%';
    const placed = []; const mk = (v, l, col, top) => { if (!(v > 0)) return ''; let t = top; const p = (v - lo) / (hi - lo); if (placed.some(q => Math.abs(q.p - p) < 0.06 && q.t === t)) t = !t; placed.push({ p, t }); return `<div class="mk" style="left:${pos(v)};top:${t ? 4 : 100}px"><span>${l}</span><b style="color:${col}">${eok(v)}</b></div><div class="tick" style="left:${pos(v)};background:${col}"></div>`; };
    const zone = z.hasZone ? `<div class="zone" style="left:${pos(z.zone.low)};width:${((z.zone.high - z.zone.low) / (hi - lo) * 100).toFixed(1)}%;background:rgba(46,107,74,.22);border:1px solid var(--green)"></div>` : `<div class="zone" style="left:${pos(Math.min(ev.wtp, ev.wtaFinal))};width:${(Math.abs(ev.wtaFinal - ev.wtp) / (hi - lo) * 100).toFixed(1)}%;background:rgba(158,52,52,.16);border:1px dashed var(--red)"></div>`;
    const args = negotiationArgs(ev, c);
    return `
<div class="grid g84">
${card('가격 축 — 거래성사 가능 구간', `<div class="axis"><div class="bar"></div>${zone}${mk(ev.wtp, '매수자 상한 WTP', 'var(--navy)', 1)}${mk(c.buyerHope, '매수 희망가', 'var(--blue)', 0)}${mk(ev.wtaFinal, '매도자 하한 WTA', 'var(--gold)', 1)}${mk(c.sellerHope, '매도 희망가', '#B08D57', 0)}${mk(c.ask, '호가', 'var(--red)', 1)}</div>
<div class="notice ${z.hasZone ? 'ok' : 'bad'}" style="margin-top:6px">${z.hasZone ? `<b>ZOPA 형성</b> — ${eok(z.zone.low)} ~ ${eok(z.zone.high)} · 추천 성사가 <b>${fmt(z.recommended)}</b> (매수자 우위 가중 ${state.settings.zopaWeight}) ${z.buyerHopeIn ? '· 매수 희망가 구간 내' : ''} ${z.sellerHopeIn ? '· 매도 희망가 구간 내' : ''}` : `<b>ZOPA 미형성</b> — WTA ${eok(ev.wtaFinal)} > WTP ${eok(ev.wtp)} · 괴리 <b>${eok(z.gap)} (${pct(z.gapPct, 0)})</b>. 조건 교환 시 중간값 ${fmt(z.recommended)}`}</div>`, `${pill(c.ask ? '호가 대비 ' + pct(z.askGapPct, 0) : '', 'info')}`)}
<section class="hero" style="justify-content:center"><div class="k">추천 등급</div><div style="display:flex;align-items:baseline;gap:12px"><div class="big">${g.grade}</div><div style="opacity:.85">${g.label}</div></div><div class="d">${z.hasZone ? '구간 형성' : '구간 없음'} · ${ev.noIncome ? '임대료 미입력(비준만)' : '스프레드 ' + pp(ev.spread) + ' · ' + (ev.dscr != null ? 'DSCR ' + ev.dscr.toFixed(2) : '토지')} · 위험 ${ev.riskBad}건 · 주의 ${ev.riskWarn}건</div></section>
</div>
<div class="grid g2">${card('매수자 결정', decisionBuyer(ev, c) + `<div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" onclick="App.previewReport('buy');App.setTab('report')">매수 검토 보고서</button><button class="btn" onclick="App.setTab('buy')">가치 상세</button></div>`)}${card('매도자 결정', (c.seller && c.seller.acquiredPrice ? decisionSeller(ev, c) : '<div class="muted">매도·세무 탭에서 취득 정보를 입력하면 매도자 결정이 표시됩니다.</div>') + `<div style="display:flex;gap:8px;margin-top:12px"><button class="btn gold" onclick="App.previewReport('sell');App.setTab('report')">매도 검토 보고서</button><button class="btn" onclick="App.setTab('sell')">세무 상세</button></div>`)}</div>
${card('협상 논거 (양측 균형)', `<div class="grid g2"><div><b style="color:var(--navy)">가격 인하 논거 (매수자용)</b><ul style="margin:6px 0 0 18px;padding:0;font-size:13px">${args.down.map(a => `<li>${a}</li>`).join('')}</ul></div><div><b style="color:var(--navy)">가격 방어 논거 (매도자용)</b><ul style="margin:6px 0 0 18px;padding:0;font-size:13px">${args.up.map(a => `<li>${a}</li>`).join('')}</ul></div></div>`)}`;
  }
  function negotiationArgs(ev, c) {
    const m = c.market; const down = [], up = [];
    down.push(`기준금리 ${pct(m.baseRate, 2)}·기업대출 ${pct(m.loanRateAvg, 2)}·국고채 10년 ${pct(m.riskFree, 2)} → 요구 환원율 상승${ev.askYield && !ev.noIncome ? `, 호가 NOI 수익률 ${pct(ev.askYield.noi, 1)}` : ''}`);
    if (ev.compsVal && ev.compsVal.bulkDiscount) down.push(`일괄매각 규모 할인 ${Math.round(ev.compsVal.bulkDiscount * 100)}% (소규모 구분상가 단가 대비, 사례 중앙 ${Math.round(ev.compsVal.medArea)}㎡)`);
    if (ev.timing) { const t28 = ev.timing.find(x => x.year === 2028), t27 = ev.timing.find(x => x.year === 2027); if (t28 && t27 && t28.tax > t27.tax) down.push(`2028년 비사업용 중과 20%p·장특공제 배제 → 매도자 세부담 +${eok(t28.tax - t27.tax)}`); }
    if (ev.riskDeduct) down.push(`리스크 해소 비용 ${eok(ev.riskDeduct)} (${c.risks.filter(r => r.deduct).map(r => r.label.split(' ')[0]).join('·')})`);
    if (ev.compsVal) down.push(`인근 실거래 하위 분위 ${eok(ev.compsVal.low)}`); if (ev.land && ev.land.unitQ.q25) down.push(`인근 실거래 25% 분위 ${fmt(ev.land.unitQ.q25)}/㎡`);
    if (ev.conversionLevy) down.push(`전용부담금 ${eok(ev.conversionLevy)} 매수자 부담`);
    up.push('2026 상반기 수도권 지가 +1.69%, 상업용 토지 +1.42% (국토부)'); up.push('수도권 물류·오피스 신규 공급 절벽, 핵심권역 오피스 공실 2~3%');
    if (ev.noi && ev.noi.rentY > 0) up.push(`임대 수입 연 ${eok(ev.noi.rentY)} · 보증금 ${eok(ev.noi.deposit)} 확보`); if (ev.compsVal) up.push(`인근 실거래 상위 분위 ${eok(ev.compsVal.high)}`); if (ev.land && ev.land.unitQ.q75) up.push(`인근 실거래 75% 분위 ${fmt(ev.land.unitQ.q75)}/㎡`);
    if (c.risks.filter(r => r.status === 'ok').length) up.push(`법률 체크 통과 ${c.risks.filter(r => r.status === 'ok').length}건 (${c.risks.filter(r => r.status === 'ok').map(r => r.label.split(' ')[0]).join('·')})`);
    return { down, up };
  }

  // ---------- 탭: 보고서 ----------
  const OUTLINES = {
    buy: [['결론 (1쪽)', '추천 등급 · 한 줄 결론 · WTP · 호가 괴리 · 조건'], ['물건 개요·임대 현황', '기본정보 · 장부 대조 · 렌트롤 · 공실'], ['시장·실거래', '채택 사례 · 분위 단가 · 금리·국채 · 공실률'], ['가치평가 5단 검증', 'Cap · NPV(WACC) · DSCR · 보유세 · 스프레드 · 민감도'], ['5·10년 현금흐름', '연도별 표 · 매각가 · IRR · 자본차익'], ['리스크·법률', '체크리스트 판정 · 감가 금액 · 조문 근거'], ['부록', '가정값 · 데이터 출처 · 기준일']],
    sell: [['결론 (1쪽)', '권장 호가 구간 · WTA · 예상 세후 순수입 · 매각 시점'], ['물건 개요·임대 현황', '동일'], ['시장·실거래', '상위 분위 사례 · 입지 근거'], ['세후 역산', '양도세 3열 · 양도 시점 시뮬레이션 · 사업용 전환 D-day'], ['비용·세무', '부가세·포괄양수도 · 중개비 · 전용부담금'], ['리스크·법률', '매각 전 해소 항목과 비용'], ['부록', '동일']],
    nego: [['ZOPA 요약 (1쪽)', '가격 축 · 괴리 · 추천 등급'], ['양측 결정', '매수자 결정 · 매도자 결정'], ['논거', '인하 논거 · 방어 논거 · 데이터 출처'], ['성사 시나리오', '조건 조합별 성사가']]
  };
  function renderReport() {
    const ol = k => `<div class="outline">${OUTLINES[k].map((o, i) => `<div class="it"><div class="n">${i + 1}</div><div><b>${o[0]}</b><small>${o[1]}</small></div></div>`).join('')}</div>`;
    const btns = k => `<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn ${k === 'buy' ? 'primary' : k === 'sell' ? 'gold' : ''}" onclick="App.previewReport('${k}')">미리보기</button><button class="btn" onclick="App.printReport('${k}')">PDF 저장 (새 창 인쇄)</button><button class="btn sm" onclick="App.downloadReport('${k}')">HTML 저장</button></div>`;
    const preview = state.reportHtml ? `<section class="card" id="preview"><h3>미리보기 — ${state.reportKind === 'buy' ? '매수 검토 보고서' : state.reportKind === 'sell' ? '매도 검토 보고서' : '협상 보고서'}<span class="r"><button class="btn sm primary" onclick="App.printReport('${state.reportKind}')">PDF 저장</button></span></h3><div class="rp" style="background:#fff;border:1px solid var(--line);padding:16px 20px;max-height:900px;overflow:auto">${state.reportHtml}</div></section>` : '';
    return `<div class="grid g3">${card('매수 검토 보고서 · 7부', ol('buy') + btns('buy'))}${card('매도 검토 보고서 · 7부', ol('sell') + btns('sell'))}${card('협상 보고서 · 4부 (양측 공유용)', ol('nego') + btns('nego'))}</div>${preview}
${card('출력 규칙', `<div class="muted">A4 · 네이비/골드 · 모든 금액 ₩ · 총합계 명시 · 결론 1쪽 · 작성자 ${esc(state.settings.author)} · 법령은 법제처 API 조회 기준일 표기. 인쇄 대화상자에서 "PDF로 저장"을 선택하세요. 배경 그래픽 인쇄를 켜면 색상이 유지됩니다.</div><div style="display:flex;gap:8px;margin-top:10px"><button class="btn" onclick="App.exportJson()">케이스 JSON 내보내기</button><button class="btn" onclick="App.syncPush()">PIN 동기화 저장</button></div>`)}`;
  }
  function buildReport(kind) {
    const c = state.current; const ev = evaluate(); if (!ev) return ''; const t = ev.type; const m = c.market; const today = new Date().toISOString().slice(0, 10); const z = ev.zopa; const g = ev.grade;
    const titles = { buy: '매수 검토 보고서', sell: '매도 검토 보고서', nego: '협상 보고서' };
    const kp = arr => `<div class="kpis">${arr.map(a => `<div><small>${a[0]}</small><b>${a[1]}</b></div>`).join('')}</div>`;
    const compsT = c.comps.filter(x => x.use !== false).length ? `<table><tr><th>소재지</th><th>용도</th><th>면적㎡</th><th>거래금액</th><th>단가/㎡</th><th>계약</th></tr>${c.comps.filter(x => x.use !== false).map(x => `<tr><td>${esc(x.addr)}</td><td>${esc(x.type)}</td><td>${x.area}</td><td>${fmt(x.price)}</td><td>${fmt(x.pricePerSqm)}</td><td>${esc(x.date)}</td></tr>`).join('')}</table>` : '<p class="small">채택 실거래 사례 없음</p>';
    const riskT = `<table><tr><th>항목</th><th>판정</th><th>확인 내용</th><th>감산</th><th>근거</th></tr>${c.risks.map(r => `<tr><td>${esc(r.label)}</td><td>${{ ok: '통과', warn: '주의', bad: '위험', na: '미확인' }[r.status]}</td><td>${esc(r.memo)}</td><td>${r.deduct ? fmt(r.deduct) : r.rate ? pct(r.rate, 0) : '—'}</td><td>${esc(r.law)}</td></tr>`).join('')}<tr><td colspan="3"><b>감산 총합계</b></td><td><b>${fmt(ev.riskDeduct)}</b></td><td></td></tr></table>`;
    const overview = `<h2 class="sec">2. 물건 개요${t.income ? '·임대 현황' : ''}</h2>${kp([['소재지', esc(c.address) || '—'], ...((c.parcels || []).filter(x => x.own).length > 1 ? [['구성 필지', (c.parcels.filter(x => x.own).length) + '필지 · ' + c.parcels.filter(x => x.own).map(x => esc((x.addr || '').split(' ').slice(-2).join(' ')) + (x.jimok ? '(' + esc(x.jimok) + ' ' + x.area + '㎡)' : '')).join(', ')]] : []), ['유형·용도지역', t.label + ' · ' + esc(c.zone)], ['대지면적', c.landArea + '㎡ (' + (c.landArea / 3.3058).toFixed(1) + '평)'], [t.income ? '연면적·준공' : '개별공시지가', t.income ? c.gfa + '㎡ · ' + esc(c.builtYear) : fmt(c.publicPricePerSqm) + '/㎡']])}
${t.income ? `<table><tr><th>층</th><th>임차인</th><th>보증금</th><th>월임대료</th><th>만료</th><th>상태</th></tr>${c.rentroll.map(r => `<tr><td>${esc(r.floor)}</td><td>${esc(r.tenant)}</td><td>${fmt(r.deposit)}</td><td>${fmt(r.rent)}</td><td>${esc(r.expiry)}</td><td>${r.vacant ? '공실' : '임대중'}</td></tr>`).join('')}<tr><td colspan="2"><b>총합계</b></td><td><b>${fmt(ev.noi.deposit)}</b></td><td><b>${fmt(ev.noi.rentY / 12)}</b></td><td colspan="2">GPI ${fmt(ev.noi.gpi)} · NOI ${fmt(ev.noi.noi)}</td></tr></table>` : `<p>${esc(c.notes)}</p>`}`;
    const market = `<h2 class="sec">3. 시장·실거래</h2>${kp([['기준금리', pct(m.baseRate, 2)], ['국고채 10년', pct(m.riskFree, 3)], ['미국채 10년', pct(m.us10y, 3)], ['시장 환원율', pct(m.marketCap, 1)]])}${compsT}${ev.compsVal ? `<p class="small">비준가액 25/50/75% 분위: ${fmt(ev.compsVal.low)} / ${fmt(ev.compsVal.mid)} / ${fmt(ev.compsVal.high)}</p>` : ''}${ev.land ? `<p class="small">단가 분위 25/50/75%: ${fmt(ev.land.unitQ.q25)} / ${fmt(ev.land.unitQ.q50)} / ${fmt(ev.land.unitQ.q75)} /㎡ · 공시지가 배율 ${ev.land.ratio.toFixed(2)}</p>` : ''}<p class="small">기준일 ${m.asOf} · 출처 ${esc(m.source)}</p>`;
    const risks = `<h2 class="sec">${kind === 'sell' ? '6. 리스크·법률 (매각 전 해소 항목)' : '6. 리스크·법률'}</h2>${riskT}<p class="small">조문은 법제처 국가법령정보 API(OC=yjjn2005) 조회 기준 ${C.LAW.asOf}.</p>`;
    const appendix = `<h2 class="sec">7. 부록 — 가정값·출처</h2><table><tr><th>항목</th><th>값</th></tr><tr><td>LTV / 금리 / 상환</td><td>${pct(c.ltv, 0)} / ${pct(c.loanRate, 2)} / ${c.interestOnly !== false ? '이자만' : '원리금균등 20년'}</td></tr>${t.income ? `<tr><td>공실률 / 운영경비율 / 보증금 운용 / NOI 성장</td><td>${pct(c.vacancy, 0)} / ${pct(c.opexRatio, 0)} / ${pct(c.depositYield, 1)} / ${pct(c.growth, 1)}</td></tr><tr><td>환원율 매수자/중립/매도자</td><td>${pct(ev.caps.buyer, 2)} / ${pct(ev.caps.neutral, 2)} / ${pct(ev.caps.seller, 2)}</td></tr><tr><td>WACC (Re/Rd)</td><td>${pct(ev.wacc.wacc, 2)} (${pct(ev.wacc.re, 1)} / ${pct(ev.wacc.rd, 1)})</td></tr>` : `<tr><td>지가 상승률 / 요구 상승률</td><td>${pct(c.landGrowth, 1)} / ${pct(ev.landRequired, 2)}</td></tr>`}<tr><td>ZOPA 가중치 / DSCR 기준</td><td>${state.settings.zopaWeight} / ${state.settings.dscrMin}</td></tr><tr><td>법령 기준일</td><td>${C.LAW.asOf} (법제처 API)</td></tr></table><p class="small">본 보고서는 입력 자료와 공개 데이터를 바탕으로 한 참고 자료이며, 세무·법률 사항은 거래 전 전문가 확인이 필요하다. 2026 세제개편안은 정부안 기준.</p>`;
    const cover = (sub) => `<div class="pg"><div class="cover"><div><div class="k">${titles[kind]}</div><h1>${esc(c.name)}</h1><h2>${sub}</h2><p>${esc(c.address)} · ${t.label} · 대지 ${c.landArea}㎡${t.income ? ' · 연면적 ' + c.gfa + '㎡' : ''}</p></div><div class="small">작성일 ${today} · 작성자 ${esc(state.settings.author)} · deal-check</div></div></div>`;
    let body = '';
    if (kind === 'buy') {
      body = cover('매수자 입장 — 합리적 매수가와 5·10년 현금흐름') + `<div class="pg"><h2 class="sec">1. 결론</h2>
<div class="conc"><b>추천 등급 ${g.grade} — ${g.label}.</b> 매수자 최대 지불 가능 금액(WTP)은 <b>${fmt(ev.wtp)}</b>이며, 호가 ${fmt(c.ask)} 대비 ${c.ask ? pct((ev.wtp - c.ask) / c.ask, 1) : '—'}이다. ${z.hasZone ? `매도자 하한 ${fmt(ev.wtaFinal)}과 거래성사 가능 구간이 형성되며 추천 성사가는 ${fmt(z.recommended)}이다.` : `매도자 하한 ${fmt(ev.wtaFinal)}과 ${fmt(z.gap)} 괴리가 있어 조건 교환 없이는 성사가 어렵다.`}</div>
${kp(t.income && ev.noIncome ? [['실거래 비준 25% 분위', fmt(ev.compsVal ? ev.compsVal.low : 0)], ['중앙값 / 75% 분위', ev.compsVal ? eok(ev.compsVal.mid) + ' / ' + eok(ev.compsVal.high) : '—'], ['비준 기준', ev.compsVal ? esc(ev.compsVal.basis) : '사례 없음'], ['채택 사례', c.comps.filter(x => x.use !== false).length + '건'], ['매각(전용)면적', (c.exclusiveArea || c.gfa) + '㎡'], ['전용 ㎡당 호가', c.ask && (c.exclusiveArea || c.gfa) ? fmt(c.ask / (c.exclusiveArea || c.gfa)) : '—'], ['보유세(연)', fmt(ev.holdingTax.total)], ['취득세', fmt(ev.acqTax.total)]] : t.income ? [['NOI', fmt(ev.noi.noi)], ['수익환원(매수자 ' + pct(ev.caps.buyer, 1) + ')', fmt(ev.value.buyer)], ['NPV 최대지불(WACC ' + pct(ev.wacc.wacc, 2) + ')', fmt(ev.npv.maxPrice)], ['DSCR', ev.dscr.toFixed(2)], ['세전 IRR 10년', pct(ev.cf10.irr, 2)], ['국고채 대비 스프레드', pp(ev.spread)], ['보유세(연)', fmt(ev.holdingTax.total)], ['취득세', fmt(ev.acqTax.total)]] : [['실거래 하위 분위', fmt(ev.land.byComps.low)], ['공시지가 배율법', fmt(ev.land.byRatio)], ['규제 감가', pct(ev.land.discountRate, 0)], ['전용부담금', fmt(ev.conversionLevy)], ['10년 IRR', pct(ev.cf10.irr, 2)], ['스프레드', pp(ev.spread)], ['보유세(연)', fmt(ev.holdingTax.total)], ['취득세', fmt(ev.acqTax.total)]])}
<h3>매수자 결정</h3>${decisionBuyer(ev, c).replace(/class="pill [a-z]+"/g, 'style="font-weight:700;color:#0F2544"')}</div>
<div class="pg">${overview}${market}</div>
<div class="pg"><h2 class="sec">4. 가치평가 ${t.income && ev.noIncome ? '— 실거래 비준(임대료 미입력)' : '5단 검증'}</h2>${t.income && ev.noIncome ? `<p>임대료가 브로셔에 없어 수익환원·현금흐름은 산출하지 않고, 인근 실거래의 ${esc(ev.compsVal ? ev.compsVal.basis : '')}로 가격을 산정했다. 시장 임대료를 입력하면 5단 검증이 추가된다.</p><table><tr><th>구분</th><th>금액</th></tr><tr><td>25% 분위 (매수자 상한 기준)</td><td>${fmt(ev.compsVal ? ev.compsVal.low : 0)}</td></tr><tr><td>중앙값 (적정가)</td><td>${fmt(ev.compsVal ? ev.compsVal.mid : 0)}</td></tr><tr><td>75% 분위</td><td>${fmt(ev.compsVal ? ev.compsVal.high : 0)}</td></tr><tr><td>리스크 감산</td><td>${fmt(ev.riskDeduct)}</td></tr><tr><td><b>WTP 총합계</b></td><td><b>${fmt(ev.wtp)}</b></td></tr></table>` : t.income ? `<table><tr><th>단계</th><th>결과</th><th>설명</th></tr><tr><td>① 수익환원</td><td>${fmt(ev.value.buyer)}</td><td>NOI ${fmt(ev.noi.noi)} ÷ ${pct(ev.caps.buyer, 2)} (국고채 ${pct(m.riskFree, 2)} + 프리미엄 − g); 중립 ${fmt(ev.value.neutral)}, 매도자 ${fmt(ev.value.seller)}</td></tr><tr><td>② NPV(WACC)</td><td>${fmt(ev.npv.maxPrice)}</td><td>10년 NOI·매각 현금흐름을 WACC ${pct(ev.wacc.wacc, 2)}로 할인, NPV=0 투자원금(취득비 공제)</td></tr><tr><td>③ DSCR</td><td>${ev.dscr.toFixed(2)} (${C.dscrGrade(ev.dscr)})</td><td>NOI−보유세 ÷ 원리금(20년 균등) · 이자만 상환 시 ${ev.dscrIO.toFixed(2)}</td></tr><tr><td>④ 보유세</td><td>${fmt(ev.holdingTax.total)}/년</td><td>재산세 ${fmt(ev.holdingTax.propertyTax)} · 도시지역분·교육세 ${fmt(ev.holdingTax.urbanTax + ev.holdingTax.eduTax)} · 종부세 ${fmt(ev.holdingTax.cpt)}</td></tr><tr><td>⑤ 무위험 비교</td><td>${pp(ev.spread)}</td><td>세전 IRR ${pct(ev.cf10.irr, 2)} − 국고채 ${pct(m.riskFree, 2)} · 미국채 ${pct(m.us10y, 2)}(헤지 후 약 ${pct(m.us10y - (m.us2y - m.kr2y), 2)})</td></tr></table>
<h3>민감도 (환원율 × 공실률 → 수익가액)</h3><table><tr><th>환원율</th><th>5%</th><th>10%</th><th>15%</th><th>20%</th></tr>${ev.sensitivity.map(r => `<tr><td>${pct(r.cap, 1)}</td>${r.cells.map(x => `<td>${fmt(x.value)}</td>`).join('')}</tr>`).join('')}</table>` : `<table><tr><th>방법</th><th>결과</th><th>설명</th></tr><tr><td>실거래 비준</td><td>${fmt(ev.land.byComps.low)} ~ ${fmt(ev.land.byComps.high)}</td><td>25~75% 분위 단가 × ${c.landArea}㎡</td></tr><tr><td>공시지가 배율</td><td>${fmt(ev.land.byRatio)}</td><td>배율 ${ev.land.ratio.toFixed(2)}</td></tr><tr><td>개발가치 상한</td><td>${ev.land.devCap ? fmt(ev.land.devCap) : '—'}</td><td>용적률·단가 입력 시</td></tr><tr><td>규제 감가</td><td>${pct(ev.land.discountRate, 0)}</td><td>맹지·농업진흥·보전산지 등</td></tr><tr><td>전용부담금</td><td>${fmt(ev.conversionLevy)}</td><td>${c.type === 'farm' ? '농지보전부담금(공시지가 30%, ㎡당 상한 ₩50,000)' : '산림청 고시 단가'}</td></tr></table>`}
<h2 class="sec">5. ${t.income ? '5·10년 현금흐름' : '보유 시나리오'}</h2>${t.income && ev.noIncome ? '<p class="small">임대료 입력 후 산출.</p>' : t.income ? `<table><tr><th>년</th><th>NOI</th><th>원리금</th><th>현금흐름</th><th>매각 순수입</th><th>누적</th></tr>${ev.cf10.rows.map(r => `<tr><td>${r.year}</td><td>${fmt(r.noi)}</td><td>${fmt(r.interest + r.principal)}</td><td>${fmt(r.cf - (r.saleNet || 0))}</td><td>${r.sale ? fmt(r.saleNet) : '—'}</td><td>${fmt(r.cum)}</td></tr>`).join('')}</table>${kp([['자기자본', fmt(ev.cf10.equity)], ['10년차 매각가', fmt(ev.cf10.salePrice)], ['자본차익', fmt(ev.cf10.capitalGain)], ['IRR 10년 / 5년', pct(ev.cf10.irr, 2) + ' / ' + pct(ev.cf5.irr, 2)]])}` : `<table><tr><th>보유</th><th>투입</th><th>매각가</th><th>자본차익</th><th>보유세 누계</th><th>IRR</th></tr><tr><td>5년</td><td>${fmt(ev.cf5.equity)}</td><td>${fmt(ev.cf5.sale)}</td><td>${fmt(ev.cf5.capitalGain)}</td><td>${fmt(ev.cf5.holdTax)}</td><td>${pct(ev.cf5.irr, 2)}</td></tr><tr><td>10년</td><td>${fmt(ev.cf10.equity)}</td><td>${fmt(ev.cf10.sale)}</td><td>${fmt(ev.cf10.capitalGain)}</td><td>${fmt(ev.cf10.holdTax)}</td><td>${pct(ev.cf10.irr, 2)}</td></tr></table>`}</div>
<div class="pg">${risks}${appendix}</div>`;
    } else if (kind === 'sell') {
      const s = c.seller; const st = ev.sellerTax; const base = c.ask || ev.sellerFair; const ap = st ? ((t.income || ev.judgement.business) ? st.biz : st.now) : null;
      body = cover('매도자 입장 — 적정 매도가와 세후 순수입') + `<div class="pg"><h2 class="sec">1. 결론</h2>
<div class="conc"><b>권장 호가 구간 ${fmt(ev.sellerFair * 0.98)} ~ ${fmt(ev.sellerFair * 1.03)}.</b> 매도자 최소 수용 금액(WTA)은 <b>${fmt(ev.wtaFinal)}</b>, 적정 매도가는 ${fmt(ev.sellerFair)}이다. ${st ? `기준가 ${fmt(base)} 매도 시 양도세(${(t.income || ev.judgement.business) ? '사업용' : '비사업용·현행'}) ${fmt(ap.total)}, 세후 순수입 약 ${fmt(base - ap.total - base * s.sellCostRate - (s.vat || 0))}.` : ''} ${z.hasZone ? `매수자 상한 ${fmt(ev.wtp)}과 성사 구간이 형성되며 추천 성사가 ${fmt(z.recommended)}.` : `매수자 상한 ${fmt(ev.wtp)}과 ${fmt(z.gap)} 괴리.`}</div>
${st ? kp([['양도차익', fmt(st.now.gain)], ['양도세 사업용', fmt(st.biz.total)], ['비사업용 현행', fmt(st.now.total)], ['비사업용 2028~', fmt(st.reform.total)]]) : '<p class="small">취득 정보 미입력</p>'}
<h3>매도자 결정</h3>${s.acquiredPrice ? decisionSeller(ev, c).replace(/class="pill [a-z]+"/g, 'style="font-weight:700;color:#0F2544"') : ''}</div>
<div class="pg">${overview}${market}</div>
<div class="pg"><h2 class="sec">4. 세후 역산·양도세</h2>${st ? `<table><tr><th>경로</th><th>공제</th><th>과세표준</th><th>세액(지방세 포함)</th><th>실효</th></tr><tr><td>사업용</td><td>장특공제 ${pct(st.biz.ltRate, 0)}</td><td>${fmt(st.biz.taxable)}</td><td>${fmt(st.biz.total)}</td><td>${pct(st.biz.effective, 1)}</td></tr><tr><td>비사업용 · 현행</td><td>장특공제 ${pct(st.now.ltRate, 0)}</td><td>${fmt(st.now.taxable)}</td><td>${fmt(st.now.total)}</td><td>${pct(st.now.effective, 1)}</td></tr><tr><td>비사업용 · 2028.1.1~</td><td>장특공제 배제</td><td>${fmt(st.reform.taxable)}</td><td>${fmt(st.reform.total)}</td><td>${pct(st.reform.effective, 1)}</td></tr></table>
<h3>양도 시점 시뮬레이션</h3><table><tr><th>시점</th><th>판정</th><th>세액</th><th>세후 순수입</th></tr>${ev.timing.map(x => `<tr><td>${x.label}</td><td>${x.business ? '사업용' : '비사업용'}</td><td>${fmt(x.tax)}</td><td>${fmt(x.net)}</td></tr>`).join('')}</table><p class="small">판정 근거: ${ev.judgement.basis}${ev.judgement.business ? '' : ' · 사업용 전환까지 D-' + ev.judgement.daysToBiz + '일'}</p>` : ''}
<h2 class="sec">5. 비용·세무</h2>${kp([['중개·법무', fmt(base * s.sellCostRate)], ['부가세(건물분)', fmt(s.vat || 0)], ['매수자 취득세', fmt(ev.acqTax.total)], ['전용부담금(매수자)', fmt(ev.conversionLevy || 0)]])}<p class="small">매각대금 국채 운용 시 연 ${fmt((base - (ap ? ap.total : 0)) * m.riskFree)} (국고채 ${pct(m.riskFree, 2)}) vs 보유 ${ev.noi ? 'NOI ' + fmt(ev.noi.noi) : '지가상승 ' + pct(c.landGrowth, 1)}.</p></div>
<div class="pg">${risks}${appendix}</div>`;
    } else {
      const a = negotiationArgs(ev, c);
      body = cover('거래성사 가능 구간과 양측 결정') + `<div class="pg"><h2 class="sec">1. ZOPA 요약</h2>${kp([['매수자 상한 WTP', fmt(ev.wtp)], ['매도자 하한 WTA', fmt(ev.wtaFinal)], ['호가 / 매도 희망 / 매수 희망', `${eok(c.ask)} / ${eok(c.sellerHope)} / ${eok(c.buyerHope)}`], ['추천 등급', g.grade + ' · ' + g.label]])}
<div class="conc">${z.hasZone ? `<b>ZOPA 형성</b> ${fmt(z.zone.low)} ~ ${fmt(z.zone.high)} · 추천 성사가 <b>${fmt(z.recommended)}</b>` : `<b>ZOPA 미형성</b> — 괴리 ${fmt(z.gap)} (${pct(z.gapPct, 0)}) · 조건 교환 시 중간값 ${fmt(z.recommended)}`}</div>
<h2 class="sec">2. 양측 결정</h2><h3>매수자</h3>${decisionBuyer(ev, c).replace(/class="pill [a-z]+"/g, 'style="font-weight:700;color:#0F2544"')}<h3>매도자</h3>${c.seller.acquiredPrice ? decisionSeller(ev, c).replace(/class="pill [a-z]+"/g, 'style="font-weight:700;color:#0F2544"') : '<p class="small">취득 정보 미입력</p>'}</div>
<div class="pg"><h2 class="sec">3. 논거</h2><h3>가격 인하 논거 (매수자용)</h3><ul>${a.down.map(x => `<li>${x}</li>`).join('')}</ul><h3>가격 방어 논거 (매도자용)</h3><ul>${a.up.map(x => `<li>${x}</li>`).join('')}</ul>
<h2 class="sec">4. 성사 시나리오</h2><table><tr><th>시나리오</th><th>매수자 상한</th><th>매도자 하한</th><th>성사가</th></tr><tr><td>현재 조건</td><td>${fmt(ev.wtp)}</td><td>${fmt(ev.wtaFinal)}</td><td>${fmt(z.recommended)}</td></tr><tr><td>리스크 비용 매도자 부담</td><td>${fmt(ev.wtp + ev.riskDeduct)}</td><td>${fmt(ev.wtaFinal)}</td><td>${fmt(C.zopa({ wtp: ev.wtp + ev.riskDeduct, wta: ev.wtaFinal, weight: state.settings.zopaWeight }).recommended)}</td></tr>${ev.timing ? `<tr><td>2027년 내 매각(세부담 반영)</td><td>${fmt(ev.wtp)}</td><td>${fmt(Math.max(ev.wtaFinal - Math.max(0, (ev.timing.find(x => x.year === 2028) || {}).tax - (ev.timing.find(x => x.year === 2027) || {}).tax) * 0.4, ev.wtp * 0.9))}</td><td>${fmt(C.zopa({ wtp: ev.wtp, wta: Math.max(ev.wtaFinal - Math.max(0, (ev.timing.find(x => x.year === 2028) || {}).tax - (ev.timing.find(x => x.year === 2027) || {}).tax) * 0.4, ev.wtp * 0.9), weight: state.settings.zopaWeight }).recommended)}</td></tr>` : ''}</table>${risks}${appendix}</div>`;
    }
    return body + `<div class="foot">${esc(state.settings.author)} · deal-check · ${today}</div>`;
  }
  const REPORT_CSS = `body{margin:0;font-family:'Malgun Gothic','Noto Sans KR',sans-serif;color:#222;font-size:10pt;line-height:1.5;background:#fff}
.rp .pg{page-break-after:always;padding:0}.rp .pg:last-child{page-break-after:auto}
.rp .cover{border-top:10px solid #0F2544;border-bottom:3px solid #C6A15B;padding:40mm 0 10mm;min-height:250mm;display:flex;flex-direction:column;justify-content:space-between}
.rp .cover .k{color:#C6A15B;font-weight:700;letter-spacing:2px;font-size:11pt}.rp .cover h1{font-family:'Noto Serif KR',serif;font-size:24pt;color:#0F2544;margin:8px 0 4px}.rp .cover h2{font-size:13pt;color:#444;font-weight:400;margin:0 0 16px}
.rp h2.sec{font-size:14pt;color:#fff;background:#0F2544;padding:5px 12px;margin:14px 0 8px;border-left:8px solid #C6A15B}.rp h3{font-size:11pt;color:#0F2544;border-bottom:1.5px solid #C6A15B;padding-bottom:2px;margin:12px 0 6px}
.rp table{font-size:9pt;margin:4px 0 8px;border-collapse:collapse;width:100%}.rp th{background:#0F2544;color:#fff;padding:4px 6px;border:0;text-align:left}.rp td{padding:4px 6px;border-bottom:1px solid #ddd;vertical-align:top}
.rp .conc{border-left:6px solid #C6A15B;background:#f6f4ef;padding:8px 12px;margin:6px 0}.rp .conc b{color:#0F2544}.rp .box{border:1px solid #C6A15B;background:#fbf8f1;padding:8px 12px;margin:6px 0}
.rp .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:6px 0}.rp .kpis div{border:1px solid #ddd;padding:6px 8px;border-radius:4px}.rp .kpis div small{display:block;color:#666;font-size:8pt}.rp .kpis div b{font-size:12pt;color:#0F2544}
.rp .small{font-size:8.5pt;color:#555}.rp .foot{font-size:8pt;color:#777;text-align:center;margin-top:12px}.rp .dec .t{font-family:'Noto Serif KR',serif;font-size:13pt;font-weight:700;color:#0F2544;margin:4px 0}.rp .dec .row{display:flex;gap:8px;margin:3px 0}.rp .dec .no{color:#C6A15B;font-weight:700}
.rp ul{margin:4px 0 8px 18px;padding:0}
@page{size:A4;margin:16mm 14mm}
.toolbar{position:sticky;top:0;background:#0F2544;color:#fff;padding:10px 16px;display:flex;gap:10px;align-items:center;font-size:13px;z-index:9}.toolbar button{height:38px;padding:0 16px;border:0;border-radius:6px;background:#C6A15B;color:#0F2544;font-weight:700;font-family:inherit;cursor:pointer}.toolbar span{opacity:.8}
@media print{.toolbar{display:none !important}}
.sheet{max-width:210mm;margin:0 auto;padding:12mm 10mm;background:#fff}`;
  function reportDocument(kind, html) {
    const title = `${state.current.name} ${kind === 'buy' ? '매수 검토 보고서' : kind === 'sell' ? '매도 검토 보고서' : '협상 보고서'}`;
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@500;700&family=Noto+Sans+KR:wght@400;500;700&display=swap"><style>${REPORT_CSS}</style></head><body><div class="toolbar"><button onclick="window.print()">PDF 저장 / 인쇄</button><span>${esc(title)} · 인쇄 대화상자에서 "PDF로 저장" 선택 · 배경 그래픽 켜기</span><button onclick="window.close()" style="margin-left:auto;background:#fff">닫기</button></div><div class="sheet rp">${html}</div></body></html>`;
  }
  function printReport(kind) {
    const html = buildReport(kind); if (!html) { toast('보고서를 만들 수 없습니다 — 입력을 확인하세요'); return; }
    state.reportKind = kind; state.reportHtml = html;
    // 1) 새 창에 보고서 문서를 열어 인쇄 (화면에서도 내용이 보임)
    let w = null; try { w = window.open('', '_blank'); } catch (e) { }
    if (w && w.document) { w.document.open(); w.document.write(reportDocument(kind, html)); w.document.close(); w.focus(); setTimeout(() => { try { w.print(); } catch (e) { } }, 700); return; }
    // 2) 팝업 차단 시: 앱 안에서 미리보기로 전환
    state.tab = 'report'; render(); toast('팝업이 차단되어 미리보기로 표시합니다 — 아래 "PDF 저장" 버튼을 누르세요');
    const r = $('#report'); r.innerHTML = html; setTimeout(() => window.print(), 300);
  }
  function previewReport(kind) { state.reportKind = kind; state.reportHtml = buildReport(kind); render(); const el = $('#preview'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }
  function downloadReport(kind) { const html = buildReport(kind); const blob = new Blob([reportDocument(kind, html)], { type: 'text/html;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${state.current.name}_${kind === 'buy' ? '매수검토' : kind === 'sell' ? '매도검토' : '협상'}보고서.html`; a.click(); toast('HTML 파일로 저장했습니다 — 브라우저에서 열어 PDF로 인쇄 가능'); }

  // ---------- 탭: 설정 ----------
  function renderSettings() {
    const s = state.settings; const list = state.cases.map(c => `<tr><td>${c.id === state.current.id ? '●' : ''}</td><td>${esc(c.name)}</td><td>${C.TYPES[c.type].label}</td><td>${eok(c.ask)}</td><td>${(c.created || '').slice(0, 10)}</td><td><button class="btn sm" onclick="App.openCase('${c.id}')">열기</button> <button class="btn sm" onclick="App.dupCase('${c.id}')">복제</button> <button class="btn sm" onclick="App.delCase('${c.id}')">삭제</button></td></tr>`).join('');
    const laws = [['소득세법', '104의3'], ['소득세법', '104'], ['소득세법', '95'], ['소득세법 시행령', '168의6'], ['소득세법 시행령', '168의8'], ['소득세법 시행령', '168의11'], ['법인세법', '55의2'], ['지방세법', '11'], ['지방세법', '13'], ['상가건물 임대차보호법', '10'], ['상가건물 임대차보호법 시행령', '2'], ['농지법', '8'], ['농지법', '38'], ['농지법', '63'], ['건축법', '44']];
    return `<div class="grid g2">
${card('동기화 · 서버', `<div class="fgrid g2">${field('deal-check Worker 주소(비밀키 서버)', 'workerUrl', s.workerUrl)}${field('동기화 PIN (4~8자리)', 'pin', s.pin)}</div><div class="muted" style="margin-top:6px">${state.workerOk ? pill('전용 서버 연결됨', 'ok') : pill('전용 서버 미배포 — 아래 공공데이터 설정으로 동작', 'warn')}</div><div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm primary" onclick="App.syncPush()">서버에 저장</button><button class="btn sm" onclick="App.syncPull()">서버에서 불러오기</button><button class="btn sm" onclick="App.ping()">연결 확인</button></div><div class="muted" style="margin-top:8px">같은 PIN을 입력한 모든 기기에서 케이스가 공유됩니다 (Cloudflare KV).</div>`)}
${card('공공데이터 연동 (yjjn2005.github.io 전체 앱 공용 설정 — 한 번만 입력)', `<div class="fgrid g2">${field('공공데이터포털 서비스키 (상업업무용·공장창고 실거래, 건축물대장)', 'dataKey', s.dataKey)}${field('범용 프록시 (ynk-data-proxy)', 'proxyUrl', s.proxyUrl)}${field('토지 실거래·브이월드 서버 (land-check-api)', 'landApi', s.landApi)}${field('브이월드 개발키', 'vworldKey', s.vworldKey)}</div><div class="muted" style="margin-top:8px">토지 실거래와 토지이용·공시지가는 기존 land-check-api·브이월드로 키 입력 없이 조회됩니다. 상업업무용·공장창고 실거래와 건축물대장은 공공데이터포털 서비스키(realestate-tax-suite·sinhonjip-app에서 쓰던 키)를 한 번 입력하면 이 기기에 저장되어 ynk-data-proxy로 조회합니다. 이 설정은 공용 저장소(ynk_public_api)에 저장되어 같은 주소(yjjn2005.github.io)의 모든 앱이 함께 씁니다. Worker 비밀값에 키가 등록되면(상태: ${state.workerKeys && state.workerKeys.datagokr ? pill('서버 키 있음', 'ok') : pill('서버 키 없음', 'warn')}) 클라이언트 키 없이 서버가 처리합니다.</div>`)}
${card('기본 가정값', `<div class="fgrid g3">${field('프리미엄 오피스·빌딩', 'premium.income', s.premium.income, 'pct')}${field('프리미엄 상가·물류·공장', 'premium.retail', s.premium.retail, 'pct')}${field('프리미엄 토지(요구 상승률)', 'premium.land', s.premium.land, 'pct')}${field('자기자본 프리미엄(Re)', 'equityPremium', s.equityPremium, 'pct')}${field('ZOPA 가중치(매수자 우위)', 'zopaWeight', s.zopaWeight, 'num')}${field('매도 희망가 가산율(호가 대비)', 'hopeMarkup', s.hopeMarkup ?? 0.20, 'pct')}${field('DSCR 최소 기준', 'dscrMin', s.dscrMin, 'num')}${field('보고서 작성자', 'author', s.author)}</div>`)}
</div>
${card('케이스 관리', `<table><thead><tr><th></th><th>이름</th><th>유형</th><th>호가</th><th>생성</th><th></th></tr></thead><tbody>${list}</tbody></table><div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn sm primary" onclick="App.newCase()">새 물건 입력</button><button class="btn sm" onclick="App.exportJson()">JSON 내보내기</button><label class="btn sm" for="imp">JSON 가져오기</label><input id="imp" type="file" accept="application/json" style="display:none"><button class="btn sm" onclick="App.loadWulsan()">월산리 20-5 케이스 만들기</button><button class="btn sm" onclick="App.loadSample()">근생빌딩 예시 만들기</button></div>`)}
${card('법령 근거 조회 (법제처 국가법령정보 API · Worker /law)', `<div style="display:flex;gap:6px;flex-wrap:wrap">${laws.map(l => `<button class="btn sm chip" onclick="App.law('${l[0]}','${l[1]}')">${l[0]} §${l[1]}</button>`).join('')}</div><div id="lawbox" style="margin-top:12px;font-size:12.5px;white-space:pre-wrap;max-height:360px;overflow:auto;background:var(--ivory);border-radius:8px;padding:12px">${esc(state.lawText || '조문 버튼을 누르면 현행 원문과 시행일자를 표시합니다. 앱 내 세율 파라미터 기준일: ' + C.LAW.asOf)}</div>`)}`;
  }
  function afterSettings(root) { bindInputs(root, state.settings, k => { renderSide(); if (['workerUrl', 'proxyUrl', 'landApi', 'dataKey', 'vworldKey'].includes(k)) { try { const sh = JSON.parse(localStorage.getItem('ynk_public_api') || '{}'); sh[k] = state.settings[k]; localStorage.setItem('ynk_public_api', JSON.stringify(sh)); } catch (e) { } } }); const imp = root.querySelector('#imp'); if (imp) imp.addEventListener('change', async () => { try { const j = JSON.parse(await imp.files[0].text()); const arr = Array.isArray(j) ? j : [j]; arr.forEach(c => { c.id = 'c' + Date.now() + Math.random().toString(36).slice(2, 6); initRisks(c); state.cases.push(c); }); state.current = state.cases[state.cases.length - 1]; save(); render(); toast('가져오기 완료'); } catch (e) { toast('JSON 오류'); } }); }

  // ---------- Worker 연동 ----------
  const api = async (path, opts) => { const u = state.settings.workerUrl.replace(/\/$/, ''); if (!u) throw new Error('Worker 주소 없음'); const r = await fetch(u + path, opts); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
  async function fetchStats() { try { toast('시장 데이터 조회 중…'); const j = await api('/stats'); Object.assign(state.current.market, j, { source: 'Worker(ECOS·R-ONE·미국채) ' + (j.asOf || '') }); save(); render(); toast('갱신 완료'); } catch (e) { toast('실패: ' + e.message); } }
  // ---------- 공공데이터 다중 소스 레이어 ----------
  // 우선순위: ① deal-check-api(비밀키 서버) ② 기존 전용 서버(land-check-api 토지실거래·브이월드, ynk-data-proxy 범용 프록시 + 앱 설정 서비스키) ③ 브라우저 직접(JSONP)
  const RTMS_SVC = { nrg: 'RTMSDataSvcNrgTrade', land: 'RTMSDataSvcLandTrade', indu: 'RTMSDataSvcInduTrade' };
  const ymList = n => { const out = []; const d = new Date(); for (let i = 0; i < n; i++) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(x.getFullYear() + String(x.getMonth() + 1).padStart(2, '0')); } return out; };
  function parseXmlItems(xml) { const doc = new DOMParser().parseFromString(xml, 'text/xml'); const err = doc.querySelector('errMsg,resultMsg'); const code = doc.querySelector('resultCode,returnReasonCode'); if (code && !/^0+$/.test(code.textContent.trim()) && code.textContent.trim() !== '00') throw new Error((err && err.textContent.trim()) || '응답 오류'); return Array.from(doc.querySelectorAll('item')).map(it => { const o = {}; Array.from(it.children).forEach(ch => o[ch.tagName] = ch.textContent.trim()); return o; }); }
  const won = v => parseInt(String(v || '0').replace(/[^\d]/g, ''), 10) * 10000;
  function normRtms(it, kind) {
    const area = parseFloat(String(kind === 'land' ? (it.dealArea || it.plottageAr) : (it.plottageAr || it.dealArea || it.buildingAr || 0)).replace(/,/g, '')) || 0;
    const bld = parseFloat(String(it.buildingAr || 0).replace(/,/g, '')) || 0;
    return { addr: [it.umdNm, it.jibun].filter(Boolean).join(' '), type: [it.buildingUse || it.jimok, it.buildingType, it.landUse].map(x => (x || '').trim()).filter(Boolean).join('·'), area, bldgArea: bld, price: won(it.dealAmount), pricePerSqm: area ? Math.round(won(it.dealAmount) / area) : 0, pricePerSqmBldg: bld ? Math.round(won(it.dealAmount) / bld) : 0, date: `${it.dealYear}-${String(it.dealMonth).padStart(2, '0')}`, built: it.buildYear || '', floor: it.floor || '', dealType: it.dealingGbn || '', use: true, auto: true, cancelled: /O/.test(it.cdealType || '') };
  }
  async function fetchText(url, ms) { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 20000); try { const r = await fetch(url, { signal: ctl.signal }); const txt = await r.text(); if (!r.ok && !/<item>/.test(txt)) throw new Error('HTTP ' + r.status); return txt; } finally { clearTimeout(t); } }
  async function rtmsMonth(lawd, kind, ym) {
    const S = state.settings; const errs = [];
    // ① 전용 서버(deal-check-api)
    if (S.workerUrl && state.workerOk && state.workerKeys && state.workerKeys.datagokr) { try { const j = await (await fetch(`${S.workerUrl.replace(/\/$/, '')}/rtms?lawd=${lawd}&kind=${kind}&months=1&ym=${ym}`)).json(); if (j.items) return j.items.map(x => Object.assign(x, { use: true, auto: true, pricePerSqm: x.area ? Math.round(x.price / x.area) : 0, pricePerSqmBldg: x.bldgArea ? Math.round(x.price / x.bldgArea) : 0 })); } catch (e) { errs.push('api:' + e.message); } }
    // ② 토지는 land-check-api(키 내장) 
    if (kind === 'land' && S.landApi) { try { const j = await (await fetch(`${S.landApi.replace(/\/$/, '')}/molit/land-trade?areaCd=${lawd}&dealYmd=${ym}&numOfRows=999`)).json(); if (j.items) return j.items.map(it => normRtms(it, 'land')); } catch (e) { errs.push('land-check-api:' + e.message); } }
    // ③ 범용 프록시 + 서비스키 / ④ 직접 호출
    if (S.dataKey) {
      const key = /%[0-9A-F]{2}/i.test(S.dataKey) ? S.dataKey : encodeURIComponent(S.dataKey);
      const url = `https://apis.data.go.kr/1613000/${RTMS_SVC[kind]}/get${RTMS_SVC[kind]}?serviceKey=${key}&LAWD_CD=${lawd}&DEAL_YMD=${ym}&numOfRows=999&pageNo=1`;
      const tries = [S.proxyUrl ? S.proxyUrl.replace(/\/$/, '') + '/?url=' + encodeURIComponent(url) : null, url].filter(Boolean);
      for (const u of tries) { try { const xml = await fetchText(u); return parseXmlItems(xml).map(it => normRtms(it, kind)); } catch (e) { errs.push('proxy:' + e.message); } }
    } else if (kind !== 'land') errs.push('설정에 공공데이터포털 서비스키를 입력하면 상업업무용·공장창고 실거래를 조회합니다');
    throw new Error(errs.join(' / '));
  }
  async function fetchRtms() {
    const c = state.current; if (!c.lawd) { toast('시군구코드를 입력하세요 (주소 조회 시 자동)'); return; }
    const kind = c.rtmsKind || (C.TYPES[c.type].income ? 'nrg' : 'land'); const months = Math.min(36, c.rtmsMonths || 12);
    state.rtmsStatus = '조회 중… 0/' + months; render();
    const all = []; let fails = 0, lastErr = ''; const yms = ymList(months);
    for (let i = 0; i < yms.length; i += 6) { const batch = yms.slice(i, i + 6); const rs = await Promise.allSettled(batch.map(ym => rtmsMonth(c.lawd, kind, ym))); rs.forEach(r => { if (r.status === 'fulfilled') all.push(...r.value.filter(x => !x.cancelled && x.price > 0)); else { fails++; lastErr = r.reason && r.reason.message || ''; } }); const el = $('#rtms-status'); if (el) el.textContent = `조회 중… ${Math.min(i + 6, yms.length)}/${yms.length}개월 · ${all.length}건`; if (fails >= 6 && all.length === 0) break; }
    // 유사사례 우선 정렬: 같은 읍면동 → 용도지역 일치 → 최근순
    const dong = (c.address.match(/([가-힣]+(?:읍|면|동|리))/g) || []).pop() || '';
    const fm = (c.scopeNote || '').match(/(\d+)\s*[~∼-]?\s*(\d+)?\s*층/); const tf = fm ? parseInt(fm[1], 10) : 0; const fl = x => parseInt(String(x.floor || '').replace(/[^\d-]/g, ''), 10);
    const floorOk = x => { if (c.saleScope !== 'part' || !tf) return true; const f = fl(x); if (isNaN(f)) return tf < 3; return tf >= 3 ? f >= 3 : f <= 2; };
    const subjArea = C.TYPES[c.type].land ? (c.landArea || 0) : (c.saleScope === 'part' ? (c.exclusiveArea || 0) : (c.landArea || 0));
    const minArea = Math.max(30, subjArea * 0.1), maxArea = subjArea ? subjArea * 10 : Infinity;
    const sizeOk = x => { const ar = (C.TYPES[c.type].income && c.saleScope === 'part') ? (x.bldgArea || x.area) : x.area; return !ar || (ar >= minArea && ar <= maxArea); };
    const jimokOk = x => !/도로|구거|하천|제방|묘지|유지/.test(x.type || '');
    const jimokSame = x => c.jimok ? (x.type || '').startsWith(c.jimok) : true;
    const zf = (c.zoneFilter || '').split(/[,·/]/).map(s => s.replace(/\s|지역$/g, '')).filter(Boolean);
    const zoneOk = x => !zf.length || zf.some(z => (x.type || '').replace(/\s/g, '').includes(z));
    const sc = x => (zoneOk(x) ? 0 : -20) + (sizeOk(x) ? 0 : -5) + (jimokOk(x) ? 0 : -9) + (jimokSame(x) ? 1 : 0) + (x.addr.includes(dong) ? 2 : 0) + (c.zone && x.type.includes(c.zone.replace('지역', '')) ? 1 : 0) + (c.saleScope === 'part' ? (x.type.includes('집합') ? 2 : 0) + (floorOk(x) ? 2 : -3) : (x.type.includes('일반') ? 1 : 0));
    const unit = x => (C.TYPES[c.type].income && c.saleScope === 'part') ? (x.pricePerSqmBldg || 0) : (x.pricePerSqm || 0);
    const dfl = (c.dongFilter || '').split(/[,·/]/).map(v => v.trim()).filter(Boolean); const dongOk = x => !dfl.length || dfl.some(d => (x.addr || '').includes(d));
    const eligible = all.filter(x => zoneOk(x) && jimokOk(x) && dongOk(x));
    eligible.sort((a, b) => sc(b) - sc(a) || unit(b) - unit(a) || (b.date > a.date ? 1 : -1));
    const picked = eligible.slice(0, 150); picked.forEach((x, i) => { x.use = i < 15 && (!dong || x.addr.includes(dong)) && floorOk(x) && sizeOk(x); });
    const key = x => (c.compSort === 'unit') ? unit(x) : (x.price || 0); picked.sort((a, b) => key(b) - key(a) || (b.date > a.date ? 1 : -1)); // 표시: 높은순(총액/단가 선택) → 최신순
    const top = picked;
    if (!top.some(x => x.use)) top.slice(0, 10).forEach(x => x.use = true);
    c.comps = c.comps.filter(x => !x.auto).concat(top);
    applyPriceDefaults(c);
    state.rtmsStatus = all.length ? `${all.length}건 수신 (상위 ${top.length}건 표시, 같은 읍면동·용도지역·유사 규모(${Math.round(minArea)}~${isFinite(maxArea) ? Math.round(maxArea) : '∞'}㎡) 우선 채택, 도로·구거·하천 제외${dfl.length ? ', 지역 ' + dfl.join('·') + ' 한정' : ''}${zf.length ? ', 용도지역 ' + zf.join('·') : ''}, ' + (c.compSort === 'unit' ? '단가' : '거래금액') + ' 높은순·최신순)` : '0건 — ' + lastErr;
    save(); render(); toast(state.rtmsStatus);
  }
  function jsonp(url, params, ms) { return new Promise((res, rej) => { const cb = 'vw' + Math.random().toString(36).slice(2); const sc = document.createElement('script'); const t = setTimeout(() => { cleanup(); rej(new Error('timeout')); }, ms || 10000); function cleanup() { clearTimeout(t); delete window[cb]; sc.remove(); } window[cb] = d => { cleanup(); res(d); }; sc.src = url + '?' + new URLSearchParams(Object.assign({}, params, { callback: cb })).toString(); sc.onerror = () => { cleanup(); rej(new Error('script error')); }; document.head.appendChild(sc); }); }
  async function vworldSearch(q) { const S = state.settings; const p = { service: 'search', request: 'search', version: '2.0', crs: 'EPSG:4326', size: 1, query: q, type: 'address', category: 'parcel', format: 'json', errorformat: 'json', key: S.vworldKey }; let d; try { d = await jsonp('https://api.vworld.kr/req/search', p); } catch (e) { d = await (await fetch(`${S.landApi.replace(/\/$/, '')}/vworld/search?query=${encodeURIComponent(q)}`)).json(); } const it = d && d.response && d.response.result && d.response.result.items && d.response.result.items[0]; if (!it) throw new Error('주소 검색 실패 (' + (d && d.response && d.response.status) + ')'); return it; }
  async function vworldNed(op, pnu) { const S = state.settings; const p = { key: S.vworldKey, domain: location.origin, format: 'json', numOfRows: '50', pnu }; try { return await jsonp('https://api.vworld.kr/ned/data/' + op, p); } catch (e) { return await (await fetch(`${S.landApi.replace(/\/$/, '')}/vworld/ned/${op}?pnu=${pnu}`)).json(); } }
  function lawdFromAddress(addr) {
    const CODES = (typeof SIGUNGU_CODES !== 'undefined') ? SIGUNGU_CODES : (window.SIGUNGU_CODES || []); if (!CODES.length || !addr) return '';
    const a = addr.replace(/\s+/g, ' ');
    const norm = x => x.replace(/특별시|광역시|특별자치시|특별자치도|도$/g, '').replace(/^서울시?$/, '서울');
    const sidoM = a.match(/^(서울특별시|서울시|서울|부산광역시|부산|대구광역시|대구|인천광역시|인천|광주광역시|광주|대전광역시|대전|울산광역시|울산|세종특별자치시|세종|경기도|경기|강원특별자치도|강원도|강원|충청북도|충북|충청남도|충남|전라북도|전북특별자치도|전북|전라남도|전남|경상북도|경북|경상남도|경남|제주특별자치도|제주)/);
    const sido = sidoM ? sidoM[1] : '';
    const rest = sido ? a.slice(sido.length).trim() : a;
    const sggM = rest.match(/^([가-힣]+(?:시|군|구))(?:\s+([가-힣]+구))?/); if (!sggM) return '';
    const cand = (sggM[2] ? sggM[1] + ' ' + sggM[2] : sggM[1]);
    const hits = CODES.filter(x => (x.sgg === cand || x.sgg === sggM[1] || x.sgg.replace(/\s/g, '') === cand.replace(/\s/g, '')) && (!sido || norm(x.sido).startsWith(norm(sido).slice(0, 2))));
    return hits.length ? hits[0].code : '';
  }

  // ---------- 다필지 (최대 10필지) ----------
  const MAX_PARCELS = 10;
  const JIMOK = { '대': '대', '답': '답', '전': '전', '임': '임야', '잡': '잡종지', '도': '도로', '천': '하천', '구': '구거', '장': '공장용지', '주': '주유소용지', '차': '주차장', '창': '창고용지', '과': '과수원', '목': '목장용지', '공': '공원', '체': '체육용지', '유': '유지', '제': '제방', '묘': '묘지', '종': '종교용지', '학': '학교용지', '수': '수도용지', '사': '사적지', '광': '광천지', '염': '염전', '원': '유원지', '철': '철도용지', '양': '양어장', '창': '창고용지', '학': '학교용지' };
  const parcelSum = c => { const own = (c.parcels || []).filter(x => x.own); const area = own.reduce((a, x) => a + (+x.area || 0), 0); const pubTotal = own.reduce((a, x) => a + (+x.area || 0) * (+x.pub || 0), 0); return { own, area, pubTotal, pubAvg: area ? Math.round(pubTotal / area) : 0 }; };
  function syncParcels(c) {
    const m = parcelSum(c); if (!m.own.length) return;
    c.landArea = Math.round(m.area * 100) / 100; if (m.pubAvg) { c.publicPricePerSqm = m.pubAvg; c.landPublic = Math.round(m.pubTotal); }
    const big = m.own.reduce((b, x) => (+x.area || 0) > (+b.area || 0) ? x : b, m.own[0]); if (big.zone) c.zone = big.zone; if (big.jimok) c.jimok = big.jimok;
    c.multiParcel = m.own.length > 1; if (c.askAuto !== false) { try { applyPriceDefaults(c, false); } catch (e) { } }
  }
  function parcelCard(c) {
    const ps = c.parcels || []; const m = parcelSum(c); const nb = state.nearby;
    const rows = ps.map((x, i) => `<tr style="${x.own ? '' : 'opacity:.55'}"><td><input type="checkbox" data-pc="${i}.own" ${x.own ? 'checked' : ''}></td><td>${esc(x.addr || x.jibun)}${x.base ? ' ' + pill('기준', 'na') : ''}</td><td><input data-pc="${i}.jimok" value="${esc(x.jimok || '')}" style="width:70px"></td><td><input data-pc="${i}.area" data-t="num" value="${x.area || ''}" style="width:80px" inputmode="decimal"></td><td><input data-pc="${i}.zone" value="${esc(x.zone || '')}" style="width:130px"></td><td><input data-pc="${i}.pub" data-t="money" value="${x.pub ? Math.round(x.pub).toLocaleString('ko-KR') : ''}" style="width:90px"></td><td class="r">${x.area && x.pub ? fmt(x.area * x.pub) : '—'}</td><td><button class="btn sm" onclick="App.delParcel(${i})">삭제</button></td></tr>`).join('');
    const table = ps.length ? `<table><thead><tr><th>내 토지</th><th>지번</th><th>지목</th><th>면적㎡</th><th>용도지역</th><th>공시지가/㎡</th><th class="r">공시지가 총액</th><th></th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td></td><td style="font-weight:700">내 토지 ${m.own.length}필지 합계</td><td></td><td style="font-weight:700">${(Math.round(m.area * 100) / 100).toLocaleString()}</td><td class="muted">${(m.area / 3.3058).toFixed(1)}평</td><td class="r muted">가중평균 ${fmt(m.pubAvg)}</td><td class="r" style="font-weight:700">${fmt(m.pubTotal)}</td><td></td></tr></tfoot></table>` : '<div class="muted">아직 필지가 없습니다. 아래에 기준 필지와 인근 필지의 지번을 입력하세요.</div>';
    const cand = nb ? (nb.loading ? '<div class="muted" style="margin-top:10px">인근 필지 조회 중…</div>' : nb.error ? `<div class="notice warn" style="margin-top:10px">${esc(nb.error)}</div>` : `<div style="margin-top:12px"><div style="font-weight:600;margin-bottom:6px">인근 필지 (가까운 순 · 내 토지만 체크)</div><table><thead><tr><th></th><th>지번</th><th>거리</th><th>공시지가/㎡</th></tr></thead><tbody>${nb.items.map((x, i) => `<tr><td><input type="checkbox" data-nb="${i}" ${x.sel ? 'checked' : ''}></td><td>${esc(x.addr)} <span class="muted">${esc(x.jimok || '')}</span></td><td>${x.dist}m</td><td class="r">${x.jiga ? fmt(x.jiga) : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">인근 필지를 찾지 못했습니다.</td></tr>'}</tbody></table><div style="margin-top:8px"><button class="btn sm primary" onclick="App.addNearby()">체크한 필지를 내 토지로 추가</button> <button class="btn sm" onclick="App.closeNearby()">닫기</button></div></div>`) : '';
    return card(`필지 구성 (최대 ${MAX_PARCELS}필지 · 현재 ${ps.length})`, `${table}
<div class="field" style="margin-top:12px"><label>인근 필지 지번 입력 — 기준 주소와 같은 동이면 지번만 (예: 20-6, 21, 22-1 · 산 지번은 “산12-3” · 다른 동은 전체 주소) · 줄바꿈·쉼표 구분, 최대 10필지</label><textarea id="parcelText" rows="3" placeholder="20-6, 21, 22-1&#10;경기도 남양주시 화도읍 월산리 23"></textarea></div>
${ps.filter(x => x.own).length > 1 ? `<div class="fgrid g4" id="parcelopt" style="margin-top:10px">${field('합필 프리미엄 (비우면 자동: 필지당 3%·최대 10%, 0=미적용)', 'assemblagePremium', c.assemblagePremium, 'pct')}</div>` : ''}
<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn sm primary" onclick="App.addParcels()">지번으로 필지 조회·추가</button><label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="parcelOwn" checked> 내 토지로 추가 (해제 시 참고용)</label></div>${cand}
<div class="muted" style="margin-top:8px">내 토지로 체크한 필지의 면적·공시지가·용도지역(면적 최대 필지 기준)이 위 기본 정보에 합산 반영됩니다. 타인 소유 필지는 체크를 해제해 두면 참고용으로만 남습니다.</div>`);
  }
  async function parcelInfo(pnu, addr, jibun) {
    const o = { pnu, addr: addr || '', jibun: jibun || '', jimok: '', area: 0, zone: '', pub: 0, own: true };
    const [lu, pp, ch] = await Promise.all([vworldNed('getLandUseAttr', pnu).catch(() => null), vworldNed('getIndvdLandPriceAttr', pnu).catch(() => null), vworldNed('getLandCharacteristics', pnu).catch(() => null)]);
    try { const z = (lu.landUses.field || []).map(f => f.prposAreaDstrcCodeNm); o.zone = z.find(v => /지역$/.test(v) && !/도시지역/.test(v)) || z[0] || ''; } catch (e) { }
    try { const f = pp.indvdLandPrices.field; o.pub = parseInt(f[f.length - 1].pblntfPclnd, 10) || 0; } catch (e) { }
    try { const f = ch.landCharacteristicss.field[0]; o.area = parseFloat(f.lndpclAr) || 0; o.jimok = f.lndcgrCodeNm || ''; } catch (e) { }
    return o;
  }
  async function addParcels() {
    const c = state.current; const ta = document.getElementById('parcelText'); const text = ta ? ta.value : ''; const ownBox = document.getElementById('parcelOwn');
    c.parcels = c.parcels || []; const prefix = (c.address || '').replace(/\s*[\d-]+\S*$/, '').trim();
    const list = []; if (!c.parcels.length && c.address) list.push({ addr: c.address, base: true });
    text.split(/[\n;,]+/).map(x => x.trim()).filter(Boolean).forEach(tk => list.push({ addr: /^산?\s*[\d-]+\s*[가-힣]?$/.test(tk) ? prefix + ' ' + tk.replace(/\s*[가-힣]$/, '').replace(/^산\s*/, '산 ') : tk }));
    if (!list.length) { toast('지번을 입력하세요'); return; }
    toast('필지 조회 중…'); let ok = 0, fail = [];
    for (const it of list) {
      if (c.parcels.length >= MAX_PARCELS) { fail.push(it.addr + ' (최대 ' + MAX_PARCELS + '필지)'); continue; }
      try { const r = await vworldSearch(it.addr); if (c.parcels.some(x => x.pnu === r.id)) continue; const o = await parcelInfo(r.id, (r.address && r.address.parcel) || it.addr); o.base = !!it.base; if (!it.base && ownBox && !ownBox.checked) o.own = false; if (it.base && !c.pnu) c.pnu = r.id; c.parcels.push(o); ok++; if (!c.lawd) c.lawd = r.id.slice(0, 5); } catch (e) { fail.push(it.addr); }
    }
    syncParcels(c); save(); render(); toast(`${ok}필지 추가${fail.length ? ' · 실패: ' + fail.join(', ') : ''} — 실거래 갱신 중…`); if (c.lawd) { try { await fetchRtms(); } catch (e) { } }
  }
  async function findNearby() {
    const c = state.current; if (!c.address) { toast('기준 주소를 먼저 입력하세요'); return; }
    state.nearby = { loading: true, items: [] }; render();
    try {
      const S = state.settings; const base = await vworldSearch(c.address); const x0 = parseFloat(base.point.x), y0 = parseFloat(base.point.y); const d = 0.0010;
      const j = await jsonp('https://api.vworld.kr/req/data', { service: 'data', request: 'GetFeature', data: 'LP_PA_CBND_BUBUN', key: S.vworldKey, domain: location.origin, geomFilter: `BOX(${x0 - d},${y0 - d},${x0 + d},${y0 + d})`, size: '100', geometry: 'true', crs: 'EPSG:4326', format: 'json' }, 15000);
      const feats = (((j.response || {}).result || {}).featureCollection || {}).features || []; if (!feats.length) throw new Error('인근 필지 데이터가 없습니다 (브이월드는 국내 접속에서 동작)');
      const have = new Set((c.parcels || []).map(x => x.pnu)); have.add(c.pnu);
      const items = feats.map(f => { const pr = f.properties || {}; let ring = f.geometry && f.geometry.coordinates; while (ring && Array.isArray(ring[0]) && Array.isArray(ring[0][0])) ring = ring[0]; const pts = ring || []; const cx = pts.reduce((a, q) => a + q[0], 0) / (pts.length || 1), cy = pts.reduce((a, q) => a + q[1], 0) / (pts.length || 1); const dist = pts.length ? Math.round(Math.hypot((cx - x0) * 88100, (cy - y0) * 111000)) : 9999; const jb = String(pr.jibun || ''); const jm = JIMOK[(jb.match(/([가-힣])$/) || [])[1]] || ''; return { pnu: pr.pnu, addr: pr.addr || jb, jimok: jm, jiga: parseInt(pr.jiga, 10) || 0, dist, sel: false }; }).filter(x => x.pnu && !have.has(x.pnu)).sort((a, b) => a.dist - b.dist).slice(0, MAX_PARCELS);
      state.nearby = { items };
    } catch (e) { state.nearby = { error: '인근 필지 조회 실패: ' + e.message, items: [] }; }
    render();
  }
  async function addNearby() {
    const c = state.current; const nb = state.nearby; if (!nb || !nb.items) return; const sel = nb.items.filter(x => x.sel); if (!sel.length) { toast('내 토지인 필지를 체크하세요'); return; }
    c.parcels = c.parcels || []; if (!c.parcels.length && c.pnu) { try { const o = await parcelInfo(c.pnu, c.address); o.base = true; c.parcels.push(o); } catch (e) { } }
    toast('필지 정보 조회 중…'); let n = 0;
    for (const it of sel) { if (c.parcels.length >= MAX_PARCELS) { toast('최대 ' + MAX_PARCELS + '필지까지입니다'); break; } try { c.parcels.push(await parcelInfo(it.pnu, it.addr)); n++; } catch (e) { } }
    state.nearby = null; syncParcels(c); save(); render(); toast(n + '필지 추가 · 합산 반영 — 실거래 갱신 중…'); if (c.lawd) { try { await fetchRtms(); } catch (e) { } }
  }
  async function lookupLand() {
    const c = state.current; if (!c.address) { toast('주소를 입력하세요'); return; }
    if (!c.lawd) { const l = lawdFromAddress(c.address); if (l) c.lawd = l; }
    toast('토지정보 조회 중…');
    try {
      const it = await vworldSearch(c.address); c.pnu = it.id; c.lawd = it.id.slice(0, 5); if (it.address && it.address.parcel) c.address = it.address.parcel;
      const lu = await vworldNed('getLandUseAttr', c.pnu).catch(() => null); const zones = []; try { (lu.landUses.field || []).forEach(f => zones.push(f.prposAreaDstrcCodeNm)); } catch (e) { }
      if (zones.length) { c.zone = zones.find(z => /지역$/.test(z) && !/도시지역/.test(z)) || zones[0]; const r = c.risks.find(x => x.key === 'landuse'); if (r) { r.memo = zones.join(', '); if (r.status === 'na') r.status = 'ok'; } const rz = c.risks.find(x => x.key === 'zone'); if (rz) { const bad = zones.filter(z => /농업진흥|보전산지|개발제한|보전관리|농림/.test(z)); rz.memo = bad.length ? bad.join(', ') + ' — 전용·건축 제한 검토' : '규제 레이어 특이사항 없음'; rz.status = bad.length ? 'warn' : 'ok'; } }
      const pp = await vworldNed('getIndvdLandPriceAttr', c.pnu).catch(() => null); try { const f = pp.indvdLandPrices.field; const last = f[f.length - 1]; c.publicPricePerSqm = parseInt(last.pblntfPclnd, 10); c.landPublic = c.publicPricePerSqm * (c.landArea || 0); c.priceYear = last.stdrYear; } catch (e) { }
      const ch = await vworldNed('getLandCharacteristics', c.pnu).catch(() => null); try { const f = ch.landCharacteristicss.field[0]; if (!c.landArea) c.landArea = parseFloat(f.lndpclAr); c.jimok = f.lndcgrCodeNm; const rr = c.risks.find(x => x.key === 'road'); if (rr) { rr.memo = `접도: ${f.roadSideCodeNm || '-'} · 형상 ${f.tpgrphFrmCodeNm || '-'} · 지세 ${f.tpgrphHgCodeNm || '-'}`; rr.status = /맹지/.test(f.roadSideCodeNm || '') ? 'bad' : 'ok'; if (rr.status === 'bad' && !rr.rate) rr.rate = 0.3; } if (c.landPublic === 0 && c.publicPricePerSqm) c.landPublic = c.publicPricePerSqm * c.landArea; } catch (e) { }
      save(); render(); toast(`조회 완료 — PNU ${c.pnu} · ${c.zone || ''} · 공시지가 ${fmt(c.publicPricePerSqm)}/㎡`);
    } catch (e) { save(); render(); toast('토지정보 조회 실패: ' + e.message + ' — 시군구코드 ' + (c.lawd || '미확인') + '로 실거래만 조회합니다 (브이월드는 국내 접속에서 동작)'); }
  }
  async function fetchBldg() {
    const c = state.current; const S = state.settings; if (!c.pnu || c.pnu.length < 19) { toast('PNU가 필요합니다 (주소 조회 먼저)'); return; }
    const sigungu = c.pnu.slice(0, 5), bjdong = c.pnu.slice(5, 10), platGb = c.pnu[10] === '2' ? 1 : 0, bun = c.pnu.slice(11, 15), ji = c.pnu.slice(15, 19);
    toast('건축물대장 조회 중…');
    try {
      let items = null;
      if (S.workerUrl && state.workerOk && state.workerKeys && state.workerKeys.datagokr) { try { const j = await (await fetch(`${S.workerUrl.replace(/\/$/, '')}/bldg?pnu=${c.pnu}`)).json(); if (j.items) items = j.items; } catch (e) { } }
      if (!items) { if (!S.dataKey) throw new Error('설정에 공공데이터포털 서비스키를 입력하세요'); const key = /%[0-9A-F]{2}/i.test(S.dataKey) ? S.dataKey : encodeURIComponent(S.dataKey); const url = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?serviceKey=${key}&sigunguCd=${sigungu}&bjdongCd=${bjdong}&platGbCd=${platGb}&bun=${bun}&ji=${ji}&numOfRows=10&pageNo=1`; const xml = await fetchText(S.proxyUrl ? S.proxyUrl.replace(/\/$/, '') + '/?url=' + encodeURIComponent(url) : url); items = parseXmlItems(xml).map(it => ({ name: it.bldNm, mainUse: it.mainPurpsCdNm, totArea: parseFloat(it.totArea || 0), platArea: parseFloat(it.platArea || 0), bcRat: parseFloat(it.bcRat || 0), vlRat: parseFloat(it.vlRat || 0), useApr: it.useAprDay, floors: `지상 ${it.grndFlrCnt}층/지하 ${it.ugrndFlrCnt}층`, elevators: parseInt(it.rideUseElvtCnt || 0, 10), parking: ['indrAutoUtcnt', 'oudrAutoUtcnt', 'indrMechUtcnt', 'oudrMechUtcnt'].reduce((s2, k) => s2 + parseInt(it[k] || 0, 10), 0), violation: /위반/.test(it.regstrGbCdNm || '') || it.violYn === 'Y' })); }
      if (!items.length) throw new Error('해당 지번의 건축물대장 없음');
      const b = items.reduce((a, x) => x.totArea > (a.totArea || 0) ? x : a, items[0]);
      const diff = c.gfa ? Math.abs(b.totArea - c.gfa) / c.gfa : 0;
      c.gfa = b.totArea || c.gfa; if (b.platArea && !c.landArea) c.landArea = b.platArea; c.builtYear = (b.useApr || '').slice(0, 4) || c.builtYear; c.floors = b.floors; c.parking = b.parking + '대'; c.elevator = b.elevators + '대';
      const r = c.risks.find(x => x.key === 'bldg'); if (r) { r.memo = `${b.name || ''} ${b.mainUse || ''} · 연면적 ${b.totArea}㎡${diff > 0.02 ? ` (브로셔 대비 ${(diff * 100).toFixed(1)}% 불일치)` : ' (브로셔 일치)'} · 건폐율 ${b.bcRat}% 용적률 ${b.vlRat}%${b.violation ? ' · 위반건축물 등재' : ''}`; r.status = b.violation ? 'bad' : diff > 0.02 ? 'warn' : 'ok'; }
      const ru = c.risks.find(x => x.key === 'use'); if (ru) { ru.memo = '주용도 ' + (b.mainUse || '-'); if (ru.status === 'na') ru.status = 'ok'; }
      save(); render(); toast('건축물대장 반영 완료' + (b.violation ? ' — 위반건축물!' : ''));
    } catch (e) { toast('건축물대장 실패: ' + e.message); }
  }
  async function autoCollect() { const c = state.current; try { await lookupLand(); } catch (e) { } if (C.TYPES[c.type].income && c.pnu && c.pnu.length >= 19) { try { await fetchBldg(); } catch (e) { } } if (!c.lawd) c.lawd = lawdFromAddress(c.address); if (c.lawd) await fetchRtms(); else toast('시군구코드를 찾지 못했습니다 — 시장 탭에서 입력'); state.tab = 'market'; save(); render(); }
  async function checkWorker() { try { const j = await api('/health'); state.workerOk = !!(j && j.ok); state.workerKeys = j.keys || {}; } catch (e) { state.workerOk = false; } }
  async function law(name, art) { try { $('#lawbox').textContent = '조회 중…'; const j = await api(`/law?name=${encodeURIComponent(name)}&art=${encodeURIComponent(art)}`); state.lawText = `${j.law} 제${art}조 (시행 ${j.effective}, 법령일련번호 ${j.mst})\n\n${j.text}`; $('#lawbox').textContent = state.lawText; } catch (e) { $('#lawbox').textContent = '조회 실패: ' + e.message; } }
  async function syncPush() { const s = state.settings; if (!s.pin) { toast('PIN을 입력하세요'); return; } try { await api('/sync/' + encodeURIComponent(s.pin), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cases: state.cases, settings: { premium: s.premium, equityPremium: s.equityPremium, zopaWeight: s.zopaWeight, dscrMin: s.dscrMin, author: s.author }, at: new Date().toISOString() }) }); toast('서버 저장 완료'); } catch (e) { toast('실패: ' + e.message); } }
  async function syncPull() { const s = state.settings; if (!s.pin) { toast('PIN을 입력하세요'); return; } try { const j = await api('/sync/' + encodeURIComponent(s.pin)); if (j && j.cases) { state.cases = j.cases; state.cases.forEach(initRisks); state.current = state.cases[0]; Object.assign(state.settings, j.settings || {}); save(); render(); toast('불러오기 완료 (' + (j.at || '').slice(0, 16) + ')'); } else toast('서버에 데이터 없음'); } catch (e) { toast('실패: ' + e.message); } }
  async function ping() { try { const j = await api('/health'); toast('연결 OK · ' + (j.version || '')); } catch (e) { toast('연결 실패: ' + e.message); } }

  // ---------- 렌더 루프 ----------
  const HEAD = { input: ['물건 입력', '브로셔 한 장이면 시작됩니다. 추출값을 확인하고 희망가를 정하세요.', ['자동 수집·리스크로', 'market']], market: ['시장 데이터와 리스크 판정', '실거래·금리·공시지가를 모으고, 법률·행정 체크를 판정합니다.', ['가치평가로', 'buy']], buy: ['매수자 가치평가 — 5단 검증', 'Cap Rate → NPV → DSCR → 보유세 → 무위험 수익률. 한 줄 결론과 조건을 드립니다.', ['매도·세무로', 'sell']], sell: ['매도자 세후 역산과 세무 시뮬레이션', '세금을 뺀 뒤 손에 남는 금액으로 최소 수용 금액을 잡습니다.', ['ZOPA 도출', 'zopa']], zopa: ['거래성사 가능 구간과 양측 결정', '네 개의 가격을 한 축에 놓고 양측이 할 일을 결론 냅니다.', ['보고서 출력', 'report']], report: ['보고서 출력 구조', '매수용·매도용·협상용 세 가지. 1쪽은 언제나 결론입니다.', ['처음으로', 'input']], settings: ['설정 · 동기화 · 법령', '기본 가정값, PIN 동기화, 법제처 조문 조회, 케이스 관리', ['입력으로', 'input']] };
  function renderSide() {
    $('#nav').innerHTML = NAV.map(n => `<a href="#${n[0]}" class="${state.tab === n[0] ? 'on' : ''}" onclick="App.setTab('${n[0]}');return false;"><span class="n">${n[1]}</span><span class="t"><b>${n[2]}</b><small>${n[3]}</small></span></a>`).join('');
    $('#side-buy').className = state.side === 'buy' ? 'on' : ''; $('#side-sell').className = state.side === 'sell' ? 'on' : '';
    $('#case-name').textContent = state.current.name; $('#case-meta').textContent = `${C.TYPES[state.current.type].label} · 호가 ${eok(state.current.ask)}`;
  }
  function render() {
    renderSide(); const h = HEAD[state.tab]; const idx = NAV.findIndex(n => n[0] === state.tab) + 1;
    $('#h-step').textContent = `STEP ${idx} / 7 · ${state.side === 'buy' ? '매수자 입장' : '매도자 입장'}`; $('#h-title').textContent = h[0]; $('#h-sub').textContent = h[1];
    $('#h-acts').innerHTML = `<button class="btn" onclick="App.newCase()">새 물건</button><button class="btn primary" onclick="App.setTab('${h[2][1]}')">${h[2][0]} ${svg('arrow')}</button>`;
    const root = $('#content'); const fn = { input: renderInput, market: renderMarket, buy: renderBuy, sell: renderSell, zopa: renderZopa, report: renderReport, settings: renderSettings }[state.tab];
    try { root.innerHTML = fn(); } catch (e) { console.error(e); root.innerHTML = `<div class="notice bad">화면 오류: ${esc(e.message)}</div>`; }
    ({ input: afterInput, market: afterMarket, sell: r => { bindInputs(r, state.current, () => render()); r.querySelectorAll('[data-bp]').forEach(el => el.addEventListener('change', () => { const [i, k] = el.dataset.bp.split('.'); state.current.seller.bizPeriods[+i][k] = el.value || (k === 'to' ? '2099-12-31' : ''); save(); render(); })); }, settings: afterSettings }[state.tab] || (() => { }))(root);
    window.scrollTo(0, 0);
  }
  function svg(k) { const p = { upload: '<path d="M12 16V4m0 0 4 4m-4-4-4 4"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>', arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>' }[k]; return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`; }

  // ---------- 공개 API ----------
  window.App = {
    addParcels, findNearby, addNearby, closeNearby() { state.nearby = null; render(); }, delParcel(i) { const c = state.current; c.parcels.splice(i, 1); syncParcels(c); save(); render(); },
    setTab(t) { state.tab = t; location.hash = t; render(); },
    setSide(s) { state.side = s; save(); if (state.tab === 'input') state.tab = s === 'buy' ? 'buy' : 'sell'; render(); },
    setType(t) { state.current.type = t; initRisks(state.current); save(); render(); },
    addRent() { state.current.rentroll.push({ floor: '', tenant: '', deposit: 0, rent: 0, mgmt: 0, expiry: '', vacant: false }); save(); render(); },
    delRent(i) { state.current.rentroll.splice(i, 1); save(); render(); },
    addComp() { state.current.comps.push({ addr: '', type: '', area: 0, price: 0, pricePerSqm: 0, date: '', use: true }); save(); render(); },
    delComp(i) { state.current.comps.splice(i, 1); save(); render(); },
    addBp() { state.current.seller.bizPeriods.push({ from: '', to: '2099-12-31', type: '' }); save(); render(); },
    delBp(i) { state.current.seller.bizPeriods.splice(i, 1); save(); render(); },
    newCase() { const c = newCase(); state.cases.push(c); state.current = c; state.tab = 'input'; save(); render(); toast('새 물건 — 유형을 고르고 브로셔를 올리세요'); },
    openCase(id) { state.current = state.cases.find(c => c.id === id); state.tab = 'input'; save(); render(); },
    dupCase(id) { const src = state.cases.find(c => c.id === id); const c = JSON.parse(JSON.stringify(src)); c.id = 'c' + Date.now(); c.name = src.name + ' (복사)'; state.cases.push(c); state.current = c; save(); render(); },
    delCase(id) { if (state.cases.length <= 1) { toast('마지막 케이스는 삭제할 수 없습니다'); return; } if (!confirm('이 케이스를 삭제할까요?')) return; state.cases = state.cases.filter(c => c.id !== id); if (state.current.id === id) state.current = state.cases[0]; save(); render(); },
    loadSample() { const c = sampleCase(); state.cases.push(c); state.current = c; save(); render(); },
    loadWulsan() { const c = wulsanCase(); state.cases.push(c); state.current = c; state.tab = 'input'; save(); render(); toast('월산리 20-5 — 시장 탭에서 실거래 조회를 누르면 호가가 자동 설정됩니다'); },
    exportJson() { const b = new Blob([JSON.stringify(state.current, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = state.current.name + '.json'; a.click(); },
    extractPaste() { const t = $('#paste').value; if (!t) { toast('텍스트를 붙여넣으세요'); return; } applyExtract(extractFromText(t), '붙여넣기', '텍스트 분석'); },
    setAskFromComps() { const c = state.current; if (!applyPriceDefaults(c, 'ask')) { toast('채택된 실거래 사례가 없습니다 — 시장 탭에서 실거래를 먼저 조회하세요'); return; } applyPriceDefaults(c, 'hope'); save(); render(); toast('호가를 최근 거래 최고가로 설정: ' + fmt(c.ask)); },
    setAskFromUnit() { const c = state.current; const t = C.TYPES[c.type]; const basis = c.askAreaBasis || (t.income && c.saleScope === 'part' ? 'excl' : 'land'); const ar = basis === 'excl' ? c.exclusiveArea : basis === 'gfa' ? c.gfa : c.landArea; const u = c.unitPriceSqm || (c.unitPricePyeong ? c.unitPricePyeong / 3.3058 : 0); if (!u || !ar) { toast('단가와 면적이 필요합니다'); return; } c.ask = Math.round(u * ar); c.askAuto = false; c.askBasis = `${fmt(c.unitPricePyeong || u * 3.3058)}/평 × ${(ar / 3.3058).toFixed(1)}평 (= ${fmt(u)}/㎡ × ${ar}㎡)`; applyPriceDefaults(c, 'hope'); if (!c.buyerHope || c.buyerHopeAuto) { c.buyerHope = Math.round(c.ask * 0.9); c.buyerHopeAuto = true; } save(); render(); toast('호가 ' + fmt(c.ask) + ' 적용'); },
    sortComps() { const c = state.current; const u = x => c.compSort === 'unit' ? ((C.TYPES[c.type].income && c.saleScope === 'part') ? (x.pricePerSqmBldg || 0) : (x.pricePerSqm || 0)) : (x.price || 0); c.comps.sort((a, b) => u(b) - u(a) || ((b.date || '') > (a.date || '') ? 1 : -1)); save(); render(); },
    setHopeFromAsk() { const c = state.current; if (!c.ask) { toast('호가를 먼저 입력하세요'); return; } applyPriceDefaults(c, 'hope'); save(); render(); },
    extractAI, fetchStats, fetchRtms, lookupLand, fetchBldg, autoCollect, law, syncPush, syncPull, ping, printReport, previewReport, downloadReport, evaluate, state, calc: C
  };
  load(); const h = location.hash.replace('#', ''); if (NAV.some(n => n[0] === h)) state.tab = h; render(); checkWorker().then(() => { if (state.tab === 'settings' || state.tab === 'market') render(); });
})();
