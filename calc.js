/* deal-check 계산 엔진 (브라우저·Node 공용, 의존성 없음)
 * 모든 금액은 원(₩) 정수, 비율은 소수(0.045 = 4.5%)
 * 세율·공제 등 법령 파라미터는 LAW 객체에 모아두고, 앱은 법제처 API 조회값으로 갱신할 수 있다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DealCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 법령 파라미터 (2026-10-01 법제처 API 대조) ----------
  const LAW = {
    asOf: '2026-10-01',
    // 소득세법 §55 기본세율 (2026)
    basicBrackets: [
      [14000000, 0.06], [50000000, 0.15], [88000000, 0.24], [150000000, 0.35],
      [300000000, 0.38], [500000000, 0.40], [1000000000, 0.42], [Infinity, 0.45]
    ],
    nonbizSurchargeNow: 0.10,      // §104①8 비사업용 +10%p
    nonbizSurcharge2028: 0.20,     // 2026 세제개편안: 2028-01-01 이후 양도분 +20%p
    nonbizLtDeductFrom2028: false, // 2028년부터 비사업용 장특공제 배제
    reformDate: '2028-01-01',
    shortHold1y: 0.50, shortHold2y: 0.40, // 1년 미만 50%, 2년 미만 40% (비주택)
    basicDeduction: 2500000,       // 양도소득 기본공제
    localTaxRate: 0.10,            // 지방소득세
    ltDeduct: function (years) {   // §95 표1: 3년 6% ~ 15년 30%
      if (years < 3) return 0; return Math.min(0.30, Math.floor(years) * 0.02);
    },
    corpBrackets: [[200000000, 0.09], [20000000000, 0.19], [300000000000, 0.21], [Infinity, 0.24]],
    corpNonbizExtraNow: 0.10, corpNonbizExtra2028: 0.20, // 법인세법 §55의2
    acqTax: { land: 0.04, farm: 0.03, farmSelf2y: 0.015, inherit: 0.028, inheritFarm: 0.023, gift: 0.035,
      surtaxRatio: 0.15, // 농특세 0.2%+교육세 0.4% ≈ 표준 4%의 15% (4.6%)
      bigCityCorp: 0.08 }, // 지방세법 §13② 표준×3−중과기준×2
    vatBuilding: 0.10,
    // 재산세 (지방세법 §111)
    propTax: {
      separate: [[200000000, 0.002], [1000000000, 0.003], [Infinity, 0.004]],   // 별도합산
      aggregate: [[50000000, 0.002], [100000000, 0.003], [Infinity, 0.005]],     // 종합합산
      building: 0.0025, farm: 0.0007, fairRatio: 0.70, urbanAreaRate: 0.0014, eduRate: 0.20
    },
    // 종합부동산세 (종부세법 §12·§14)
    cpt: {
      separate: { deduct: 8000000000, brackets: [[20000000000, 0.005], [40000000000, 0.006], [Infinity, 0.007]] },
      aggregate: { deduct: 500000000, brackets: [[1500000000, 0.01], [4500000000, 0.02], [Infinity, 0.03]], top2028: 0.04 },
      fairRatio: 1.0
    },
    farmlandLevy: { rate: 0.30, capPerSqm: 50000 }, // 농지보전부담금 (농지법 §38)
    shopLease: { seoul: 900000000, metro: 690000000, city: 540000000, other: 370000000, monthlyMult: 100, raiseCap: 0.05, renewYears: 10 },
    farmFine: 0.25 // 농지법 §63 이행강제금
  };

  const TYPES = {
    building: { label: '빌딩(업무)', income: true, land: false, premium: 0.020 },
    retail: { label: '근생상가', income: true, land: false, premium: 0.025 },
    factory: { label: '공장', income: true, land: false, premium: 0.025 },
    warehouse: { label: '창고(물류)', income: true, land: false, premium: 0.025 },
    lot: { label: '대지', income: false, land: true, premium: 0.015 },
    vacant: { label: '나대지', income: false, land: true, premium: 0.015 },
    farm: { label: '농지', income: false, land: true, premium: 0.015 },
    forest: { label: '임야', income: false, land: true, premium: 0.015 }
  };

  // ---------- 유틸 ----------
  function progressive(base, brackets, add) {
    add = add || 0; let t = 0, prev = 0;
    for (const [lim, r] of brackets) {
      if (base > prev) t += (Math.min(base, lim) - prev) * (r + add);
      prev = lim; if (base <= lim) break;
    }
    return Math.max(0, t);
  }
  function irr(cfs) {
    let lo = -0.95, hi = 2.0;
    const f = k => cfs.reduce((s, c, i) => s + c / Math.pow(1 + k, i), 0);
    if (f(lo) * f(hi) > 0) return null;
    for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  function pmt(P, r, n) { return r === 0 ? P / n : P * r / (1 - Math.pow(1 + r, -n)); }
  function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
  function yearsBetween(a, b) { return daysBetween(a, b) / 365.25; }
  function quantile(arr, q) {
    if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b);
    const pos = (s.length - 1) * q, b = Math.floor(pos), rest = pos - b;
    return s[b + 1] !== undefined ? s[b] + rest * (s[b + 1] - s[b]) : s[b];
  }

  // ---------- 1. 수익형: NOI ----------
  function noi(input) {
    // input: { rentroll:[{deposit, rent, mgmt, vacant}], depositYield, vacancy, opexRatio, otherIncome }
    const rr = input.rentroll || [];
    const rentY = rr.filter(r => !r.vacant).reduce((s, r) => s + (r.rent || 0) * 12, 0);
    const deposit = rr.filter(r => !r.vacant).reduce((s, r) => s + (r.deposit || 0), 0);
    const marketRentVacant = rr.filter(r => r.vacant).reduce((s, r) => s + (r.rent || 0) * 12, 0); // 공실층 시장임대료(입력 시)
    const gpi = rentY + marketRentVacant + deposit * (input.depositYield ?? 0.03) + (input.otherIncome || 0);
    const vac = input.vacancy ?? 0.05;
    const egi = gpi * (1 - vac);
    const opex = gpi * (input.opexRatio ?? 0.20) + (input.opexFixed || 0);
    return { rentY, deposit, gpi, egi, opex, noi: egi - opex, vacancy: vac };
  }

  // ---------- 2. 요구수익률 / 환원율 ----------
  function capRates(p) {
    // p: { riskFree(국고채10y), premium, growth, marketCap(실거래 역산), loanRate }
    const buyer = Math.max((p.riskFree ?? 0.044) + (p.premium ?? 0.02) - (p.growth ?? 0.02), (p.loanRate ?? 0.044) + 0.002);
    const neutral = p.marketCap ?? 0.040;
    const seller = Math.max(0.02, neutral - 0.0035);
    return { buyer, neutral, seller };
  }
  function incomeValue(noiAmt, cap) { return cap > 0 ? noiAmt / cap : 0; }

  // ---------- 3. WACC·NPV ----------
  function wacc(p) {
    const ltv = p.ltv ?? 0.5, rd = p.loanRate ?? 0.044, t = p.corpTax ?? 0.19;
    const re = (p.riskFree ?? 0.044) + (p.equityPremium ?? 0.036);
    return { wacc: ltv * rd * (1 - (p.ownerType === 'corp' ? t : 0)) + (1 - ltv) * re, re, rd };
  }
  function npvMaxPrice(p) {
    // p: { noi, growth, years, exitCap, saleCost, acqCostRate, discount }
    const g = p.growth ?? 0.02, T = p.years ?? 10, ex = p.exitCap ?? 0.042;
    let pv = 0;
    for (let y = 1; y <= T; y++) pv += p.noi * Math.pow(1 + g, y - 1) / Math.pow(1 + p.discount, y);
    const tv = p.noi * Math.pow(1 + g, T) / ex * (1 - (p.saleCost ?? 0.01));
    pv += tv / Math.pow(1 + p.discount, T);
    return { pv, maxPrice: pv / (1 + (p.acqCostRate ?? 0.056)) };
  }

  // ---------- 4. 대출·DSCR ----------
  function debt(price, p) {
    const loan = price * (p.ltv ?? 0.5), r = p.loanRate ?? 0.044;
    const interestOnly = p.interestOnly !== false; // 기본 이자만
    const n = p.amortYears ?? 20;
    const annual = interestOnly ? loan * r : pmt(loan, r, n);
    return { loan, annualService: annual, interest1: loan * r };
  }
  function dscr(noiAmt, annualService) { return annualService > 0 ? noiAmt / annualService : null; }
  function dscrGrade(d) { return d == null ? '-' : d >= 1.3 ? '안정' : d >= 1.2 ? '보통' : d >= 1.0 ? '주의' : '위험'; }

  // ---------- 5. 보유세 ----------
  function holdingTax(p) {
    // p: { landPublic(공시지가 총액), landClass:'separate'|'aggregate'|'farm', buildingStd(건물 시가표준액), year }
    const L = LAW.propTax, C = LAW.cpt;
    const base = (p.landPublic || 0) * L.fairRatio;
    let landTax = 0;
    if (p.landClass === 'farm') landTax = base * L.farm;
    else landTax = progressive(base, p.landClass === 'aggregate' ? L.aggregate : L.separate);
    const bldgTax = (p.buildingStd || 0) * L.fairRatio * L.building;
    const urban = ((p.landPublic || 0) + (p.buildingStd || 0)) * L.fairRatio * L.urbanAreaRate;
    const edu = (landTax + bldgTax) * L.eduRate;
    let cpt = 0;
    if (p.landClass === 'separate' || p.landClass === 'aggregate') {
      const cfg = C[p.landClass]; const b = Math.max(0, (p.landPublic || 0) - cfg.deduct) * C.fairRatio;
      const br = (p.landClass === 'aggregate' && (p.year || 2026) >= 2028) ? cfg.brackets.map(([l, r], i, a) => i === a.length - 1 ? [l, cfg.top2028] : [l, r]) : cfg.brackets;
      cpt = progressive(b, br); cpt = Math.max(0, cpt - landTax * 0.0); // 재산세 공제는 상세 계산 생략(보수적)
      cpt *= 1.2; // 농어촌특별세 20%
    }
    return { propertyTax: landTax + bldgTax, urbanTax: urban, eduTax: edu, cpt, total: landTax + bldgTax + urban + edu + cpt };
  }

  // ---------- 6. 현금흐름 ----------
  function cashflow(p) {
    // p: { price, noi, growth, years, exitCap, ltv, loanRate, interestOnly, amortYears, acqCostRate, saleCost, deposit, holdingTaxY, capexRatio }
    const T = p.years ?? 10, g = p.growth ?? 0.02;
    const d = debt(p.price, p);
    const equity = p.price * (1 - (p.ltv ?? 0.5)) + p.price * (p.acqCostRate ?? 0.056) - (p.deposit || 0);
    const rows = []; const cfs = [-equity]; let loanBal = d.loan; let cum = -equity;
    for (let y = 1; y <= T; y++) {
      const n = p.noi * Math.pow(1 + g, y - 1) - (p.holdingTaxY || 0) - p.noi * (p.capexRatio || 0);
      let interest = loanBal * (p.loanRate ?? 0.044), principal = 0;
      if (p.interestOnly === false) { principal = d.annualService - interest; loanBal -= principal; }
      let cf = n - interest - principal; let sale = 0, saleNet = 0;
      if (y === T) {
        sale = p.noi * Math.pow(1 + g, T) / (p.exitCap ?? 0.042);
        saleNet = sale * (1 - (p.saleCost ?? 0.01)) - loanBal - (p.deposit || 0);
        cf += saleNet;
      }
      cum += cf; cfs.push(cf);
      rows.push({ year: y, noi: n, interest, principal, cf, sale, saleNet, cum, loanBal });
    }
    const salePrice = rows[T - 1].sale;
    return { equity, loan: d.loan, rows, irr: irr(cfs), salePrice, capitalGain: salePrice - p.price,
      cashYield1: rows[0].cf / equity, equityMultiple: (cum + equity) / equity, totalCF: cum + equity };
  }

  // ---------- 7. 토지 평가 ----------
  function landValue(p) {
    // p: { area, publicPricePerSqm, comps:[{pricePerSqm}], ratioDefault, far(용적률), bcr, devUnitPrice, discounts:[{label, rate}] }
    const unitQ = { q25: quantile(p.comps.map(c => c.pricePerSqm), 0.25), q50: quantile(p.comps.map(c => c.pricePerSqm), 0.5), q75: quantile(p.comps.map(c => c.pricePerSqm), 0.75) };
    const ratio = unitQ.q50 && p.publicPricePerSqm ? unitQ.q50 / p.publicPricePerSqm : (p.ratioDefault ?? 2.0);
    const byRatio = (p.publicPricePerSqm || 0) * p.area * ratio;
    const byComps = { low: (unitQ.q25 || 0) * p.area, mid: (unitQ.q50 || 0) * p.area, high: (unitQ.q75 || 0) * p.area };
    const dev = p.far && p.devUnitPrice ? p.area * p.far * p.devUnitPrice * 0.35 : null; // 잔여법 간이: 분양가의 35%를 토지가 상한
    const disc = (p.discounts || []).reduce((s, d) => s + d.rate, 0);
    const buyer = (byComps.low || byRatio) * (1 - disc), seller = Math.max(byComps.high || 0, byRatio) * (1 - disc * 0.5);
    return { unitQ, ratio, byRatio, byComps, devCap: dev, discountRate: disc, buyer, seller, neutral: (byComps.mid || byRatio) * (1 - disc) };
  }
  function farmlandLevy(publicPricePerSqm, area) {
    const per = Math.min(publicPricePerSqm * LAW.farmlandLevy.rate, LAW.farmlandLevy.capPerSqm);
    return per * area;
  }

  // ---------- 8. 사업용·비사업용 판정 (시행령 §168의6, 일수) ----------
  function bizUseJudgement(p) {
    // p: { acquired:'YYYY-MM-DD', transfer:'YYYY-MM-DD', bizPeriods:[{from,to}] }
    const own = daysBetween(p.acquired, p.transfer);
    const inWin = (from, to) => (p.bizPeriods || []).reduce((s, b) => {
      const a = Math.max(new Date(b.from), new Date(from)), e = Math.min(new Date(b.to), new Date(to));
      return s + Math.max(0, Math.round((e - a) / 86400000));
    }, 0);
    const t = new Date(p.transfer);
    const d5 = new Date(t); d5.setFullYear(d5.getFullYear() - 5);
    const d3 = new Date(t); d3.setFullYear(d3.getFullYear() - 3);
    const biz5 = inWin(d5, t), biz3 = inWin(d3, t), bizAll = inWin(p.acquired, p.transfer);
    const ownY = own / 365.25;
    let tests;
    if (ownY >= 5) tests = [
      { label: '양도일 직전 5년 중 3년 이상 사업 사용', ok: biz5 >= 3 * 365.25, have: biz5, need: 3 * 365.25 },
      { label: '양도일 직전 3년 중 2년 이상 사업 사용', ok: biz3 >= 2 * 365.25, have: biz3, need: 2 * 365.25 },
      { label: '소유기간의 60% 이상 사업 사용', ok: bizAll >= own * 0.6, have: bizAll, need: own * 0.6 }];
    else if (ownY >= 3) tests = [
      { label: '소유기간 중 3년 이상 사업 사용', ok: bizAll >= 3 * 365.25, have: bizAll, need: 3 * 365.25 },
      { label: '양도일 직전 3년 중 2년 이상 사업 사용', ok: biz3 >= 2 * 365.25, have: biz3, need: 2 * 365.25 },
      { label: '소유기간의 60% 이상 사업 사용', ok: bizAll >= own * 0.6, have: bizAll, need: own * 0.6 }];
    else tests = [
      { label: '소유기간 중 2년 이상 사업 사용', ok: bizAll >= 2 * 365.25, have: bizAll, need: 2 * 365.25 },
      { label: '소유기간의 60% 이상 사업 사용', ok: bizAll >= own * 0.6, have: bizAll, need: own * 0.6 }];
    const business = tests.some(x => x.ok);
    const daysToBiz = business ? 0 : Math.ceil(Math.min(...tests.map(x => x.need - x.have)));
    return { business, ownDays: own, ownYears: ownY, tests, daysToBiz, basis: '소득세법 §104의3, 시행령 §168의6' };
  }

  // ---------- 9. 양도세 ----------
  function capitalGainsTax(p) {
    // p: { price, acquiredPrice, expenses, acquired, transfer, business(bool), scenario:'now'|'reform', ownerType:'indiv'|'corp', shares(지분율) }
    const years = yearsBetween(p.acquired, p.transfer);
    const gainAll = p.price - p.acquiredPrice - (p.expenses || 0);
    const share = p.share ?? 1; const gain = Math.max(0, gainAll) * share;
    if (p.ownerType === 'corp') {
      const corp = progressive(gain, LAW.corpBrackets);
      const extra = p.business ? 0 : gain * (p.scenario === 'reform' ? LAW.corpNonbizExtra2028 : LAW.corpNonbizExtraNow);
      const total = (corp + extra) * (1 + LAW.localTaxRate);
      return { gain, taxable: gain, corpTax: corp, extraTax: extra, localTax: (corp + extra) * LAW.localTaxRate, total, effective: gain > 0 ? total / gain : 0, years, note: '법인세 + 토지등 양도소득 추가과세(법인세법 §55의2)' };
    }
    let ltRate = LAW.ltDeduct(years);
    if (!p.business && p.scenario === 'reform') ltRate = 0; // 2028~ 비사업용 장특공제 배제
    const ltDeduct = gain * ltRate;
    const taxable = Math.max(0, gain - ltDeduct - LAW.basicDeduction);
    let tax;
    if (years < 1) tax = taxable * LAW.shortHold1y;
    else if (years < 2) tax = taxable * LAW.shortHold2y;
    else tax = progressive(taxable, LAW.basicBrackets, p.business ? 0 : (p.scenario === 'reform' ? LAW.nonbizSurcharge2028 : LAW.nonbizSurchargeNow));
    if (!p.business && years >= 2) { // 비사업용은 중과세율과 단기세율 중 큰 것(§104①)
      tax = Math.max(tax, 0);
    }
    const local = tax * LAW.localTaxRate;
    return { gain, ltRate, ltDeduct, taxable, tax, localTax: local, total: tax + local, effective: gain > 0 ? (tax + local) / gain : 0, years };
  }
  function timingSimulation(p) {
    // 2026/2027/2028 양도 + 사업용 전환 후 — p: capitalGainsTax 입력 + judgement
    const out = [];
    for (const y of [2026, 2027, 2028]) {
      const transfer = y + '-12-15';
      const scenario = y >= 2028 ? 'reform' : 'now';
      const j = bizUseJudgement({ acquired: p.acquired, transfer, bizPeriods: p.bizPeriods || [] });
      const t = capitalGainsTax(Object.assign({}, p, { transfer, scenario, business: j.business }));
      out.push({ label: y + '년 양도', year: y, scenario, business: j.business, tax: t.total, effective: t.effective, net: p.price - t.total - (p.sellCosts || 0) });
    }
    const tb = capitalGainsTax(Object.assign({}, p, { transfer: '2028-12-15', scenario: 'reform', business: true }));
    out.push({ label: '사업용 전환 후 양도', year: null, scenario: 'reform', business: true, tax: tb.total, effective: tb.effective, net: p.price - tb.total - (p.sellCosts || 0) });
    return out;
  }

  // ---------- 10. 취득세·부가세 ----------
  function acquisitionTax(p) {
    // p: { price, buildingShare, type, ownerType, bigCity, farmSelf2y }
    const A = LAW.acqTax; let rate;
    if (p.type === 'farm') rate = p.farmSelf2y ? A.farmSelf2y : A.farm; else rate = A.land;
    if (p.ownerType === 'corp' && p.bigCity) rate = A.bigCityCorp;
    const main = p.price * rate; const surtax = main * A.surtaxRatio;
    return { rate, main, surtax, total: main + surtax, effective: rate * (1 + A.surtaxRatio) };
  }
  function vat(p) { const b = p.price * (p.buildingShare || 0); return p.comprehensiveTransfer ? 0 : b * LAW.vatBuilding; }

  // ---------- 11. 매도자 WTA 역산 ----------
  function wta(p) {
    // p: { acquiredPrice, targetNet(목표 세후 수익), sellCostRate, loanBalance, taxFn(price)->total }
    const need = p.acquiredPrice + (p.targetNet || 0);
    let lo = p.acquiredPrice * 0.5, hi = Math.max(p.acquiredPrice, 1) * 10;
    const netOf = price => price - p.taxFn(price) - price * (p.sellCostRate ?? 0.009) - (p.vat || 0);
    for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (netOf(mid) < need) lo = mid; else hi = mid; }
    return { wta: hi, netAtWta: netOf(hi), need };
  }

  // ---------- 12. ZOPA·등급·결정 ----------
  function zopa(p) {
    // p: { wtp, wta, ask, sellerHope, buyerHope, weight(매수자 우위 0.4) }
    const w = p.weight ?? 0.4; const has = p.wtp >= p.wta;
    const zone = has ? { low: p.wta, high: p.wtp } : null;
    let recommended = has ? p.wta + (p.wtp - p.wta) * w : (p.wta + p.wtp) / 2;
    if (has && p.ask > 0 && p.ask <= p.wtp && p.ask >= p.wta) recommended = Math.min(recommended, p.ask);
    const gap = has ? 0 : p.wta - p.wtp;
    return { hasZone: has, zone, recommended, gap, gapPct: p.wta ? gap / p.wta : 0,
      askGapPct: p.ask ? (recommended - p.ask) / p.ask : null,
      buyerHopeIn: has && p.buyerHope >= p.wta && p.buyerHope <= p.wtp,
      sellerHopeIn: has && p.sellerHope >= p.wta && p.sellerHope <= p.wtp };
  }
  function grade(p) {
    // p: { hasZone, spread, dscr, riskBad(치명 리스크 수), riskWarn }
    let score = 0;
    if (p.hasZone) score += 2; if (p.spread == null) score += 1; else if (p.spread >= 0.015) score += 2; else if (p.spread >= 0) score += 1;
    if ((p.dscr ?? 0) >= 1.3) score += 2; else if ((p.dscr ?? 0) >= 1.2) score += 1;
    if ((p.riskBad || 0) === 0) score += 2; else score -= 1;
    if ((p.riskWarn || 0) === 0) score += 1;
    let g = score >= 8 ? 'A' : score >= 6 ? 'B' : score >= 3 ? 'C' : 'D';
    if (p.noIncome && g === 'A') g = 'B';
    return { grade: g, score, label: { A: '매수 적극 검토', B: '조건 충족 시 매수', C: '조건부 협상', D: '보류·재검토' }[g] };
  }

  // ---------- 13. 통합 평가 ----------
  function evaluate(c) {
    // c: 케이스 객체 (app.js에서 구성)
    const type = TYPES[c.type] || TYPES.retail;
    const mkt = c.market || {};
    const riskDeduct = (c.risks || []).reduce((s, r) => s + (r.deduct || 0), 0);
    const riskBad = (c.risks || []).filter(r => r.status === 'bad').length;
    const riskWarn = (c.risks || []).filter(r => r.status === 'warn').length;
    const res = { type, riskDeduct, riskBad, riskWarn };
    const compsUnit = (c.comps || []).filter(x => x.use !== false && x.pricePerSqm > 0).map(x => x.pricePerSqm);
    const compsTotal = (c.comps || []).filter(x => x.use !== false && x.price > 0).map(x => x.price);
    if (type.income) {
      if ((!c.rentroll || !c.rentroll.length) && c.marketRentPerSqm > 0 && (c.exclusiveArea || c.gfa) > 0) { const area = c.exclusiveArea || c.gfa; c = Object.assign({}, c, { rentroll: [{ floor: '추정', tenant: '시장임대료 추정', deposit: c.marketRentPerSqm * area * 10, rent: c.marketRentPerSqm * area, vacant: false }] }); res.rentEstimated = true; }
      const n = noi(c); res.noi = n;
      const caps = capRates({ riskFree: mkt.riskFree, premium: c.premium ?? type.premium, growth: c.growth, marketCap: mkt.marketCap ?? c.marketCap, loanRate: c.loanRate }); res.caps = caps;
      res.value = { buyer: incomeValue(n.noi, caps.buyer), neutral: incomeValue(n.noi, caps.neutral), seller: incomeValue(n.noi, caps.seller) };
      const w = wacc({ ltv: c.ltv, loanRate: c.loanRate, riskFree: mkt.riskFree, equityPremium: c.equityPremium, ownerType: c.buyerType, corpTax: 0.19 }); res.wacc = w;
      res.npv = npvMaxPrice({ noi: n.noi, growth: c.growth, years: c.years || 10, exitCap: (caps.neutral + 0.002), saleCost: 0.01, acqCostRate: c.acqCostRate ?? 0.056, discount: w.wacc });
      const bldgUnit = (c.comps || []).filter(x => x.use !== false && x.pricePerSqmBldg > 0).map(x => x.pricePerSqmBldg);
      let compsVal = null;
      if (c.saleScope === 'part' && c.exclusiveArea && bldgUnit.length) {
        const areas = (c.comps || []).filter(x => x.use !== false && x.bldgArea > 0).map(x => x.bldgArea); const medArea = quantile(areas, 0.5) || 0;
        const bulk = (medArea > 0 && c.exclusiveArea > 5 * medArea) ? (c.bulkDiscount ?? 0.30) : 0;
        compsVal = { low: quantile(bldgUnit, 0.25) * c.exclusiveArea * (1 - bulk), mid: quantile(bldgUnit, 0.5) * c.exclusiveArea * (1 - bulk), high: quantile(bldgUnit, 0.75) * c.exclusiveArea * (1 - bulk), basis: '전용면적 단가' + (bulk ? ` × (1 − 일괄매각 할인 ${Math.round(bulk * 100)}%, 사례 중앙 ${Math.round(medArea)}㎡ 대비 ${Math.round(c.exclusiveArea / medArea)}배 규모)` : ''), bulkDiscount: bulk, medArea };
      }
      else if (compsUnit.length && c.landArea && c.saleScope !== 'part') compsVal = { low: quantile(compsUnit, 0.25) * c.landArea, mid: quantile(compsUnit, 0.5) * c.landArea, high: quantile(compsUnit, 0.75) * c.landArea, basis: '토지면적 단가' };
      res.compsVal = compsVal;
      const noIncome = !(n.noi > 0);
      const candidates = noIncome ? (compsVal ? [compsVal.low] : [0]) : [res.value.buyer, res.npv.maxPrice].concat(compsVal ? [compsVal.low] : []);
      res.wtpRaw = Math.min.apply(null, candidates); res.noIncome = noIncome;
      res.wtp = Math.max(0, res.wtpRaw - riskDeduct);
      res.sellerFair = Math.max(res.value.neutral, compsVal ? compsVal.mid : 0);
      const price = res.value.neutral > 0 ? res.value.neutral : (compsVal ? compsVal.mid : (c.ask || 0));
      const share = (c.saleScope === 'part' && c.exclusiveArea && c.gfa) ? Math.min(1, c.exclusiveArea / c.gfa) : 1; res.landShare = share;
      const ht = holdingTax({ landPublic: (c.landPublic || 0) * share, landClass: 'separate', buildingStd: (c.buildingStd || 0) * (c.saleScope === 'part' ? 1 : 1) }); res.holdingTax = ht;
      res.cf10 = cashflow({ price, noi: n.noi, growth: c.growth, years: 10, exitCap: caps.neutral + 0.002, ltv: c.ltv, loanRate: c.loanRate, interestOnly: c.interestOnly !== false, amortYears: 20, acqCostRate: c.acqCostRate ?? 0.056, deposit: n.deposit, holdingTaxY: ht.total, capexRatio: c.capexRatio || 0 });
      res.cf5 = cashflow({ price, noi: n.noi, growth: c.growth, years: 5, exitCap: caps.neutral + 0.002, ltv: c.ltv, loanRate: c.loanRate, interestOnly: c.interestOnly !== false, amortYears: 20, acqCostRate: c.acqCostRate ?? 0.056, deposit: n.deposit, holdingTaxY: ht.total, capexRatio: c.capexRatio || 0 });
      const d = debt(price, { ltv: c.ltv, loanRate: c.loanRate, interestOnly: false, amortYears: 20 });
      res.dscr = dscr(n.noi - ht.total, d.annualService); res.dscrIO = dscr(n.noi - ht.total, d.interest1); res.debt = d;
      res.askYield = c.ask ? { gross: n.rentY / (c.ask - n.deposit), noi: n.noi / (c.ask - n.deposit), cap: n.noi / c.ask } : null;
      res.spread = noIncome ? null : (res.cf10.irr ?? 0) - (mkt.riskFree ?? 0.044);
      res.sensitivity = [0.040, 0.045, 0.050, 0.055].map(cap => ({ cap, cells: [0.05, 0.10, 0.15, 0.20].map(v => { const nn = noi(Object.assign({}, c, { vacancy: v })).noi; return { vacancy: v, value: nn / cap }; }) }));
    } else {
      const lv = landValue({ area: c.landArea || 0, publicPricePerSqm: c.publicPricePerSqm || 0, comps: (c.comps || []).filter(x => x.use !== false && x.pricePerSqm > 0), ratioDefault: c.ratioDefault, far: c.far, devUnitPrice: c.devUnitPrice, discounts: (c.risks || []).filter(r => r.rate).map(r => ({ label: r.label, rate: r.rate })) });
      res.land = lv;
      const levy = c.type === 'farm' ? farmlandLevy(c.publicPricePerSqm || 0, c.landArea || 0) : (c.type === 'forest' ? (c.forestLevy || 0) : 0);
      res.conversionLevy = levy;
      const holdY = c.holdYearsPlan || 5; const req = (mkt.riskFree ?? 0.044) + 0.015;
      res.wtpRaw = lv.buyer; res.wtp = Math.max(0, lv.buyer - riskDeduct - levy * (c.willConvert ? 1 : 0));
      res.sellerFair = lv.seller;
      res.landRequired = req; // 토지 요구 연복리 상승률
      const ht = holdingTax({ landPublic: (c.publicPricePerSqm || 0) * (c.landArea || 0), landClass: c.type === 'farm' || c.type === 'forest' ? 'farm' : 'aggregate' }); res.holdingTax = ht;
      // 토지 5·10년: 지가상승률 g, 보유세 비용, 매각
      const landCF = T => { const price = lv.neutral; const g = c.landGrowth ?? 0.02; const sale = price * Math.pow(1 + g, T); const equity = price * (1 + (c.acqCostRate ?? 0.046)) + levy * (c.willConvert ? 1 : 0); const cfs = [-equity]; for (let y = 1; y <= T; y++) cfs.push(y === T ? sale * 0.99 - ht.total : -ht.total); return { equity, sale, irr: irr(cfs), capitalGain: sale - price, holdTax: ht.total * T }; };
      res.cf5 = landCF(5); res.cf10 = landCF(10);
      res.spread = (res.cf10.irr ?? 0) - (mkt.riskFree ?? 0.044);
      res.dscr = null;
    }
    // 매도자
    if (c.seller && c.seller.acquiredPrice) {
      const s = c.seller; const transfer = s.transfer || new Date().toISOString().slice(0, 10);
      const j = bizUseJudgement({ acquired: s.acquired, transfer, bizPeriods: s.bizPeriods || [] }); res.judgement = j;
      const bizForTax = type.income ? true : j.business; // 건물 부속토지(배율 이내)는 사업용 가정
      const scen = transfer >= LAW.reformDate ? 'reform' : 'now';
      const taxFn = price => capitalGainsTax({ price, acquiredPrice: s.acquiredPrice, expenses: s.expenses || 0, acquired: s.acquired, transfer, business: bizForTax, scenario: scen, ownerType: s.ownerType || 'indiv', share: s.share ?? 1 }).total;
      const w = wta({ acquiredPrice: s.acquiredPrice, targetNet: s.targetNet || 0, sellCostRate: s.sellCostRate ?? 0.009, taxFn, vat: s.vat || 0 }); res.wta = w;
      res.sellerTax = { now: capitalGainsTax({ price: c.ask || res.sellerFair, acquiredPrice: s.acquiredPrice, expenses: s.expenses || 0, acquired: s.acquired, transfer, business: false, scenario: 'now', ownerType: s.ownerType || 'indiv', share: s.share ?? 1 }),
        reform: capitalGainsTax({ price: c.ask || res.sellerFair, acquiredPrice: s.acquiredPrice, expenses: s.expenses || 0, acquired: s.acquired, transfer, business: false, scenario: 'reform', ownerType: s.ownerType || 'indiv', share: s.share ?? 1 }),
        biz: capitalGainsTax({ price: c.ask || res.sellerFair, acquiredPrice: s.acquiredPrice, expenses: s.expenses || 0, acquired: s.acquired, transfer, business: true, scenario: scen, ownerType: s.ownerType || 'indiv', share: s.share ?? 1 }) };
      res.timing = timingSimulation({ price: c.ask || res.sellerFair, acquiredPrice: s.acquiredPrice, expenses: s.expenses || 0, acquired: s.acquired, bizPeriods: type.income ? [{ from: s.acquired, to: '2099-12-31' }] : (s.bizPeriods || []), ownerType: s.ownerType || 'indiv', share: s.share ?? 1, sellCosts: (c.ask || res.sellerFair) * (s.sellCostRate ?? 0.009) });
      res.wtaFinal = Math.max(w.wta, res.sellerFair * 0.97);
    } else {
      res.wtaFinal = res.sellerFair * 0.97; res.wta = null;
    }
    if (c.ask > 0 && res.wtaFinal > c.ask) { res.wtaComputed = res.wtaFinal; res.wtaFinal = c.ask; } // 매도자가 호가를 제시했다면 호가 이하는 수용 가능
    res.acqTax = acquisitionTax({ price: res.wtp || c.ask || 0, type: c.type, ownerType: c.buyerType, bigCity: c.bigCity, farmSelf2y: c.farmSelf2y });
    res.zopa = zopa({ wtp: res.wtp, wta: res.wtaFinal, ask: c.ask, sellerHope: c.sellerHope, buyerHope: c.buyerHope, weight: c.zopaWeight ?? 0.4 });
    res.grade = grade({ hasZone: res.zopa.hasZone, spread: res.spread, dscr: (res.dscr == null || res.noIncome) ? 1.3 : res.dscr, riskBad, riskWarn, noIncome: !!res.noIncome });
    return res;
  }

  return { LAW, TYPES, progressive, irr, pmt, quantile, daysBetween, yearsBetween, noi, capRates, incomeValue, wacc, npvMaxPrice, debt, dscr, dscrGrade, holdingTax, cashflow, landValue, farmlandLevy, bizUseJudgement, capitalGainsTax, timingSimulation, acquisitionTax, vat, wta, zopa, grade, evaluate };
});
