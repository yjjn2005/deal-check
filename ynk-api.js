/* ynk-api.js — 유앤김 공공데이터 공용 클라이언트 (모든 GitHub Pages 앱에서 재사용)
 * 사용: <script src="https://yjjn2005.github.io/deal-check/ynk-api.js"></script>
 *   YNK.rtms('nrg'|'land'|'indu'|'apt'|'aptRent', lawd, 'YYYYMM')  → 실거래 items[]
 *   YNK.dataGo('https://apis.data.go.kr/...?LAWD_CD=..')        → 서비스키 자동 주입 후 XML/JSON 텍스트
 *   YNK.vworldSearch(addr) / YNK.vworldNed(op, pnu)              → 브이월드 (JSONP → 서버 폴백)
 *   YNK.law('소득세법', '104의3') · YNK.stats() · YNK.sync(pin, data?)
 *   YNK.config()  — 공용 설정(localStorage 'ynk_public_api', yjjn2005.github.io 전체 앱이 공유)
 *   YNK.setKey('dataKey', '...') — 키를 한 번 저장하면 같은 출처의 모든 앱이 사용
 * 우선순위: ① 공용 Worker(deal-check-api, 키 서버 보관) ② 범용 프록시(ynk-data-proxy)+공용 저장 키 ③ 직접 호출
 */
(function (root) {
  'use strict';
  const LS = 'ynk_public_api';
  const DEFAULTS = { workerUrl: 'https://deal-check-api.yjjn2005.workers.dev', proxyUrl: 'https://ynk-data-proxy.yjjn2005.workers.dev', landApi: 'https://land-check-api.yjjn2005.workers.dev', dataKey: '', vworldKey: 'F6799A65-7960-4D2E-AA41-1BACB4EAEB1D', ecosKey: '', lawOC: 'yjjn2005' };
  let health = null;
  function config() { let c = {}; try { c = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { } return Object.assign({}, DEFAULTS, c); }
  function setKey(k, v) { const c = config(); c[k] = v; try { localStorage.setItem(LS, JSON.stringify(c)); } catch (e) { } return c; }
  const trim = u => (u || '').replace(/\/$/, '');
  async function getJson(url, opts) { const r = await fetch(url, opts); const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { throw new Error('JSON 아님: ' + t.slice(0, 80)); } if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }
  async function workerHealth() { if (health) return health; try { health = await getJson(trim(config().workerUrl) + '/health'); } catch (e) { health = { ok: false, keys: {} }; } return health; }
  const encKey = k => /%[0-9A-F]{2}/i.test(k) ? k : encodeURIComponent(k);
  function parseItems(text) {
    const t = text.trim();
    if (t.startsWith('{')) { const j = JSON.parse(t); const b = j.response && j.response.body; const it = b && b.items && (b.items.item || b.items); return Array.isArray(it) ? it : it ? [it] : (j.items || []); }
    const doc = new DOMParser().parseFromString(t, 'text/xml'); const code = doc.querySelector('resultCode,returnReasonCode'); const msg = doc.querySelector('resultMsg,errMsg,returnAuthMsg');
    if (code && !/^0+$/.test(code.textContent.trim())) throw new Error((msg && msg.textContent.trim()) || '응답 오류 ' + code.textContent);
    return Array.from(doc.querySelectorAll('item')).map(it => { const o = {}; Array.from(it.children).forEach(ch => o[ch.tagName] = ch.textContent.trim()); return o; });
  }
  // 공공데이터포털 범용: 서비스키 없는 URL을 주면 자동 주입
  async function dataGo(url) {
    const c = config(); const h = await workerHealth(); const errs = [];
    if (h.ok && h.keys && h.keys.datagokr) { try { return await (await fetch(trim(c.workerUrl) + '/data?url=' + encodeURIComponent(url))).text(); } catch (e) { errs.push('worker:' + e.message); } }
    if (c.dataKey) { const u = url + (url.includes('?') ? '&' : '?') + 'serviceKey=' + encKey(c.dataKey); for (const t of [c.proxyUrl ? trim(c.proxyUrl) + '/?url=' + encodeURIComponent(u) : null, u].filter(Boolean)) { try { const r = await fetch(t); const txt = await r.text(); if (!r.ok && !/<item>|"items"/.test(txt)) throw new Error('HTTP ' + r.status); return txt; } catch (e) { errs.push('proxy:' + e.message); } } }
    else errs.push('공공데이터포털 서비스키 미설정 — YNK.setKey("dataKey", 키) 또는 Worker 비밀값');
    throw new Error(errs.join(' / '));
  }
  const SVC = { nrg: 'RTMSDataSvcNrgTrade', land: 'RTMSDataSvcLandTrade', indu: 'RTMSDataSvcInduTrade', apt: 'RTMSDataSvcAptTrade', aptDev: 'RTMSDataSvcAptTradeDev', aptRent: 'RTMSDataSvcAptRent', offi: 'RTMSDataSvcOffiTrade', rh: 'RTMSDataSvcRHTrade', sh: 'RTMSDataSvcSHTrade' };
  async function rtms(kind, lawd, ym, rows) {
    const c = config(); const svc = SVC[kind] || kind;
    if (kind === 'land' && c.landApi) { try { const j = await getJson(`${trim(c.landApi)}/molit/land-trade?areaCd=${lawd}&dealYmd=${ym}&numOfRows=${rows || 999}`); if (j.items) return j.items; } catch (e) { } }
    if ((kind === 'apt' || kind === 'aptRent') && c.proxyUrl) { try { const r = await fetch(`${trim(c.proxyUrl)}/rtms?LAWD_CD=${lawd}&DEAL_YMD=${ym}&numOfRows=${rows || 999}&pageNo=1&type=${kind === 'apt' ? 'sale' : 'rent'}`); const t = await r.text(); if (/<item>/.test(t)) return parseItems(t); } catch (e) { } }
    return parseItems(await dataGo(`https://apis.data.go.kr/1613000/${svc}/get${svc}?LAWD_CD=${lawd}&DEAL_YMD=${ym}&numOfRows=${rows || 999}&pageNo=1`));
  }
  async function bldg(pnu) { const sg = pnu.slice(0, 5), bj = pnu.slice(5, 10), gb = pnu[10] === '2' ? 1 : 0, bun = pnu.slice(11, 15), ji = pnu.slice(15, 19); return parseItems(await dataGo(`https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?sigunguCd=${sg}&bjdongCd=${bj}&platGbCd=${gb}&bun=${bun}&ji=${ji}&numOfRows=10&pageNo=1`)); }
  function jsonp(url, params, ms) { return new Promise((res, rej) => { const cb = 'ynk' + Math.random().toString(36).slice(2); const sc = document.createElement('script'); const t = setTimeout(() => { done(); rej(new Error('timeout')); }, ms || 10000); function done() { clearTimeout(t); delete root[cb]; sc.remove(); } root[cb] = d => { done(); res(d); }; sc.src = url + '?' + new URLSearchParams(Object.assign({}, params, { callback: cb })).toString(); sc.onerror = () => { done(); rej(new Error('script')); }; document.head.appendChild(sc); }); }
  async function vworldSearch(q) { const c = config(); let d; try { d = await jsonp('https://api.vworld.kr/req/search', { service: 'search', request: 'search', version: '2.0', crs: 'EPSG:4326', size: 1, query: q, type: 'address', category: 'parcel', format: 'json', errorformat: 'json', key: c.vworldKey }); } catch (e) { d = await getJson(`${trim(c.landApi)}/vworld/search?query=${encodeURIComponent(q)}`); } const it = d && d.response && d.response.result && d.response.result.items && d.response.result.items[0]; if (!it) throw new Error('주소 검색 실패'); return it; }
  async function vworldNed(op, pnu) { const c = config(); try { return await jsonp('https://api.vworld.kr/ned/data/' + op, { key: c.vworldKey, domain: location.origin, format: 'json', numOfRows: '50', pnu }); } catch (e) { return await getJson(`${trim(c.landApi)}/vworld/ned/${op}?pnu=${pnu}`); } }
  async function law(name, art) { return getJson(`${trim(config().workerUrl)}/law?name=${encodeURIComponent(name)}&art=${encodeURIComponent(art)}`); }
  async function stats() { return getJson(trim(config().workerUrl) + '/stats'); }
  async function ecos(code, item, period, start, end) { return getJson(`${trim(config().workerUrl)}/ecos?code=${code}&item=${item}&period=${period || 'D'}&start=${start || ''}&end=${end || ''}`); }
  async function sync(pin, data) { const u = `${trim(config().workerUrl)}/sync/${encodeURIComponent(pin)}`; if (data === undefined) return getJson(u); return getJson(u, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); }
  root.YNK = { config, setKey, dataGo, rtms, bldg, vworldSearch, vworldNed, law, stats, ecos, sync, parseItems, workerHealth, SVC };
})(window);
