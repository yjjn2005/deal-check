// node tests/test-calc.js
const C = require('../calc.js');
let pass = 0, fail = 0;
function eq(name, a, b, tol) { tol = tol ?? 1; const ok = Math.abs(a - b) <= tol; (ok ? pass++ : fail++); console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + ' → ' + a + (ok ? '' : ' (기대 ' + b + ')')); }
function ok(name, v) { (v ? pass++ : fail++); console.log((v ? 'PASS' : 'FAIL') + ' ' + name); }

// 1. NOI (보고서 예시: GPI 1.86억, EGI 1.767억, NOI 1.395억)
const rr = [{ deposit: 200000000, rent: 15000000 }];
const n = C.noi({ rentroll: rr, depositYield: 0.03, vacancy: 0.05, opexRatio: 0.20 });
eq('GPI', n.gpi, 186000000); eq('EGI', n.egi, 176700000); eq('NOI', n.noi, 139500000);
// 2. 환원 (4.5% → 31억, 4.0% → 34.875억)
eq('수익가액 4.5%', C.incomeValue(n.noi, 0.045), 3100000000);
eq('수익가액 4.0%', C.incomeValue(n.noi, 0.040), 3487500000);
// 3. WACC·NPV (보고서: WACC 5.78%, PV 3,410,373,512, 최대 3,229,520,371)
const w = C.wacc({ ltv: 0.5, loanRate: 0.044, riskFree: 0.044, equityPremium: 0.036, ownerType: 'corp', corpTax: 0.19 });
eq('WACC', w.wacc, 0.05782, 0.0001);
const np = C.npvMaxPrice({ noi: n.noi, growth: 0.02, years: 10, exitCap: 0.042, saleCost: 0.01, acqCostRate: 0.056, discount: 0.05782 });
eq('NPV PV', np.pv, 3410373512, 2000000); eq('최대지불', np.maxPrice, 3229520371, 2000000);
// 4. DSCR (대출 1,614,760,185 · 4.4% 20년 → 연 123,063,210 → 1.13)
const d = C.debt(3229520371, { ltv: 0.5, loanRate: 0.044, interestOnly: false, amortYears: 20 });
eq('연원리금', d.annualService, 123063210, 200000); eq('DSCR', C.dscr(n.noi, d.annualService), 1.13, 0.01);
// 5. 현금흐름 10년 (보고서: 자기자본 1,739,050,000, 1년차 CF 62,775,000, 매각가 4,048,802,895, IRR 5.73%)
const cf = C.cashflow({ price: 3487500000, noi: n.noi, growth: 0.02, years: 10, exitCap: 0.042, ltv: 0.5, loanRate: 0.044, interestOnly: true, acqCostRate: 0.056, deposit: 200000000, saleCost: 0.01 });
eq('자기자본', cf.equity, 1739050000); eq('1년차 CF', cf.rows[0].cf, 62775000); eq('매각가', cf.salePrice, 4048802895, 2); eq('IRR', cf.irr, 0.0573, 0.0005);
// 6. 양도세 (양도차익 10억, 15년, 비사업용 현행 359,436,000 / 개편 640,761,000 / 사업용 282,711,000)
const base = { price: 3000000000, acquiredPrice: 2000000000, expenses: 0, acquired: '2011-06-01', transfer: '2026-12-15' };
eq('비사업용 현행', C.capitalGainsTax(Object.assign({}, base, { business: false, scenario: 'now' })).total, 359436000);
eq('비사업용 개편', C.capitalGainsTax(Object.assign({}, base, { business: false, scenario: 'reform' })).total, 640761000);
eq('사업용', C.capitalGainsTax(Object.assign({}, base, { business: true, scenario: 'now' })).total, 282711000);
// 7. 법인 (10억 차익: 법인세 2억×9%+8억×19%=1.7억, 추가 10% 1억 → 2.7억×1.1 = 2.97억)
eq('법인 비사업용', C.capitalGainsTax(Object.assign({}, base, { business: false, scenario: 'now', ownerType: 'corp' })).total, 297000000);
// 8. 사업용 판정: 15년 보유, 최근 5년 전부 사업 사용 → 사업용
const j = C.bizUseJudgement({ acquired: '2011-06-01', transfer: '2026-12-15', bizPeriods: [{ from: '2021-01-01', to: '2026-12-15' }] });
ok('판정 사업용', j.business === true);
const j2 = C.bizUseJudgement({ acquired: '2011-06-01', transfer: '2026-12-15', bizPeriods: [{ from: '2025-06-01', to: '2026-12-15' }] });
ok('판정 비사업용 + 잔여일수>0', j2.business === false && j2.daysToBiz > 0);
// 9. 취득세 4.6%
eq('취득세', C.acquisitionTax({ price: 1000000000, type: 'retail' }).total, 46000000);
eq('농지 취득세 3.4%', C.acquisitionTax({ price: 1000000000, type: 'farm' }).total, 34500000, 600000);
// 10. 농지보전부담금 (공시지가 ㎡당 20만 → 30% = 6만 > 상한 5만 → 5만×1000㎡)
eq('농지보전부담금', C.farmlandLevy(200000, 1000), 50000000);
// 11. WTA 역산: 취득가 20억 + 목표 세후 6억 → 세후순수입이 26억이 되는 가격
const taxFn = price => C.capitalGainsTax({ price, acquiredPrice: 2000000000, acquired: '2011-06-01', transfer: '2026-12-15', business: true, scenario: 'now' }).total;
const wt = C.wta({ acquiredPrice: 2000000000, targetNet: 600000000, sellCostRate: 0.009, taxFn });
eq('WTA 세후순수입=목표', wt.netAtWta, 2600000000, 1000);
// 12. ZOPA
const z = C.zopa({ wtp: 3100000000, wta: 3382875000, ask: 5000000000 });
ok('ZOPA 미형성', z.hasZone === false); eq('성사가 중간값', z.recommended, 3241437500);
const z2 = C.zopa({ wtp: 3500000000, wta: 3300000000, weight: 0.4 }); eq('ZOPA 추천점', z2.recommended, 3380000000);
// 13. 보유세: 별도합산 공시지가 20억 → 재산세 4,760,000
eq('재산세 별도합산(과표=공시가×70%)', C.holdingTax({ landPublic: 2000000000, landClass: 'separate' }).propertyTax, 4400000);
// 14. 통합 evaluate 실행
const ev = C.evaluate({ type: 'retail', rentroll: rr, depositYield: 0.03, vacancy: 0.05, opexRatio: 0.2, ltv: 0.5, loanRate: 0.044, growth: 0.02, landArea: 495, ask: 5000000000, sellerHope: 4200000000, buyerHope: 3000000000, market: { riskFree: 0.04407, marketCap: 0.04 }, risks: [{ label: '위반건축물', status: 'bad', deduct: 38000000 }], seller: { acquiredPrice: 2100000000, acquired: '2011-06-01', targetNet: 600000000 } });
ok('evaluate wtp>0', ev.wtp > 0 && ev.wtaFinal > 0 && ev.grade.grade);
console.log('WTP', Math.round(ev.wtp), 'WTA', Math.round(ev.wtaFinal), '등급', ev.grade.grade, 'IRR', ev.cf10.irr);
const evl = C.evaluate({ type: 'farm', landArea: 3000, publicPricePerSqm: 120000, comps: [{ pricePerSqm: 250000 }, { pricePerSqm: 280000 }, { pricePerSqm: 300000 }], ask: 1000000000, market: { riskFree: 0.044 }, seller: { acquiredPrice: 300000000, acquired: '2008-03-01', bizPeriods: [] } });
ok('농지 evaluate', evl.wtp > 0 && evl.conversionLevy > 0 && evl.judgement.business === false);
console.log('농지 WTP', Math.round(evl.wtp), 'WTA', Math.round(evl.wtaFinal), '부담금', evl.conversionLevy, 'timing', evl.timing.map(t => Math.round(t.tax)));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
