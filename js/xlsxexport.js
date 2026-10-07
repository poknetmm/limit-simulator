/* ============================================================================
   전략 → 엑셀(수식) 통합 문서
   ----------------------------------------------------------------------------
   웹 계산 엔진과 같은 결과가 나오도록 전략의 단계를 엑셀 수식으로 옮긴다.
     시뮬레이션 시트 : 1줄 = 고객 1명. 고객 입력값 → 부채표 합계 → 단계(계산 순서) → 고른 항목
                       → 최종한도 · 상태 · 사유 · 결정요인 (→ 결과 파일만 웹 최종한도 · 웹 상태 · 일치)
     전략 파라미터 · 표 · 부채표 시트 : 값을 바꾸면 모든 줄에 반영된다
   경로를 안 지난 단계·거절 뒤 단계는 빈칸, 계산 오류는 엑셀 오류 그대로(#N/A 등).
   엔진과 맞추려고 반올림·내림은 INT로 풀어 쓰고(부동소수 여유 1E-9 포함), 조건 묶음은 IF를 이어
   앞에서 정해지면 뒤를 계산하지 않게 한다.

   build(strategy, opts) → {sheets:[{name, rows, widths}]}  (칸 = 값 | {v, z} | {f, z})
   toWorkbook(model, XLSX) → SheetJS 통합 문서
   ========================================================================== */
(function (root, factory) {
  const X = factory(root && root.LimitEngine ? root.LimitEngine : require('./engine.js'));
  if (typeof module === 'object' && module.exports) module.exports = X;
  else root.XlsxExport = X;
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const SIM = '시뮬레이션', PAR = '전략 파라미터', GUIDE = '설명';
  const NA = 'NA()', T = '1', F = '0';   // 참·거짓은 조건 자리에만 쓰므로 1·0(수식 길이를 줄인다)
  const REJECT = '거절', PASS = '통과';
  const STATUS = { ok: '정상', reject: '거절', error: '오류', input: '입력 오류' };
  const FMT = { money: '#,##0', percent: '0.00%' };
  const HEAD_ROWS = 2;          // 시뮬레이션 시트: 1줄 제목, 2줄 설명, 3줄부터 고객
  const NEST_MAX = 60;          // 엑셀 함수 중첩 한도(64) 여유
  const R = '§';                // 수식 틀의 줄 번호 자리

  class ExportError extends Error {}

  function colName(i) {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }
  const sheetRef = (name) => `'${name.replace(/'/g, "''")}'!`;
  const strLit = (s) => `"${String(s).replace(/"/g, '""')}"`;
  // 지수 표기(1e-9)는 계산기에 따라 못 읽어 소수로 쓴다
  const numLit = (n) => { const t = /e/i.test(String(n)) ? n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : String(n); return n < 0 ? `(${t})` : t; };
  const EPS = '0.000000001';   // 엔진의 부동소수 여유(1e-9)
  function lit(v) {
    if (v === null || v === undefined) return '""';
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (typeof v === 'number') return Number.isFinite(v) ? numLit(v) : NA;
    return strLit(v);
  }
  const isTableLike = (v) => v.type === 'table' || v.type === 'debt';

  function build(strategy, opts) {
    opts = opts || {};
    const issues = E.validate(strategy);
    if (issues.length) throw new ExportError(`전략에 오류가 있어 엑셀로 바꿀 수 없습니다 — ${issues.join(' / ')}`);
    if (!strategy.nodes.length) throw new ExportError('계산 단계가 없습니다');

    const idx = E.index(strategy);
    const { order: ord, deps } = E.order(strategy, idx);
    const finalId = E.finalNodeId(strategy);
    const node = (id) => idx.nodes.get(id);

    // ── 시트 이름 ──
    const used = new Set();
    const sheetName = (base) => {
      const b = String(base).replace(/[\\/?*\[\]:]/g, '_').slice(0, 28) || '시트';
      let name = b, i = 2;
      while (used.has(name)) name = `${b}_${i++}`;
      used.add(name);
      return name;
    };
    const simName = sheetName(SIM);

    // ── 전략 파라미터 시트(변수·표 엑셀 올리기와 같은 꼴: 이름 · 구분 · 형태 · 값 · 선택지 · 설명) ──
    const par = { name: sheetName(PAR), rows: [['이름', '구분', '형태', '값', '선택지', '설명']], widths: [24, 14, 12, 16, 24, 50] };
    const paramCell = new Map();
    for (const v of strategy.variables) {
      if (isTableLike(v) || v.kind === 'input') continue;
      paramCell.set(v.id, `${sheetRef(par.name)}$D$${par.rows.length + 1}`);
      par.rows.push([v.name, '전략 파라미터', E.VAR_TYPES[v.type],
        v.type === 'bool' ? (v.value ? 'Y' : 'N') : (typeof v.value === 'number' ? { v: v.value, z: FMT[v.type] } : v.value),
        v.type === 'choice' ? (v.options || []).join(' / ') : null, v.desc || null]);
    }

    // ── 표 시트(올리기와 같은 꼴: 표 이름 · 행 기준 · 열 기준 · 설명 / 빈 줄 / 제목 줄 / 값) ──
    // 칸에 계산식·빈 칸이 있는 표는 고객마다 값이 달라 시트 칸을 쓰지 않고 그 줄 안에서 CHOOSE로 풀어 쓴다
    const MODE = { list: '목록', band: '구간' };
    const tables = new Map(), tableSheets = [];
    for (const tv of strategy.variables.filter(v => v.type === 'table')) {
      const name = sheetName(`표_${tv.name}`), ref = sheetRef(name);
      const nr = tv.rows.keys.length, nc = tv.cols ? tv.cols.keys.length : 1;
      const raw = (r, c) => (tv.cells[r] || [])[c];
      const inline = tv.rows.keys.some((_, r) => Array.from({ length: nc }, (__, c) => raw(r, c))
        .some(x => x === null || x === undefined || x === '' || E.isCellFormula(x)));
      const rows = [['표 이름', tv.name], ['행 기준', MODE[tv.rows.mode]], ['열 기준', tv.cols ? MODE[tv.cols.mode] : '없음'], ['설명', tv.desc || null], [],
        [tv.cols ? '행 \\ 열' : '행', ...(tv.cols ? tv.cols.keys : ['값'])],
        ...tv.rows.keys.map((k, r) => [k, ...Array.from({ length: nc }, (_, c) => { const x = raw(r, c); return x === undefined ? null : x; })])];
      if (inline) rows.splice(4, 0, ['', '칸에 계산식·빈 칸이 있어 시뮬레이션 시트의 단계 수식 안에 이 표를 풀어 넣었습니다. 이 시트의 값을 고쳐도 반영되지 않습니다']);
      const top = inline ? 8 : 7;   // 값이 시작하는 줄
      tables.set(tv.id, {
        inline, nr, nc,
        rowKeys: `${ref}$A$${top}:$A$${top + nr - 1}`,
        colKeys: `${ref}$B$${top - 1}:$${colName(nc)}$${top - 1}`,
        values: `${ref}$B$${top}:$${colName(nc)}$${top + nr - 1}`,
        key: (i) => `${ref}$A$${top + i}`,
        cell: (r, c) => `${ref}$${colName(c + 1)}$${top + r}`,
      });
      tableSheets.push({ name, rows, widths: [16, ...new Array(nc).fill(14)] });
    }

    // ── 시뮬레이션 열 배치 ──
    const cols = [], L = new Map();
    const add = (key, head, extra) => { L.set(key, colName(cols.length)); cols.push(Object.assign({ key, head }, extra || {})); };
    const cell = (key) => `$${L.get(key)}${R}`;

    add('id', '번호', { width: 10 });
    const inputs = E.inputColumns(strategy);
    for (const c of inputs) add(`in:${c.key}`, c.label, { input: c, width: 14, desc: `고객 입력값${c.desc ? ` — ${c.desc}` : ''}`, z: FMT[c.type] });
    const debtVars = strategy.variables.filter(v => v.type === 'debt');
    for (const v of debtVars) for (const [part, label] of E.DEBT_PARTS) add(`debt:${v.id}:${part}`, `${v.name}${E.PART_SEP}${label}`, { z: FMT.money, width: 16, desc: '부채표 합계' });
    const firstStep = cols.length;
    const stepNames = [];   // [열 key, 오류 사유에 쓰는 이름]
    for (const id of ord) {
      const n = node(id), c = n.config || {};
      if (n.type === 'pva') {
        if (E.rateTokens(c).length && c.months) {
          add(`pva:${id}:rate`, `${n.name}${E.PART_SEP}금리(연)`, { z: FMT.percent, node: n, sub: 'rate' });
          add(`pva:${id}:factor`, `${n.name}${E.PART_SEP}${E.PVF_NAME}`, { node: n, sub: 'factor' });
          stepNames.push([`pva:${id}:rate`, `${n.name}${E.PART_SEP}금리`], [`pva:${id}:factor`, `${n.name}${E.PART_SEP}${E.PVF_NAME}`]);
        }
        for (const l of (c.lines || []).slice(0, -1)) {
          add(`pva:${id}:${l.id}`, `${n.name}${E.PART_SEP}${l.name}`, { z: FMT.money, node: n, sub: l.id });
          stepNames.push([`pva:${id}:${l.id}`, `${n.name}${E.PART_SEP}${l.name}`]);
        }
      }
      add(`node:${id}`, n.name, { z: FMT[n.format], node: n });
      stepNames.push([`node:${id}`, n.name]);
    }
    const lastStep = cols.length - 1;
    for (const id of ord) if (node(id).type === 'minmax') add(`chosen:${id}`, `${node(id).name}${E.PART_SEP}고른 항목`, { width: 18, desc: '최소·최대가 고른 항목' });
    add('final', '최종한도', { z: FMT.money, width: 16, desc: '거절이면 0' });
    add('status', '상태', { width: 8, desc: '정상 · 거절 · 오류' });
    add('reason', '사유', { width: 24, desc: '거절 사유 · 처음 오류가 난 단계' });
    add('det', '결정요인', { width: 20, desc: '최종한도를 정한 항목 또는 컷오프 사유' });
    if (opts.web) {
      add('webFinal', '웹 최종한도', { z: FMT.money, width: 16, desc: '웹에서 계산한 값(대조용)' });
      add('webStatus', '웹 상태', { width: 10, desc: '웹에서 계산한 상태' });
      add('match', '일치', { width: 8, desc: '엑셀 = 웹' });
    }

    // ── 경로 판정 ──
    const incoming = new Map(strategy.nodes.map(n => [n.id, []]));
    for (const e of strategy.edges) if (incoming.has(e.to)) incoming.get(e.to).push(e);
    const isBranch = (id) => idx.nodes.has(id) && node(id).type === 'branch';
    const always = new Set();   // 들어오는 화살표가 없거나 늘 지나는 단계에서 바로 오는 단계 — 경로 판정 생략
    for (const id of ord) {
      const ins = incoming.get(id);
      if (!ins.length || ins.some(e => always.has(e.from) && !isBranch(e.from))) always.add(id);
    }
    function taken(e) {
      if (!idx.nodes.has(e.from)) return F;
      const c = cell(`node:${e.from}`);
      if (isBranch(e.from)) return e.label === undefined || e.label === null ? F : `IFERROR(${c}=${strLit(e.label)},${F})`;
      return always.has(e.from) ? T : `IFERROR(${c}<>"",${T})`;   // 오류가 난 단계도 지난 것으로 본다(엔진과 같다)
    }
    function activeX(id) {
      const ts = [...new Set(incoming.get(id).map(taken))];
      if (!ts.length || ts.includes(T)) return T;
      return ts.length === 1 ? ts[0] : `OR(${ts.join(',')})`;
    }
    const nodeVal = (key, id) => (always.has(id) ? cell(key) : `IF(${cell(key)}="",${NA},${cell(key)})`);

    // ── 값 참조 → 수식 ──
    const boolX = (c) => `IF(OR(${c}=TRUE(),${c}=1,${c}="1",${c}="Y",${c}="예",${c}="TRUE"),1,0)`;
    function varX(id) {
      const v = idx.vars.get(id);
      if (!v || isTableLike(v)) return NA;
      if (v.kind === 'input') {
        const c = cell(`in:${id}`);
        if (v.type === 'bool') return `IF(${c}="",${v.value ? 1 : 0},${boolX(c)})`;
        if (v.type === 'choice') return `IF(${c}="",${strLit(v.value === null || v.value === undefined ? '' : v.value)},""&${c})`;
        return `IF(${c}="",${lit(v.value)},${c})`;
      }
      const p = paramCell.get(id);
      return v.type === 'bool' ? boolX(p) : p;
    }

    function inX(n) {
      const ins = incoming.get(n.id);
      if (ins.length < 2) return NA;
      const froms = [...new Set(ins.map(e => e.from))];
      const ts = froms.map(f => { const t = [...new Set(ins.filter(e => e.from === f).map(taken))]; return t.length === 1 ? t[0] : `OR(${t.join(',')})`; });
      const pick = froms.reduceRight((acc, f, i) => `IF(${ts[i]},${idx.nodes.has(f) ? cell(`node:${f}`) : NA},${acc})`, NA);
      return `IF(${ts.map(t => `(${t})*1`).join('+')}>1,${NA},${pick})`;
    }

    // ctx = {node, local?(ref)} — local은 기초한도 단계의 앞 줄·현가계수
    function refX(ref, ctx) {
      if (!ref) return NA;
      switch (ref.k) {
        case 'num': case 'str': return lit(ref.v);
        case 'in': return ctx.node ? inX(ctx.node) : NA;
        case 'name': {
          if (ref.v === E.IN_NAME) return ctx.node ? inX(ctx.node) : NA;
          const r = idx.byName.get(ref.v);
          return r ? refX(r, ctx) : NA;
        }
        case 'var': return varX(ref.id);
        case 'part': {
          if (idx.vars.has(ref.id)) return L.has(`debt:${ref.id}:${ref.part}`) ? cell(`debt:${ref.id}:${ref.part}`) : NA;
          if (ctx.node && ref.id === ctx.node.id) return NA;
          return L.has(`pva:${ref.id}:${ref.part}`) ? nodeVal(`pva:${ref.id}:${ref.part}`, ref.id) : NA;
        }
        case 'node':
          if (!idx.nodes.has(ref.id) || (ctx.node && ref.id === ctx.node.id)) return NA;
          return nodeVal(`node:${ref.id}`, ref.id);
        case 'line': case 'pvf': return ctx.local ? ctx.local(ref) : NA;
        case 'tbl': {
          const tv = ref.table && idx.vars.get(ref.table.id);
          if (!tv || tv.type !== 'table') return NA;
          return lookupX(tv, ref.row, tv.cols ? ref.col : null, ctx);
        }
      }
      return NA;
    }

    // ── 수식 구조(AST) → 엑셀 ──
    const unit = (d, x) => {   // 10^(−자릿수)
      if (d.k === 'num') return numLit(Math.pow(10, -d.v));
      return `10^(-(${x(d)}))`;
    };
    function astX(a, ctx) {
      const x = (b) => astX(b, ctx);
      switch (a.k) {
        case 'num': return numLit(a.v);
        case 'str': return strLit(a.v);
        case 'ref': return refX(a.ref, ctx);
        case 'name': return refX({ k: 'name', v: a.v }, ctx);
        case 'neg': return `(-(${x(a.a)}))`;
        case 'bin':
          if (E.CMP_OPS.includes(a.op)) return `((${x(a.a)})${a.op}(${x(a.b)}))*1`;
          if ('+-*/^'.includes(a.op)) return `((${x(a.a)})${a.op}(${x(a.b)}))`;
          return NA;
        case 'call': {
          const g = a.args, n = (i) => (g[i] ? x(g[i]) : null);
          switch (a.fn) {
            case 'IF': return g.length === 3 ? `IF(${n(0)},${n(1)},${n(2)})` : NA;
            case 'MIN': case 'MAX': return g.length ? `${a.fn}(${g.map(b => `(${x(b)})*1`).join(',')})` : NA;
            case 'ABS': return `ABS(${n(0)})`;
            case 'ROUND': { const u = g[1] ? unit(g[1], x) : '1'; return `INT((${n(0)})/(${u})+0.5)*(${u})`; }
            case 'ROUNDDOWN': { const u = g[1] ? unit(g[1], x) : '1', v = n(0); return `SIGN(${v})*INT(ABS(${v})/(${u})+${EPS})*(${u})`; }
            case 'ROUNDUP': { const u = g[1] ? unit(g[1], x) : '1', v = n(0); return `SIGN(${v})*(-INT(-ABS(${v})/(${u})+${EPS}))*(${u})`; }
            case 'FLOOR': case 'CEILING': {
              const s = g[1] ? `(${n(1)})` : '1', v = n(0);
              const f = a.fn === 'FLOOR' ? `INT((${v})/${s}+${EPS})*${s}` : `(-INT(-(${v})/${s}+${EPS}))*${s}`;
              return g[1] && g[1].k !== 'num' ? `IF(${s}=0,${v},${f})` : (g[1] && g[1].v === 0 ? `(${v})` : f);
            }
            case 'AND': case 'OR': return g.length ? `(${a.fn}(${g.map(x).join(',')}))*1` : NA;
            case 'NOT': return `(NOT(${n(0)}))*1`;
          }
          return NA;
        }
      }
      return NA;
    }
    const tryAst = (fn, ctx) => { try { return astX(fn(), ctx); } catch (e) { if (e instanceof E.CalcError) return NA; throw e; } };

    // 조건 묶음: 앞에서 정해지면 뒤를 계산하지 않도록 IF를 잇는다(엔진의 every·some과 같다)
    function groupX(g, ctx) {
      if (!g || !g.items || !g.items.length) return NA;
      const parts = g.items.map(it => (it.items ? groupX(it, ctx) : E.CMP_OPS.includes(it.op) ? `(${refX(it.left, ctx)}${it.op}${refX(it.right, ctx)})` : NA));
      return parts.reduceRight((acc, p) => (acc === null ? p : g.logic === 'or' ? `IF(${p},${T},${acc})` : `IF(${p},${acc},${F})`), null);
    }

    // ── 표 ──
    // 목록: 엔진은 글자로 맞춰 본다(1 = "1") — 같은 형태 → 글자 → 숫자 순으로 찾는다
    const matchX = (axis, key, range) => (axis.mode === 'band' ? `MATCH((${key})+${EPS},${range},1)`
      : `IFERROR(MATCH(${key},${range},0),IFERROR(MATCH(""&(${key}),${range},0),MATCH(--(${key}),${range},0)))`);
    function cellX(tv, r, c, ctx) {
      const v = (tv.cells[r] || [])[c];
      if (v === null || v === undefined || v === '') return NA;
      if (E.isCellFormula(v)) return tryAst(() => E.parseTokens(E.tokenize(v.trim().slice(1))), ctx);
      return lit(v);
    }
    function lookupX(tv, rowRef, colRef, ctx) {
      const t = tables.get(tv.id);
      const rm = matchX(tv.rows, refX(rowRef, ctx), t.rowKeys);
      const cm = tv.cols ? matchX(tv.cols, refX(colRef, ctx), t.colKeys) : null;
      if (!t.inline) return tv.cols ? `INDEX(${t.values},${rm},${cm})` : `INDEX(${t.values},${rm})`;
      const xs = [];
      for (let r = 0; r < t.nr; r++) for (let c = 0; c < t.nc; c++) xs.push(cellX(tv, r, c, ctx));
      if (xs.length > 254) throw new ExportError(`표 [${tv.name}]은(는) 칸에 계산식·빈 칸이 있고 칸이 254개를 넘어 엑셀 수식으로 바꿀 수 없습니다`);
      return `CHOOSE(${tv.cols ? `(${rm}-1)*${t.nc}+${cm}` : rm},${xs.join(',')})`;
    }
    function progressiveX(tv, baseRef, ctx) {
      if (!tv || tv.type !== 'table' || tv.rows.mode !== 'band' || tv.cols) return NA;
      const t = tables.get(tv.id), x = `(${refX(baseRef, ctx)})*1`;
      const terms = tv.rows.keys.map((_, i) => {
        const from = t.key(i), rate = t.inline ? cellX(tv, i, 0, ctx) : t.cell(i, 0);
        const part = i + 1 < t.nr ? `(MIN(${x},${t.key(i + 1)})-${from})` : `(${x}-${from})`;
        return `IF(${x}>${from},${part}*(${rate}),0)`;
      });
      return terms.join('+');
    }

    // ── 부채표 합계(행별 잔액 입력 열, 빈 칸은 0) ──
    const debtRows = new Map(), debtHi = new Map();
    const debtSheets = [];
    for (const v of debtVars) {
      const name = sheetName(`부채표_${v.name}`), ref = sheetRef(name);
      const hi = v.hiRate && v.hiRate.k === 'num' ? { v: v.hiRate.v, z: FMT.percent }
        : v.hiRate && v.hiRate.k === 'var' && paramCell.has(v.hiRate.id) ? { f: paramCell.get(v.hiRate.id).replace(/\$/g, ''), z: FMT.percent } : null;
      debtSheets.push({ name, widths: [16, 14, 16, 12, 16], rows: [['부채표 이름', v.name], ['설명', v.desc || null], ['고금리 기준', hi], [],
        ['업권', '대출구분', '대출기간(개월)', '대출금리', '테스트 잔액'],
        ...v.rows.map(r => [r.sector, r.kind, r.months, { v: r.rate, z: FMT.percent }, { v: r.balance || 0, z: FMT.money }])] });
      const hiX = !v.hiRate ? null : v.hiRate.k === 'num' ? `${ref}$B$3` : refX(v.hiRate, {});
      debtRows.set(v.id, v.rows.map((_, i) => {
        const r = 6 + i, key = `in:${v.id}#${i}`;
        // 잔액 빈 칸은 엑셀 계산에서 0이다
        return { bal: L.has(key) ? cell(key) : `${ref}$E$${r}`, kind: `${ref}$B$${r}`, months: `${ref}$C$${r}`, rate: `${ref}$D$${r}` };
      }));
      debtHi.set(v.id, hiX);
    }
    function debtX(v, part) {
      const rows = debtRows.get(v.id);
      const sum = (f) => rows.map(f).join('+') || '0';
      switch (part) {
        case 'pay': return sum(r => `IF(${r.bal}=0,0,PMT(${r.rate}/12,${r.months},-${r.bal}))`);
        case 'total': return sum(r => r.bal);
        case 'mort': return sum(r => `IF(${r.kind}=${strLit(E.DEBT_MORT)},${r.bal},0)`);
        case 'credit': return sum(r => `IF(${r.kind}=${strLit(E.DEBT_MORT)},0,${r.bal})`);
        case 'high': return debtHi.get(v.id) ? sum(r => `IF(${r.rate}>=(${debtHi.get(v.id)})-${EPS},${r.bal},0)`) : NA;
      }
      return NA;
    }

    // ── 단계 수식 ──
    const rejects = ord.filter(id => node(id).type === 'cutoff' && (node(id).config || {}).action === 'reject');
    const rejX = (id) => `IFERROR(${cell(`node:${id}`)}=${strLit(REJECT)},${F})`;
    function wrap(id, core) {
      const act = activeX(id);
      let f = act === T ? core : `IF(${act},${core},"")`;
      const before = rejects.filter(k => ord.indexOf(k) < ord.indexOf(id));   // 계산 순서상 앞의 거절 컷오프
      if (before.length) f = `IF(${before.length === 1 ? rejX(before[0]) : `OR(${before.map(rejX).join(',')})`},"",${f})`;
      return f;
    }
    function coreX(n) {
      const c = n.config || {}, ctx = { node: n };
      switch (n.type) {
        case 'arith': { const x = tryAst(() => E.parseTokens(c.tokens || []), ctx); return x === NA ? NA : `(${x})*1`; }
        case 'formula': return tryAst(() => E.parseFormula(c.text, c.lang), ctx);
        case 'lookup': {
          const tv = c.table && idx.vars.get(c.table.id);
          return tv && tv.type === 'table' ? lookupX(tv, c.row, tv.cols ? c.col : null, ctx) : NA;
        }
        case 'progressive': return progressiveX(c.table && idx.vars.get(c.table.id), c.base, ctx);
        case 'minmax': return (c.items || []).length ? `${c.mode === 'max' ? 'MAX' : 'MIN'}(${c.items.map(r => `(${refX(r, ctx)})*1`).join(',')})` : NA;
        case 'cond': return `IF(${groupX(c.when, ctx)},${refX(c.then, ctx)},${refX(c.else, ctx)})`;
        case 'cutoff': return `IF(${groupX(c.when, ctx)},${c.action === 'reject' ? strLit(REJECT) : '0'},${c.input ? refX(c.input, ctx) : strLit(PASS)})`;
        case 'branch': return (c.cases || []).reduceRight((acc, k) => `IF(${groupX(k.when, ctx)},${strLit(k.label)},${acc})`, strLit(c.elseLabel || '그 외'));
      }
      return NA;
    }
    const tpl = new Map();   // 열 key → 수식 틀
    for (const v of debtVars) for (const [part] of E.DEBT_PARTS) tpl.set(`debt:${v.id}:${part}`, debtX(v, part));
    for (const id of ord) {
      const n = node(id), c = n.config || {};
      if (n.type !== 'pva') { tpl.set(`node:${id}`, wrap(id, coreX(n))); continue; }
      const lines = c.lines || [], hasF = L.has(`pva:${id}:factor`);
      if (hasF) {
        const rt = E.rateTokens(c);
        const rate = tryAst(() => E.parseTokens(rt), { node: n });
        tpl.set(`pva:${id}:rate`, wrap(id, rate === NA ? NA : `(${rate})*1`));
        const r = `((${cell(`pva:${id}:rate`)})/12)`, m = `((${refX(c.months, { node: n })})*1)`;
        tpl.set(`pva:${id}:factor`, wrap(id, `IF(${r}=0,${m},(1-(1+${r})^(-${m}))/${r})`));
      }
      if (!lines.length) { tpl.set(`node:${id}`, wrap(id, NA)); continue; }
      lines.forEach((l, i) => {
        const local = (ref) => {
          if (ref.k === 'pvf') return hasF ? cell(`pva:${id}:factor`) : NA;
          const j = lines.findIndex(x => x.id === ref.id);
          return j >= 0 && j < i ? cell(`pva:${id}:${ref.id}`) : NA;
        };
        const x = tryAst(() => E.parseTokens(l.tokens || []), { node: n, local });
        tpl.set(i === lines.length - 1 ? `node:${id}` : `pva:${id}:${l.id}`, wrap(id, x === NA ? NA : `(${x})*1`));
      });
    }

    // 최소·최대가 고른 항목(엔진의 refName과 같은 이름)
    const refName = (ref) => {
      if (!ref) return '';
      if (ref.k === 'in') return E.IN_NAME;
      if (ref.k === 'part') { const x = idx.nodes.get(ref.id) || idx.vars.get(ref.id) || {}; return `${x.name || '(삭제됨)'}${E.PART_SEP}${(E.partsOf(x).find(p => p[0] === ref.part) || [, ref.part])[1]}`; }
      if (ref.k === 'var') return (idx.vars.get(ref.id) || {}).name || '(삭제됨)';
      if (ref.k === 'node') return (idx.nodes.get(ref.id) || {}).name || '(삭제됨)';
      return E.fmtNum(ref.v);
    };
    for (const id of ord) {
      const n = node(id);
      if (n.type !== 'minmax') continue;
      const m = cell(`node:${id}`);
      const pick = (n.config.items || []).reduceRight((acc, r) => `IF((${refX(r, { node: n })})*1=${m},${strLit(refName(r))},${acc})`, '""');
      tpl.set(`chosen:${id}`, `IF(IFERROR(${m}="",${T}),"",${pick})`);
    }

    // 최종 · 상태 · 사유 · 결정요인
    const Fin = cell(`node:${finalId}`);
    const rej = rejects.length ? (rejects.length === 1 ? rejX(rejects[0]) : `OR(${rejects.map(rejX).join(',')})`) : F;
    const reasonOf = (id) => (node(id).config || {}).reason || node(id).name;
    const rejReason = rejects.reduceRight((acc, id) => `IF(${rejX(id)},${strLit(reasonOf(id))},${acc})`, '""');
    const range = `$${colName(firstStep)}${R}:$${colName(lastStep)}${R}`;
    const noPath = strLit(`최종 단계 [${node(finalId).name}]까지 경로가 이어지지 않음`);
    const errReason = stepNames.length <= NEST_MAX
      ? stepNames.reduceRight((acc, [key, name]) => `IF(ISERROR(${cell(key)}),${strLit(`[${name}] 오류`)},${acc})`, noPath)
      : `IF(ISERROR(SUM(${range})),"단계 오류 — 오류(#) 칸을 확인하세요",${noPath})`;
    const anc = new Set([finalId]);
    for (const stack = [finalId]; stack.length;) for (const d of deps.get(stack.pop())) if (!anc.has(d)) { anc.add(d); stack.push(d); }
    const det = ord.filter(id => anc.has(id)).reduce((acc, id) => {
      const n = node(id);
      if (n.type === 'minmax') return `IF(IFERROR(${cell(`node:${id}`)}<>"",${F}),${cell(`chosen:${id}`)},${acc})`;
      if (n.type === 'cutoff' && n.config.action !== 'reject') return `IF(IFERROR(AND(${cell(`node:${id}`)}<>"",${groupX(n.config.when, { node: n })}),${F}),${strLit(reasonOf(id))},${acc})`;
      return acc;
    }, '""');
    const St = cell('status');
    tpl.set('final', `IF(${rej},0,IFERROR(${Fin},""))`);
    tpl.set('status', `IF(${rej},${strLit(STATUS.reject)},IF(OR(ISERROR(SUM(${range})),IFERROR(${Fin}="",${T})),${strLit(STATUS.error)},${strLit(STATUS.ok)}))`);
    tpl.set('reason', `IF(${rej},${rejReason},IF(${St}=${strLit(STATUS.error)},${errReason},""))`);
    tpl.set('det', `IF(${rej},${rejReason},${det})`);
    if (opts.web) {
      const fin = cell('final'), wf = cell('webFinal');
      tpl.set('match', `IF(AND(${St}=${cell('webStatus')},IF(${St}=${strLit(STATUS.ok)},IF(ISNUMBER(${fin}),ABS(${fin}-N(${wf}))<=MAX(0.000001,ABS(N(${wf}))*${EPS}),${fin}=${wf}),${T})),"일치","다름")`);
    }

    // 설명 줄: 단계는 계산 유형 · 식 설명
    const describe = opts.describe || (() => '');
    cols.forEach((c) => {
      if (c.node && !c.sub) c.desc = `${E.NODE_TYPES[c.node.type] || c.node.type}${describe(c.node) ? ` · ${describe(c.node)}` : ''}`;
      else if (c.node) c.desc = c.sub === 'rate' ? '현가계수 금리' : c.sub === 'factor' ? '[1 − (1 + r)^−n] ÷ r' : '기초한도 줄';
    });

    // ── 고객 줄 ──
    const rowsIn = opts.rows && opts.rows.length ? opts.rows : [{}];
    const simRows = [cols.map(c => c.head), cols.map(c => c.desc || null)];
    rowsIn.forEach((rowIn, i) => {
      const rn = String(i + 1 + HEAD_ROWS), given = rowIn.inputs || {};
      simRows.push(cols.map((c) => {
        if (c.key === 'id') return rowIn.id !== undefined ? rowIn.id : i + 1;
        if (c.input) {
          const ic = c.input, v = idx.vars.get(ic.varId);
          let val;
          if (ic.debt) {
            const arr = Array.isArray(given[ic.varId]) ? given[ic.varId] : null;
            val = arr ? arr[ic.row] : (v.rows[ic.row].balance || 0);   // 잔액을 안 넘기면 테스트 잔액(엔진과 같다)
          } else {
            const has = Object.prototype.hasOwnProperty.call(given, ic.varId);
            val = has ? given[ic.varId] : opts.fillDefaults ? v.value : null;
          }
          if (val === null || val === undefined || val === '') return null;
          if (ic.type === 'bool') return val === true || val === 1 || val === 'Y' ? 'Y' : 'N';
          return typeof val === 'number' ? { v: val, z: c.z } : val;
        }
        if (c.key === 'webFinal') return rowIn.web && typeof rowIn.web.final === 'number' ? { v: rowIn.web.final, z: c.z } : (rowIn.web ? rowIn.web.final : null);
        if (c.key === 'webStatus') return rowIn.web ? STATUS[rowIn.web.status] || rowIn.web.status : null;
        const f = tpl.get(c.key);
        return f === undefined ? null : { f: f.split(R).join(rn), z: c.z };
      }));
    });
    const sim = { name: simName, rows: simRows, widths: cols.map(c => c.width || 16) };

    const guide = { name: sheetName(GUIDE), widths: [18, 110], rows: [
      ['전략 엑셀(수식)'],
      ['가상 데이터 전용입니다. 고객 개인신용정보를 넣지 마세요. 수치는 예시 파라미터이며 실적용 전 실데이터로 교체해야 합니다.'],
      [],
      ['쓰는 법', `"${simName}" 시트에 고객 한 명이 한 줄입니다. 고객 입력값 칸(왼쪽, 설명 줄에 "고객 입력값")만 고치면 그 줄이 다시 계산됩니다. 고객을 늘리려면 마지막 줄을 아래로 복사(채우기)하세요. 빈 입력 칸은 전략의 기본값(부채표 잔액은 0)으로 계산합니다.`],
      ['전략 값', `"${par.name}"·표·부채표 시트의 값을 바꾸면 모든 줄에 반영됩니다(칸에 계산식이 있는 표는 예외 — 그 표 시트 안내 참고).`],
      ['빈칸', '경로를 지나지 않은 단계와 거절 뒤 단계는 빈칸입니다. 컷오프 단계는 거절이면 "거절", 통과하고 넘길 값이 없으면 "통과"로 보입니다.'],
      ['오류', '계산 오류는 엑셀 오류(#N/A 등)로 보이고 뒤 단계로 번집니다. 상태가 "오류"면 사유 칸에 처음 오류가 난 단계가 나옵니다.'],
      ['일치', '대량 시뮬레이션 결과 파일에만 있습니다. 엑셀 계산(상태·최종한도)이 웹 계산과 같으면 "일치"입니다. 전략 값을 엑셀에서 바꾸면 "다름"이 될 수 있습니다.'],
      [],
      ['단계 순서', ord.map(id => node(id).name).join(' → ')],
    ] };

    return { sheets: [sim, par, ...tableSheets, ...debtSheets, guide], inputCols: inputs.length };
  }

  // 모델 → SheetJS 통합 문서. 수식 칸은 값 없이 넣어 엑셀이 열 때 계산한다
  function toWorkbook(model, XLSX) {
    const wb = XLSX.utils.book_new();
    for (const sh of model.sheets) {
      const ws = {};
      let maxC = 0;
      sh.rows.forEach((row, r) => (row || []).forEach((x, c) => {
        if (x === null || x === undefined || x === '') return;
        const addr = XLSX.utils.encode_cell({ r, c });
        if (typeof x === 'object') {
          if (x.f !== undefined) ws[addr] = Object.assign({ t: 'n', f: x.f }, x.z ? { z: x.z } : {});
          else ws[addr] = Object.assign(typeof x.v === 'number' ? { t: 'n', v: x.v } : { t: 's', v: String(x.v) }, x.z ? { z: x.z } : {});
        } else ws[addr] = typeof x === 'number' ? { t: 'n', v: x } : typeof x === 'boolean' ? { t: 'b', v: x } : { t: 's', v: String(x) };
        maxC = Math.max(maxC, c);
      }));
      ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(sh.rows.length - 1, 0), c: maxC } });
      if (sh.widths) ws['!cols'] = sh.widths.map(wch => ({ wch }));
      XLSX.utils.book_append_sheet(wb, ws, sh.name);
    }
    return wb;
  }

  return { build, toWorkbook, ExportError, STATUS, SIM };
});
