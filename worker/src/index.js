/* deal-check-api — Cloudflare Worker
 * 라우트: GET /health · POST /extract · GET /rtms · GET /landuse · GET /bldg · GET /stats · GET /law · GET|PUT /sync/:pin
 * 비밀값(wrangler secret): ANTHROPIC_API_KEY, DATA_GO_KR_KEY, ECOS_KEY, LAW_OC, VWORLD_KEY, ALPHAVANTAGE_KEY
 * KV: DEAL_CHECK_SYNC (케이스 동기화), DEAL_CHECK_CACHE (API 캐시)
 */
const VERSION = '1.1.1';
const json = (o, status, extra) => new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extra || {}) });

function cors(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
  const ok = allowed.includes('*') || allowed.includes(origin);
  return { 'Access-Control-Allow-Origin': ok ? (origin || '*') : allowed[0], 'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '86400' };
}
async function cached(env, key, ttlSec, fn) {
  if (env.DEAL_CHECK_CACHE) { const hit = await env.DEAL_CHECK_CACHE.get(key, 'json'); if (hit) return Object.assign(hit, { cached: true }); }
  const v = await fn(); const empty = v && Array.isArray(v.items) && v.items.length === 0; if (env.DEAL_CHECK_CACHE && v && !v.error && !empty) await env.DEAL_CHECK_CACHE.put(key, JSON.stringify(v), { expirationTtl: ttlSec }); return v;
}
function xmlItems(xml) { // 간단 XML → [{tag:value}]
  const items = []; const re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml))) { const o = {}; const r2 = /<([A-Za-z가-힣_]+)>([\s\S]*?)<\/\1>/g; let k; while ((k = r2.exec(m[1]))) o[k[1]] = k[2].replace(/<!\[CDATA\[|\]\]>/g, '').trim(); items.push(o); }
  return items;
}
const ymList = months => { const out = []; const d = new Date(); for (let i = 0; i < months; i++) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(x.getFullYear() + String(x.getMonth() + 1).padStart(2, '0')); } return out; };

// ---------- 실거래가 (국토부) ----------
const RTMS = { nrg: 'RTMSDataSvcNrgTrade', land: 'RTMSDataSvcLandTrade', indu: 'RTMSDataSvcInduTrade' };
async function rtms(env, lawd, kind, months, ymOnly) {
  const svc = RTMS[kind] || RTMS.nrg; const key = env.DATA_GO_KR_KEY; if (!key) return { error: 'DATA_GO_KR_KEY 미설정' };
  const all = [];
  for (const ym of (ymOnly ? [ymOnly] : ymList(Math.min(36, months || 24)))) {
    const part = await cached(env, `rtms:${svc}:${lawd}:${ym}`, 86400, async () => {
      const url = `https://apis.data.go.kr/1613000/${svc}/get${svc}?serviceKey=${encodeURIComponent(key)}&LAWD_CD=${lawd}&DEAL_YMD=${ym}&numOfRows=500&pageNo=1`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 deal-check' } }); const xml = await r.text();
      const items = xmlItems(xml).filter(it => !(it.cdealType || '').includes('O'));
      const num = (...vals) => { for (const v of vals) { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '').trim()); if (!isNaN(n) && n > 0) return n; } return 0; };
      return { items: items.map(it => ({
        addr: [it.umdNm || it.법정동, it.jibun || it.지번].filter(Boolean).join(' '),
        type: [it.buildingUse || it.건물주용도 || it.jimok || it.지목, it.buildingType, it.landUse || it.용도지역].map(x => (x || '').trim()).filter(Boolean).join('·'),
        area: num(it.plottageAr, it.대지면적, it.dealArea, it.거래면적, it.buildingAr, it.건물면적),
        bldgArea: num(it.buildingAr, it.건물면적),
        price: parseInt(String(it.dealAmount || it.거래금액 || '0').replace(/[^\d]/g, ''), 10) * 10000,
        date: `${it.dealYear || it.년}-${String(it.dealMonth || it.월).padStart(2, '0')}`, built: it.buildYear || it.건축년도 || '', floor: it.floor || it.층 || '', dealType: it.dealingGbn || it.거래유형 || '' })) };
    });
    if (part.items) all.push(...part.items);
  }
  return { items: all.filter(x => x.price > 0), count: all.length, kind, lawd };
}

// ---------- 토지정보 (브이월드 → PNU·용도지역·공시지가) ----------
async function landuse(env, address) {
  const key = env.VWORLD_KEY; if (!key) return { error: 'VWORLD_KEY 미설정' };
  const s = await fetch(`https://api.vworld.kr/req/search?service=search&request=search&version=2.0&crs=EPSG:4326&size=1&query=${encodeURIComponent(address)}&type=address&category=parcel&format=json&errorformat=json&key=${key}`).then(r => r.json()).catch(() => null);
  const item = s && s.response && s.response.result && s.response.result.items && s.response.result.items[0]; if (!item) return { error: '주소를 찾지 못함 (브이월드는 국내 IP 전용)' };
  const pnu = item.id; const out = { pnu, lawd: pnu.slice(0, 5), address: item.address && item.address.parcel };
  const q = async (dataKey) => fetch(`https://api.vworld.kr/ned/data/${dataKey}?key=${key}&pnu=${pnu}&format=json&numOfRows=20`).then(r => r.json()).catch(() => null);
  const lu = await q('getLandUseAttr'); const zones = []; try { (lu.landUses.field || []).forEach(f => zones.push(f.prposAreaDstrcCodeNm)); } catch (e) { }
  if (zones.length) { out.zone = zones.find(z => /지역$/.test(z)) || zones[0]; out.others = zones.filter(z => z !== out.zone).join(', '); }
  const pp = await q('getIndvdLandPriceAttr'); try { const f = pp.indvdLandPrices.field; const last = f[f.length - 1]; out.publicPrice = parseInt(last.pblntfPclnd, 10); out.priceYear = last.stdrYear; } catch (e) { }
  const ch = await q('getLandCharacteristics'); try { const f = ch.landCharacteristicss.field[0]; out.area = parseFloat(f.lndpclAr); out.jimok = f.lndcgrCodeNm; out.road = f.roadSideCodeNm; out.shape = f.tpgrphFrmCodeNm; } catch (e) { }
  return out;
}

// ---------- 건축물대장 (건축HUB) ----------
async function bldg(env, pnu) {
  const key = env.DATA_GO_KR_KEY; if (!key) return { error: 'DATA_GO_KR_KEY 미설정' };
  const sigungu = pnu.slice(0, 5), bjdong = pnu.slice(5, 10), platGb = pnu[10] === '2' ? 1 : 0, bun = pnu.slice(11, 15), ji = pnu.slice(15, 19);
  const url = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?serviceKey=${encodeURIComponent(key)}&sigunguCd=${sigungu}&bjdongCd=${bjdong}&platGbCd=${platGb}&bun=${bun}&ji=${ji}&numOfRows=10&pageNo=1`;
  const xml = await fetch(url).then(r => r.text()); const items = xmlItems(xml);
  return { items: items.map(it => ({ name: it.bldNm, mainUse: it.mainPurpsCdNm, totArea: parseFloat(it.totArea || 0), platArea: parseFloat(it.platArea || 0), bcRat: parseFloat(it.bcRat || 0), vlRat: parseFloat(it.vlRat || 0), useApr: it.useAprDay, floors: `지상 ${it.grndFlrCnt}층/지하 ${it.ugrndFlrCnt}층`, elevators: parseInt(it.rideUseElvtCnt || 0, 10), parking: (parseInt(it.indrAutoUtcnt || 0, 10) + parseInt(it.oudrAutoUtcnt || 0, 10) + parseInt(it.indrMechUtcnt || 0, 10) + parseInt(it.oudrMechUtcnt || 0, 10)), violation: it.violYn === 'Y' || /위반/.test(it.regstrGbCdNm || '') })) };
}

// ---------- 시장 데이터 (ECOS·미국채) ----------
async function stats(env) {
  return cached(env, 'stats:v1', 6 * 3600, async () => {
    const out = { asOf: new Date().toISOString().slice(0, 10) };
    const ecos = async (code, item) => { if (!env.ECOS_KEY) return null; const d = new Date(); const end = d.toISOString().slice(0, 10).replace(/-/g, ''); d.setDate(d.getDate() - 20); const start = d.toISOString().slice(0, 10).replace(/-/g, ''); const j = await fetch(`https://ecos.bok.or.kr/api/StatisticSearch/${env.ECOS_KEY}/json/kr/1/50/${code}/D/${start}/${end}/${item}`).then(r => r.json()).catch(() => null); const rows = j && j.StatisticSearch && j.StatisticSearch.row; if (!rows || !rows.length) return null; return parseFloat(rows[rows.length - 1].DATA_VALUE); };
    // 817Y002 시장금리(일별): 010200000 국고채3년, 010210000 국고채10년 ; 731Y001 환율 0000001 원/달러 ; 722Y001 기준금리 0101000
    const kr10 = await ecos('817Y002', '010210000'); if (kr10) out.riskFree = kr10 / 100;
    const kr3 = await ecos('817Y002', '010200000'); if (kr3) out.kr3y = kr3 / 100;
    const base = await ecos('722Y001', '0101000'); if (base) out.baseRate = base / 100;
    const fx = await ecos('731Y001', '0000001'); if (fx) out.usdkrw = fx;
    // 미국채: 재무부 일별 수익률 CSV (무료)
    try { const y = new Date().getFullYear(); const csv = await fetch(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`).then(r => r.text()); const lines = csv.trim().split('\n'); const head = lines[0].split(','); const row = lines[1].split(','); const g = n => parseFloat(row[head.findIndex(h => h.trim() === n)]); if (!isNaN(g('10 Yr'))) { out.us10y = g('10 Yr') / 100; out.us2y = g('2 Yr') / 100; out.us30y = g('30 Yr') / 100; out.usAsOf = row[0]; } } catch (e) { }
    if (!out.us10y && env.ALPHAVANTAGE_KEY) { try { const j = await fetch(`https://www.alphavantage.co/query?function=TREASURY_YIELD&interval=daily&maturity=10year&apikey=${env.ALPHAVANTAGE_KEY}`).then(r => r.json()); out.us10y = parseFloat(j.data[0].value) / 100; } catch (e) { } }
    out.source = 'ECOS(한국은행)·미국 재무부 · Worker 캐시 6h';
    return out;
  });
}

// ---------- 공공데이터포털 범용 (서비스키 주입) ----------
const DATA_HOSTS = ['apis.data.go.kr', 'api.odcloud.kr', 'www.data.go.kr'];
async function dataGo(env, url) {
  let u; try { u = new URL(url); } catch (e) { return new Response('{"error":"bad url"}', { status: 400 }); }
  if (!DATA_HOSTS.includes(u.hostname)) return new Response('{"error":"host not allowed"}', { status: 403 });
  if (!env.DATA_GO_KR_KEY) return new Response('{"error":"DATA_GO_KR_KEY 미설정"}', { status: 500 });
  u.searchParams.delete('serviceKey');
  const target = u.toString() + (u.search ? '&' : '?') + 'serviceKey=' + encodeURIComponent(env.DATA_GO_KR_KEY);
  const key = 'data:' + target.replace(/serviceKey=[^&]+/, '');
  if (env.DEAL_CHECK_CACHE) { const hit = await env.DEAL_CHECK_CACHE.get(key); if (hit) return new Response(hit, { headers: { 'content-type': 'text/plain; charset=utf-8', 'x-cache': 'hit' } }); }
  const r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 ynk-public-api' } }); const txt = await r.text();
  if (r.ok && env.DEAL_CHECK_CACHE && /<item>|"items"/.test(txt)) await env.DEAL_CHECK_CACHE.put(key, txt, { expirationTtl: 21600 });
  return new Response(txt, { status: r.status, headers: { 'content-type': (r.headers.get('content-type') || 'text/plain') + '; charset=utf-8' } });
}
async function ecosRoute(env, code, item, period, start, end) {
  if (!env.ECOS_KEY) return { error: 'ECOS_KEY 미설정' };
  const d = new Date(); const fmt = (x, p) => p === 'D' ? x.toISOString().slice(0, 10).replace(/-/g, '') : p === 'M' ? x.toISOString().slice(0, 7).replace(/-/g, '') : String(x.getFullYear());
  if (!end) end = fmt(d, period); if (!start) { const s = new Date(d); if (period === 'D') s.setDate(s.getDate() - 30); else if (period === 'M') s.setMonth(s.getMonth() - 24); else s.setFullYear(s.getFullYear() - 20); start = fmt(s, period); }
  return cached(env, `ecos:${code}:${item}:${period}:${start}:${end}`, 6 * 3600, async () => { const j = await fetch(`https://ecos.bok.or.kr/api/StatisticSearch/${env.ECOS_KEY}/json/kr/1/1000/${code}/${period}/${start}/${end}/${item}`).then(r => r.json()); const rows = (j.StatisticSearch && j.StatisticSearch.row) || []; return { code, item, period, rows: rows.map(r => ({ time: r.TIME, value: parseFloat(r.DATA_VALUE), name: r.ITEM_NAME1 })), error: j.RESULT && j.RESULT.MESSAGE }; });
}

// ---------- 법제처 조문 ----------
async function law(env, name, art) {
  const OC = env.LAW_OC || 'yjjn2005';
  return cached(env, `law:${name}:${art}`, 7 * 86400, async () => {
    const s = await fetch(`https://www.law.go.kr/DRF/lawSearch.do?OC=${OC}&target=law&type=JSON&query=${encodeURIComponent(name)}`).then(r => r.json());
    let list = s.LawSearch && s.LawSearch.law; if (!list) return { error: '법령 검색 실패' }; if (!Array.isArray(list)) list = [list];
    const hit = list.find(x => x['법령명한글'] === name && x['현행연혁코드'] === '현행') || list[0]; const mst = hit['법령일련번호'];
    const j = await fetch(`https://www.law.go.kr/DRF/lawService.do?OC=${OC}&target=law&MST=${mst}&type=JSON`).then(r => r.json());
    const flat = v => Array.isArray(v) ? v.map(flat).join('') : (v == null ? '' : String(v));
    const arts = j['법령']['조문']['조문단위']; const m = String(art).match(/^(\d+)(?:의(\d+))?$/); const no = m[1], sub = m[2] || '';
    const a = arts.find(x => x['조문여부'] === '조문' && x['조문번호'] === no && String(x['조문가지번호'] || '') === sub);
    if (!a) return { error: '조문 없음', law: name, mst };
    const out = [flat(a['조문내용'])]; const walk = (x, ind) => { if (Array.isArray(x)) return x.forEach(y => walk(y, ind)); if (x && typeof x === 'object') { ['항내용', '호내용', '목내용'].forEach(k => { if (k in x) out.push(ind + flat(x[k])); }); ['항', '호', '목'].forEach(k => { if (k in x) walk(x[k], ind + '  '); }); } };
    walk(a['항'] || [], '');
    return { law: name, mst, effective: j['법령']['기본정보']['시행일자'], promulgated: j['법령']['기본정보']['공포일자'], article: art, text: out.join('\n').replace(/<[^>]+>/g, '').replace(/[ \t]+/g, ' ') };
  });
}

// ---------- AI 브로셔 추출 (Claude) ----------
async function extract(env, body) {
  if (!env.ANTHROPIC_API_KEY) return { error: 'ANTHROPIC_API_KEY 미설정' };
  const schema = `{"type":"building|retail|factory|warehouse|lot|vacant|farm|forest","address":"지번 주소","zone":"용도지역","landArea":number(㎡),"gfa":number(㎡),"builtYear":"YYYY","floors":"지상 n층/지하 n층","parking":"n대","ask":number(원),"sellerHope":number(원),"rentroll":[{"floor":"","tenant":"","deposit":number,"rent":number(월),"mgmt":number(월),"expiry":"YYYY-MM","vacant":boolean}],"publicPricePerSqm":number,"missing":["누락 항목"],"confidence":0~1}`;
  const content = [];
  if (body.file) content.push(body.mime === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: body.file } } : { type: 'image', source: { type: 'base64', media_type: body.mime || 'image/jpeg', data: body.file } });
  content.push({ type: 'text', text: `다음 부동산 매도 브로셔에서 정보를 추출해 아래 JSON 스키마로만 답하라. 금액은 원 단위 정수(억·만 환산), 면적은 ㎡(평이면 ×3.3058). 알 수 없는 값은 생략하고 missing에 적어라. 설명 없이 JSON만.\n스키마: ${schema}${body.text ? '\n\n브로셔 텍스트:\n' + body.text.slice(0, 30000) : ''}` });
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: env.CLAUDE_MODEL || 'claude-sonnet-4-5', max_tokens: 2000, messages: [{ role: 'user', content }] }) });
  const j = await r.json(); if (!r.ok) return { error: (j.error && j.error.message) || 'Claude API 오류' };
  const txt = (j.content || []).map(c => c.text || '').join(''); const m = txt.match(/\{[\s\S]*\}/); if (!m) return { error: 'JSON 파싱 실패', raw: txt.slice(0, 500) };
  try { return JSON.parse(m[0]); } catch (e) { return { error: 'JSON 파싱 실패', raw: m[0].slice(0, 500) }; }
}

export default {
  async fetch(req, env) {
    const h = cors(req, env); if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url); const p = url.pathname.replace(/\/$/, '') || '/'; const q = k => url.searchParams.get(k);
    try {
      if (p === '/health' || p === '/') return json({ ok: true, version: VERSION, time: new Date().toISOString(), keys: { anthropic: !!env.ANTHROPIC_API_KEY, datagokr: !!env.DATA_GO_KR_KEY, ecos: !!env.ECOS_KEY, vworld: !!env.VWORLD_KEY }, routes: ['/data?url=', '/rtms', '/bldg', '/landuse', '/stats', '/ecos', '/law', '/sync/:pin', '/extract'] }, 200, h);
      if (p === '/extract' && req.method === 'POST') return json(await extract(env, await req.json()), 200, h);
      if (p === '/rtms') return json(await rtms(env, q('lawd'), q('kind') || 'nrg', parseInt(q('months') || '24', 10), q('ym')), 200, h);
      if (p === '/landuse') return json(await landuse(env, q('address') || ''), 200, h);
      if (p === '/bldg') return json(await bldg(env, q('pnu') || ''), 200, h);
      if (p === '/stats') return json(await stats(env), 200, h);
      if (p === '/data') { const r = await dataGo(env, q('url') || ''); const hh = new Headers(r.headers); Object.entries(h).forEach(([k, v]) => hh.set(k, v)); return new Response(r.body, { status: r.status, headers: hh }); }
      if (p === '/ecos') return json(await ecosRoute(env, q('code'), q('item'), q('period') || 'D', q('start'), q('end')), 200, h);
      if (p === '/law') return json(await law(env, q('name') || '소득세법', q('art') || '104의3'), 200, h);
      const sm = p.match(/^\/sync\/([A-Za-z0-9_-]{4,16})$/);
      if (sm) {
        if (!env.DEAL_CHECK_SYNC) return json({ error: 'KV 미설정' }, 500, h);
        if (req.method === 'PUT') { const body = await req.text(); if (body.length > 2000000) return json({ error: '용량 초과' }, 413, h); await env.DEAL_CHECK_SYNC.put('pin:' + sm[1], body); return json({ ok: true, at: new Date().toISOString() }, 200, h); }
        const v = await env.DEAL_CHECK_SYNC.get('pin:' + sm[1]); return new Response(v || 'null', { headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, h) });
      }
      return json({ error: 'not found' }, 404, h);
    } catch (e) { return json({ error: e.message }, 500, h); }
  }
};
