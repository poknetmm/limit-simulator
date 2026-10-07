/* ============================================================================
   한도 시뮬레이터 — 계산 엔진
   ----------------------------------------------------------------------------
   화면과 무관한 순수 계산부. 브라우저(window.LimitEngine)와 Node(require) 양쪽에서
   같은 코드를 쓴다 — 화면 검증과 자동 테스트가 같은 엔진을 보게 하기 위해서다.

   전략(strategy) 구조
     variables : 고객 입력값·전략 파라미터·표
     nodes     : 계산 단계(도형). type별 config는 아래 evalNode 참조
     edges     : 단계 순서(화살표). 분기 도형에서 나가는 화살표는 label로 경로를 가린다
     finalNodeId : 최종한도 단계(비우면 흐름의 마지막 단계)

   참조(ref) 형태 — 변수·단계는 이름이 아니라 id로 가리킨다(이름을 바꿔도 안 깨짐)
     {k:'var', id} | {k:'node', id} | {k:'num', v} | {k:'str', v} | {k:'in'}
     | {k:'part', id, part} — 기초한도(PVA)·부채 집계 단계의 중간값(실질월가처분소득·고금리채무 등)
   고급 수식만 [이름]으로 가리키며, 이름 변경 시 renameInFormulas로 함께 고친다.

   자동 합류: 화살표가 여러 개 들어오는 단계는 그중 하나라도 지나오면 계산한다.
   {k:'in'}(수식에서는 [지나온 경로의 값])은 이번 계산에서 지나온 화살표의 앞 단계 값이다.
   ========================================================================== */
(function (root, factory) {
  const E = factory();
  if (typeof module === 'object' && module.exports) module.exports = E;
  else root.LimitEngine = E;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA = 1;

  const NODE_TYPES = {
    pva:         '기초한도(PVA)',
    arith:       '사칙연산',
    lookup:      '표 조회',
    progressive: '구간 누진 합산',
    minmax:      '최소·최대',
    cond:        '조건',
    cutoff:      '컷오프',
    formula:     '고급 수식',
    branch:      '분기',
  };

  const IN_NAME = '지나온 경로의 값';

  // 기초한도(PVA) — 줄 단위 식. 줄마다 이름 + 사칙연산 조각(값·앞 줄·현가계수·연산 기호), 마지막 줄 = 기초한도.
  // 조각의 참조에는 {k:'line', id}(이 단계의 앞 줄)와 {k:'pvf'}(현가계수)가 더 있다.
  //   현가계수 = [1 − (1 + 금리/12)^−기간] ÷ (금리/12) — 금리·기간은 단계 설정(config.rate, config.months)
  //   금리는 조각 식(config.rate = 조각 배열)으로 값·전략 파라미터·표 값을 조합한다. 옛 형식(참조 하나)도 그대로 읽는다
  //   표 값 조각: {k:'tbl', table:{k:'var', id}, row:ref, col:ref|null} — 행·열 기준값으로 표의 숫자를 찾는다(INDEX·MATCH)
  // 처음 줄(기본형): ① 불량률 조정소득 → ② 월가처분소득 → ③ 실질월가처분소득 → ④ 기초 PVA.
  // 기본형 줄 id(adjinc·free·realfree)는 옛 중간값 참조와 같게 둔다
  const PVF_NAME = '현가계수';
  const PVA_SLOTS = [
    ['income', '월소득'], ['bad', '6개월 불량률'], ['annual', '불량률 연환산 배수'], ['pay', '기존 월상환액'],
    ['living', '월 생계비'], ['dsr', '한계 DSR'], ['rate', '금리(연)'], ['months', '기간(개월)'],
  ];
  // slot(k): 기본형 요소 k의 조각. 요소를 비워 두면(null) 빈 참조 조각이 들어간다
  function pvaDefaultLines(slot) {
    const R = (k) => slot(k), L = (id) => ({ t: 'ref', ref: { k: 'line', id } }), op = (v) => ({ t: 'op', v });
    return [
      { id: 'adjinc', name: '불량률 조정소득', tokens: [R('income'), op('*'), { t: 'lp' }, { t: 'num', v: 1 }, op('-'), R('bad'), op('*'), R('annual'), { t: 'rp' }] },
      { id: 'free', name: '월가처분소득', tokens: [L('adjinc'), op('-'), R('pay'), op('-'), R('living')] },
      { id: 'realfree', name: '실질월가처분소득', tokens: [L('free'), op('*'), R('dsr')] },
      { id: 'pva', name: '기초 PVA', tokens: [L('realfree'), op('*'), { t: 'ref', ref: { k: 'pvf' } }] },
    ];
  }
  const refToken = (ref) => (ref && ref.k === 'num' ? { t: 'num', v: ref.v } : { t: 'ref', ref: ref || null });
  const rateTokens = (c) => (Array.isArray(c.rate) ? c.rate : c.rate ? [refToken(c.rate)] : []);

  // 부채표 합계 — 부채표(업권 × 대출구분, 기간·금리·잔액)의 행별 원리금균등 월상환액과 합계.
  // 다른 단계에서 "보유부채 › 고금리채무"처럼 바로 고른다. 고금리 기준은 부채표 설정(v.hiRate)
  // 대출구분이 "부동산"인 행 = 부동산 잔액, 그 밖의 행 = 신용채무. 금리 ≥ 고금리 기준인 행 = 고금리채무
  const DEBT_PARTS = [['pay', '월 원리금 합계', 'money'], ['total', '총채무', 'money'], ['mort', '부동산 잔액', 'money'], ['credit', '신용채무', 'money'], ['high', '고금리채무', 'money']];
  const DEBT_MORT = '부동산';

  // 중간값(다른 단계에서 "이름 › 항목"으로 참조): 부채표 변수의 합계, 기초한도 단계의 앞 줄들과 현가계수
  const PART_SEP = ' › ';
  function partsOf(x) {
    if (!x) return [];
    if (x.type === 'debt' && x.rows) return DEBT_PARTS;
    if (x.type === 'pva') return [...((x.config && x.config.lines) || []).slice(0, -1).map(l => [l.id, l.name, 'money']), ['factor', PVF_NAME, 'number']];
    return [];
  }
  const partLabel = (x, part) => (partsOf(x).find(p => p[0] === part) || [, part])[1];

  // 원리금균등 월상환액: 잔액 × (r/12)(1+r/12)^n ÷ ((1+r/12)^n − 1). 금리 0이면 잔액 ÷ 기간
  function monthlyPayment(rate, months, balance) {
    if (!balance) return 0;
    if (!(months > 0)) throw new CalcError('대출기간은 0보다 커야 합니다');
    const r = rate / 12;
    if (r === 0) return balance / months;
    const f = Math.pow(1 + r, months);
    return balance * r * f / (f - 1);
  }

  // 부채표 합계: hi = 고금리 기준(없으면 null — 고금리채무만 계산하지 않음), balances = 행 순서 잔액(없으면 표의 테스트 잔액)
  function debtAggregate(tv, hi, balances) {
    const parts = { pay: 0, total: 0, mort: 0, credit: 0, high: hi === null ? undefined : 0 };
    const rows = tv.rows.map((row, i) => {
      const label = `${row.sector} · ${row.kind}`;
      const b = balances && balances[i] !== undefined && balances[i] !== null && balances[i] !== '' ? balances[i] : (row.balance || 0);
      const balance = num(b, `${label} 잔액`);
      const rate = num(row.rate, `${label} 금리`), months = num(row.months, `${label} 기간`);
      let pay;
      try { pay = monthlyPayment(rate, months, balance); }
      catch (e) { if (e instanceof CalcError) throw new CalcError(`${label}: ${e.message}`); throw e; }
      const high = hi !== null && rate >= hi - EPS;
      parts.pay += pay; parts.total += balance;
      if (row.kind === DEBT_MORT) parts.mort += balance; else parts.credit += balance;
      if (high) parts.high += balance;
      return { sector: row.sector, kind: row.kind, rate, months, balance, pay, high };
    });
    return { rows, parts, hiRate: hi };
  }

  const VAR_TYPES = {
    money:   '금액',
    number:  '숫자',
    percent: '비율(%)',
    choice:  '선택형',
    bool:    '예/아니오',
    table:   '표',
    debt:    '부채표',
  };

  const CMP_OPS = ['>=', '>', '<=', '<', '=', '<>'];

  class CalcError extends Error {}

  // ── 값 다루기 ────────────────────────────────────────────────────────────
  function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
    return null;
  }

  function num(v, what) {
    const n = toNum(v);
    if (n === null) throw new CalcError(`${what || '값'}이(가) 숫자가 아닙니다: ${fmtRaw(v)}`);
    return n;
  }

  function fmtRaw(v) {
    if (v === null || v === undefined) return '(비어 있음)';
    return String(v);
  }

  // 부동소수 오차로 1,000,000이 999,999.9999로 떨어지는 것을 막는 여유
  const EPS = 1e-9;
  function roundTo(x, unit, mode) {
    if (!unit) return x;
    const q = x / unit;
    const r = mode === 'ceil' ? Math.ceil(q - EPS) : mode === 'round' ? Math.round(q) : Math.floor(q + EPS);
    return r * unit;
  }

  function compare(a, op, b) {
    const na = toNum(a), nb = toNum(b);
    if (na !== null && nb !== null) { a = na; b = nb; }
    else { a = String(a ?? ''); b = String(b ?? ''); }
    switch (op) {
      case '>=': return a >= b;
      case '>':  return a > b;
      case '<=': return a <= b;
      case '<':  return a < b;
      case '=':  return a === b;
      case '<>': return a !== b;
    }
    throw new CalcError(`알 수 없는 비교 기호: ${op}`);
  }

  // ── 표 ───────────────────────────────────────────────────────────────────
  // 표 변수: {type:'table', rows:{mode:'list'|'band', keys:[]}, cols:null|{mode,keys}, cells:[[...]]}
  //   list = 값이 같은 항목을 찾는다(INDEX·MATCH)
  //   band = 키를 구간 시작값으로 보고 "시작값 이하 중 가장 큰 구간"을 찾는다(VLOOKUP 근사)
  function axisIndex(axis, key) {
    if (axis.mode === 'band') {
      const x = toNum(key);
      if (x === null) return -1;
      let idx = -1;
      for (let i = 0; i < axis.keys.length; i++) if (x >= axis.keys[i] - EPS) idx = i;
      return idx;
    }
    const k = String(key);
    return axis.keys.findIndex(v => String(v) === k);
  }

  function axisKeyLabel(axis, i) {
    if (axis.mode !== 'band') return String(axis.keys[i]);
    const from = axis.keys[i], to = axis.keys[i + 1];
    return to === undefined ? `${fmtNum(from)} 이상` : `${fmtNum(from)} 이상 ~ ${fmtNum(to)} 미만`;
  }

  // 칸 값이 "="로 시작하면 계산식이다(엑셀과 같다) — 예: =[연소득] * 0.1. 고른 칸만 그때 계산한다
  const isCellFormula = (v) => typeof v === 'string' && v.trim().startsWith('=');
  const cellAsts = new Map();
  function cellAst(text) {
    if (!cellAsts.has(text)) {
      try { cellAsts.set(text, parseTokens(tokenize(text.trim().slice(1)))); }
      catch (e) { if (!(e instanceof CalcError)) throw e; cellAsts.set(text, e); }
    }
    const a = cellAsts.get(text);
    if (a instanceof Error) throw a;
    return a;
  }
  function cellValue(tv, r, c, resolve) {
    const v = (tv.cells[r] || [])[c];
    if (!isCellFormula(v)) return v;
    const where = `표 [${tv.name}] ${axisKeyLabel(tv.rows, r)}${tv.cols ? ` × ${axisKeyLabel(tv.cols, c)}` : ''} 칸 수식`;
    if (!resolve) throw new CalcError(`${where}은(는) 계산 단계 안에서만 계산합니다`);
    try { return evalAst(cellAst(v), resolve); }
    catch (e) { if (!(e instanceof CalcError)) throw e; throw new CalcError(`${where}: ${e.message}`); }
  }
  // 표의 계산식 칸이 [ ]로 가리키는 이름들(순서 계산·참조 검사용)
  function cellFormulaNames(tv) {
    const out = [];
    for (const row of tv.cells || []) for (const v of row || []) {
      if (!isCellFormula(v)) continue;
      try { out.push(...tokenize(v.trim().slice(1)).filter(t => t.t === 'name').map(t => t.v)); } catch (e) { /* 문법 오류는 검증 단계에서 알린다 */ }
    }
    return out;
  }

  function lookupTable(tv, rowKey, colKey, resolve) {
    const r = axisIndex(tv.rows, rowKey);
    if (r < 0) throw new CalcError(`표 [${tv.name}]에 행 기준값 ${fmtRaw(rowKey)}에 해당하는 칸이 없습니다`);
    let c = 0;
    if (tv.cols) {
      c = axisIndex(tv.cols, colKey);
      if (c < 0) throw new CalcError(`표 [${tv.name}]에 열 기준값 ${fmtRaw(colKey)}에 해당하는 칸이 없습니다`);
    }
    const v = cellValue(tv, r, c, resolve);
    if (v === null || v === undefined || v === '') throw new CalcError(`표 [${tv.name}]의 칸이 비어 있습니다 (${axisKeyLabel(tv.rows, r)})`);
    return v;
  }

  // 구간 누진 합산: 구간마다 (구간 안에 든 금액 × 구간 값)을 더한다 — 누진세 계산과 같다
  function progressiveSum(tv, x, resolve) {
    if (tv.rows.mode !== 'band' || tv.cols) throw new CalcError(`표 [${tv.name}]은(는) 1차원 구간표여야 누진 합산할 수 있습니다`);
    const keys = tv.rows.keys;
    let sum = 0;
    for (let i = 0; i < keys.length; i++) {
      const from = keys[i];
      const to = i + 1 < keys.length ? keys[i + 1] : Infinity;
      const part = Math.max(Math.min(x, to) - from, 0);
      if (part > 0) sum += part * num(cellValue(tv, i, 0, resolve), `표 [${tv.name}] ${axisKeyLabel(tv.rows, i)}`);
    }
    return sum;
  }

  // ── 수식 (고급 수식 · 사칙연산 공용) ─────────────────────────────────────
  // 토큰: {t:'num',v} {t:'str',v} {t:'ref',ref} {t:'name',v} {t:'fn',v} {t:'op',v} {t:'lp'} {t:'rp'} {t:'comma'}
  function tokenize(text) {
    const out = [];
    let i = 0;
    const s = String(text || '');
    while (i < s.length) {
      const ch = s[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (/[0-9.]/.test(ch)) {
        // 쉼표는 함수 인수 구분자라 천 단위 구분으로 쓰지 않는다(엑셀 수식과 같다). 대신 _ 허용: 1_000_000
        let j = i; while (j < s.length && /[0-9._]/.test(s[j])) j++;
        const raw = s.slice(i, j).replace(/_/g, '');
        if (isNaN(Number(raw))) throw new CalcError(`숫자를 읽을 수 없습니다: ${s.slice(i, j)}`);
        let v = Number(raw);
        if (s[j] === '%') { v = v / 100; j++; }
        out.push({ t: 'num', v }); i = j; continue;
      }
      if (ch === '[') {
        const j = s.indexOf(']', i);
        if (j < 0) throw new CalcError('[ 에 짝이 되는 ] 가 없습니다');
        out.push({ t: 'name', v: s.slice(i + 1, j).trim() }); i = j + 1; continue;
      }
      if (ch === '"') {
        const j = s.indexOf('"', i + 1);
        if (j < 0) throw new CalcError('따옴표가 닫히지 않았습니다');
        out.push({ t: 'str', v: s.slice(i + 1, j) }); i = j + 1; continue;
      }
      if (/[A-Za-z]/.test(ch)) {
        let j = i; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
        const w = s.slice(i, j).toUpperCase();
        if (w === 'TRUE' || w === 'FALSE') out.push({ t: 'num', v: w === 'TRUE' ? 1 : 0 });
        else out.push({ t: 'fn', v: w });
        i = j; continue;
      }
      const two = s.slice(i, i + 2);
      if (['>=', '<=', '<>'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
      if ('+-*/^=<>'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
      if (ch === '(') { out.push({ t: 'lp' }); i++; continue; }
      if (ch === ')') { out.push({ t: 'rp' }); i++; continue; }
      if (ch === ',') { out.push({ t: 'comma' }); i++; continue; }
      throw new CalcError(`수식에 쓸 수 없는 글자입니다: ${ch}`);
    }
    return out;
  }

  // 재귀 하강 파서 → AST
  function parseTokens(tokens) {
    let p = 0;
    const peek = () => tokens[p];
    const isOp = (...ops) => peek() && peek().t === 'op' && ops.includes(peek().v);
    const expect = (t) => {
      if (!peek() || peek().t !== t) throw new CalcError(t === 'rp' ? '괄호 ) 가 빠졌습니다' : '수식 형태가 올바르지 않습니다');
      return tokens[p++];
    };

    function parseCmp() {
      let a = parseAdd();
      if (isOp('>=', '>', '<=', '<', '=', '<>')) { const op = tokens[p++].v; a = { k: 'bin', op, a, b: parseAdd() }; }
      return a;
    }
    function parseAdd() {
      let a = parseMul();
      while (isOp('+', '-')) { const op = tokens[p++].v; a = { k: 'bin', op, a, b: parseMul() }; }
      return a;
    }
    function parseMul() {
      let a = parsePow();
      while (isOp('*', '/')) { const op = tokens[p++].v; a = { k: 'bin', op, a, b: parsePow() }; }
      return a;
    }
    function parsePow() {
      const a = parseUnary();
      if (isOp('^')) { p++; return { k: 'bin', op: '^', a, b: parsePow() }; }
      return a;
    }
    function parseUnary() {
      if (isOp('-')) { p++; return { k: 'neg', a: parseUnary() }; }
      if (isOp('+')) { p++; return parseUnary(); }
      return parsePrimary();
    }
    function parsePrimary() {
      const t = peek();
      if (!t) throw new CalcError('수식이 중간에 끝났습니다');
      p++;
      if (t.t === 'num') return { k: 'num', v: t.v };
      if (t.t === 'str') return { k: 'str', v: t.v };
      if (t.t === 'ref') return { k: 'ref', ref: t.ref };
      if (t.t === 'name') return { k: 'name', v: t.v };
      if (t.t === 'lp') { const e = parseCmp(); expect('rp'); return e; }
      if (t.t === 'fn') {
        expect('lp');
        const args = [];
        if (peek() && peek().t !== 'rp') {
          args.push(parseCmp());
          while (peek() && peek().t === 'comma') { p++; args.push(parseCmp()); }
        }
        expect('rp');
        return { k: 'call', fn: t.v, args };
      }
      throw new CalcError('수식 형태가 올바르지 않습니다');
    }

    if (!tokens.length) throw new CalcError('수식이 비어 있습니다');
    const ast = parseCmp();
    if (p < tokens.length) throw new CalcError('수식 끝에 해석할 수 없는 부분이 있습니다');
    return ast;
  }

  const FUNCS = {
    MIN: (a) => { if (!a.length) throw new CalcError('MIN에 값이 없습니다'); return Math.min(...a.map(x => num(x))); },
    MAX: (a) => { if (!a.length) throw new CalcError('MAX에 값이 없습니다'); return Math.max(...a.map(x => num(x))); },
    ABS: (a) => Math.abs(num(a[0])),
    ROUND: (a) => roundTo(num(a[0]), Math.pow(10, -(num(a[1] ?? 0))), 'round'),
    ROUNDDOWN: (a) => { const x = num(a[0]); return Math.sign(x) * roundTo(Math.abs(x), Math.pow(10, -(num(a[1] ?? 0))), 'floor'); },
    ROUNDUP: (a) => { const x = num(a[0]); return Math.sign(x) * roundTo(Math.abs(x), Math.pow(10, -(num(a[1] ?? 0))), 'ceil'); },
    FLOOR: (a) => roundTo(num(a[0]), num(a[1] ?? 1), 'floor'),
    CEILING: (a) => roundTo(num(a[0]), num(a[1] ?? 1), 'ceil'),
    AND: (a) => a.every(x => !!num(x)) ? 1 : 0,
    OR: (a) => a.some(x => !!num(x)) ? 1 : 0,
    NOT: (a) => num(a[0]) ? 0 : 1,
  };

  function evalAst(ast, resolve) {
    switch (ast.k) {
      case 'num': case 'str': return ast.v;
      case 'ref': return resolve(ast.ref);
      case 'name': return resolve({ k: 'name', v: ast.v });
      case 'neg': return -num(evalAst(ast.a, resolve));
      case 'call': {
        if (ast.fn === 'IF') {   // IF는 고른 쪽만 계산한다(안 쓰는 쪽의 0 나누기 방지)
          if (ast.args.length !== 3) throw new CalcError('IF는 (조건, 참일 때, 거짓일 때) 세 값이 필요합니다');
          return num(evalAst(ast.args[0], resolve)) ? evalAst(ast.args[1], resolve) : evalAst(ast.args[2], resolve);
        }
        const f = FUNCS[ast.fn];
        if (!f) throw new CalcError(`지원하지 않는 함수입니다: ${ast.fn}`);
        return f(ast.args.map(x => evalAst(x, resolve)));
      }
      case 'bin': {
        const a = evalAst(ast.a, resolve), b = evalAst(ast.b, resolve);
        if (CMP_OPS.includes(ast.op)) return compare(a, ast.op, b) ? 1 : 0;
        const x = num(a), y = num(b);
        switch (ast.op) {
          case '+': return x + y;
          case '-': return x - y;
          case '*': return x * y;
          case '/': if (y === 0) throw new CalcError('0으로 나눌 수 없습니다'); return x / y;
          case '^': return Math.pow(x, y);
        }
      }
    }
    throw new CalcError('수식을 계산할 수 없습니다');
  }

  // ── 파이썬·R 문법 (고급 수식) ────────────────────────────────────────────
  // 실제 파이썬·R을 실행하지 않는다. 식의 문법만 받아 위 엑셀식과 같은 AST로 바꿔 같은 엔진이 계산한다.
  // 변수·단계 이름은 세 문법 모두 [이름]으로 쓴다(한글·띄어쓰기 때문). 반복문·대입·import는 지원하지 않는다.
  const LANGS = { excel: '엑셀', python: '파이썬', r: 'R' };
  const DIALECT = {
    python: {
      keywords: { and: 'and', or: 'or', not: 'not', if: 'if', else: 'else', True: 'true', False: 'false' },
      funcs: { min: 'MIN', max: 'MAX', abs: 'ABS', round: 'ROUND', floor: 'FLOOR', ceil: 'CEILING' },
    },
    r: {
      keywords: { if: 'if', else: 'else', TRUE: 'true', FALSE: 'false', T: 'true', F: 'false' },
      funcs: { min: 'MIN', max: 'MAX', abs: 'ABS', round: 'ROUND', floor: 'FLOOR', ceiling: 'CEILING', ifelse: 'IF' },
    },
  };

  function tokenizeDialect(text, lang) {
    const d = DIALECT[lang], out = [], s = String(text || '');
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }   // 주석
      if (/[0-9.]/.test(ch)) {
        let j = i; while (j < s.length && /[0-9._]/.test(s[j])) j++;
        const raw = s.slice(i, j).replace(/_/g, '');
        if (raw === '.' || isNaN(Number(raw))) throw new CalcError(`숫자를 읽을 수 없습니다: ${s.slice(i, j)}`);
        out.push({ t: 'num', v: Number(raw) }); i = j; continue;
      }
      if (ch === '[') {
        const j = s.indexOf(']', i);
        if (j < 0) throw new CalcError('[ 에 짝이 되는 ] 가 없습니다');
        out.push({ t: 'name', v: s.slice(i + 1, j).trim() }); i = j + 1; continue;
      }
      if (ch === '"' || ch === '\'') {
        const j = s.indexOf(ch, i + 1);
        if (j < 0) throw new CalcError('따옴표가 닫히지 않았습니다');
        out.push({ t: 'str', v: s.slice(i + 1, j) }); i = j + 1; continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i; while (j < s.length && /[A-Za-z0-9_.]/.test(s[j])) j++;
        const w = s.slice(i, j);
        if (Object.prototype.hasOwnProperty.call(d.keywords, w)) out.push({ t: 'kw', v: d.keywords[w] });
        else out.push({ t: 'id', v: w });
        i = j; continue;
      }
      const two = s.slice(i, i + 2);
      if (lang === 'python' && ('&|'.includes(ch) || (ch === '!' && two !== '!='))) throw new CalcError('파이썬에서는 and · or · not 을 씁니다');
      if (['**', '==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
      if (ch === '=') throw new CalcError('같은지 비교는 == 로 씁니다(= 하나는 대입이라 쓸 수 없습니다)');
      if (lang === 'python' && ch === '^') throw new CalcError('파이썬에서 거듭제곱은 ** 로 씁니다');
      if ('+-*/^<>!&|'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
      if ('({'.includes(ch)) { out.push({ t: 'lp', v: ch }); i++; continue; }
      if (')}'.includes(ch)) { out.push({ t: 'rp', v: ch }); i++; continue; }
      if (ch === ',') { out.push({ t: 'comma' }); i++; continue; }
      if (ch === ':') throw new CalcError('콜론(:)은 if / elif / else 줄 끝에만 씁니다');
      throw new CalcError(`수식에 쓸 수 없는 글자입니다: ${ch}`);
    }
    return out;
  }

  // 식 하나를 읽는다. 연산 순서: 조건식 < or < and < not < 비교 < + − < × ÷ < 부호 < 거듭제곱
  function parseDialect(tokens, lang) {
    const d = DIALECT[lang];
    let p = 0;
    const peek = () => tokens[p];
    const isKw = (v) => peek() && peek().t === 'kw' && peek().v === v;
    const isOp = (...vs) => peek() && peek().t === 'op' && vs.includes(peek().v);
    const expect = (t, v, msg) => {
      const x = peek();
      if (!x || x.t !== t || (v && x.v !== v)) throw new CalcError(msg);
      p++;
      return x;
    };
    const call = (fn, args) => ({ k: 'call', fn, args });
    const CMP = { '==': '=', '!=': '<>', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };

    function expr() {
      if (lang === 'r' && isKw('if')) {   // if (조건) A else B
        p++;
        expect('lp', '(', 'R의 if 뒤에는 ( 조건 ) 이 와야 합니다');
        const c = expr();
        expect('rp', ')', '괄호 ) 가 빠졌습니다');
        const a = expr();
        if (!isKw('else')) throw new CalcError('R의 if 식에는 else 가 필요합니다(모든 경우에 값이 있어야 합니다)');
        p++;
        return call('IF', [c, a, expr()]);
      }
      const a = orExpr();
      if (lang === 'python' && isKw('if')) {   // A if 조건 else B
        p++;
        const c = orExpr();
        if (!isKw('else')) throw new CalcError('파이썬 조건식은 "A if 조건 else B" 형태여야 합니다');
        p++;
        return call('IF', [c, a, expr()]);
      }
      return a;
    }
    const orTok = () => (lang === 'python' ? isKw('or') : isOp('|', '||'));
    const andTok = () => (lang === 'python' ? isKw('and') : isOp('&', '&&'));
    const notTok = () => (lang === 'python' ? isKw('not') : isOp('!'));
    function orExpr() { const xs = [andExpr()]; while (orTok()) { p++; xs.push(andExpr()); } return xs.length > 1 ? call('OR', xs) : xs[0]; }
    function andExpr() { const xs = [notExpr()]; while (andTok()) { p++; xs.push(notExpr()); } return xs.length > 1 ? call('AND', xs) : xs[0]; }
    function notExpr() { if (notTok()) { p++; return call('NOT', [notExpr()]); } return cmpExpr(); }
    function cmpExpr() {   // a < b < c 처럼 이어 쓰면 (a < b) 그리고 (b < c)
      let a = addExpr();
      const parts = [];
      while (isOp(...Object.keys(CMP))) { const op = CMP[tokens[p++].v]; const b = addExpr(); parts.push({ k: 'bin', op, a, b }); a = b; }
      return !parts.length ? a : parts.length === 1 ? parts[0] : call('AND', parts);
    }
    function addExpr() { let a = mulExpr(); while (isOp('+', '-')) { const op = tokens[p++].v; a = { k: 'bin', op, a, b: mulExpr() }; } return a; }
    function mulExpr() { let a = unary(); while (isOp('*', '/')) { const op = tokens[p++].v; a = { k: 'bin', op, a, b: unary() }; } return a; }
    function unary() {
      if (isOp('-')) { p++; return { k: 'neg', a: unary() }; }
      if (isOp('+')) { p++; return unary(); }
      return power();
    }
    function power() {
      const a = primary();
      if (isOp('**', '^')) { p++; return { k: 'bin', op: '^', a, b: unary() }; }
      return a;
    }
    function primary() {
      const t = peek();
      if (!t) throw new CalcError('수식이 중간에 끝났습니다');
      p++;
      if (t.t === 'num') return { k: 'num', v: t.v };
      if (t.t === 'str') return { k: 'str', v: t.v };
      if (t.t === 'name') return { k: 'name', v: t.v };
      if (t.t === 'kw' && (t.v === 'true' || t.v === 'false')) return { k: 'num', v: t.v === 'true' ? 1 : 0 };
      if (t.t === 'lp') {
        const e = expr();
        expect('rp', t.v === '(' ? ')' : '}', t.v === '(' ? '괄호 ) 가 빠졌습니다' : '중괄호 } 가 빠졌습니다');
        return e;
      }
      if (t.t === 'id') {
        if (!peek() || peek().t !== 'lp' || peek().v !== '(') throw new CalcError(`${t.v} — 변수·단계 이름은 [ ]로 감싸 씁니다`);
        const fn = d.funcs[t.v];
        if (!fn) throw new CalcError(`지원하지 않는 함수입니다: ${t.v}  (쓸 수 있는 함수: ${Object.keys(d.funcs).join(', ')})`);
        p++;
        const args = [];
        if (peek() && peek().t !== 'rp') {
          args.push(expr());
          while (peek() && peek().t === 'comma') { p++; args.push(expr()); }
        }
        expect('rp', ')', '괄호 ) 가 빠졌습니다');
        return call(fn, args);
      }
      if (t.t === 'kw') throw new CalcError(`"${t.v}"를 이 자리에 쓸 수 없습니다`);
      throw new CalcError('수식 형태가 올바르지 않습니다');
    }

    if (!tokens.length) throw new CalcError('수식이 비어 있습니다');
    const ast = expr();
    if (p < tokens.length) throw new CalcError('수식 끝에 해석할 수 없는 부분이 있습니다');
    return ast;
  }

  // 파이썬 여러 줄 if / elif / else: — 각 경우의 값은 콜론 뒤나 다음 줄에 식 하나로 쓴다(return 은 붙여도 된다)
  function parsePythonBlock(text) {
    const lines = String(text).split('\n').map((l, i) => ({ no: i + 1, s: l.replace(/#.*$/, '').trim() })).filter(l => l.s);
    const clauses = [];
    for (const l of lines) {
      let m;
      if ((m = /^(if|elif)\s+(.*):\s*(.*)$/.exec(l.s))) clauses.push({ kind: m[1], cond: m[2], body: m[3], no: l.no });
      else if ((m = /^else\s*:\s*(.*)$/.exec(l.s))) clauses.push({ kind: 'else', body: m[1], no: l.no });
      else if (!clauses.length) throw new CalcError(`${l.no}번째 줄: 여러 줄로 쓸 때는 if 로 시작해야 합니다`);
      else clauses[clauses.length - 1].body += ` ${l.s}`;
    }
    clauses.forEach((c, i) => {
      if ((i === 0) !== (c.kind === 'if')) throw new CalcError(`${c.no}번째 줄: if 는 맨 처음 한 번만, 그 뒤는 elif / else 로 씁니다`);
      if (c.kind === 'else' && i !== clauses.length - 1) throw new CalcError(`${c.no}번째 줄: else 는 맨 마지막에 한 번만 씁니다`);
    });
    const last = clauses[clauses.length - 1];
    if (last.kind !== 'else') throw new CalcError('else: 가 필요합니다(모든 경우에 값이 있어야 합니다)');
    const part = (src, no, what) => {
      const body = src.trim().replace(/^return\s+/, '');
      if (!body) throw new CalcError(`${no}번째 줄: ${what}이(가) 비어 있습니다`);
      try { return parseDialect(tokenizeDialect(body, 'python'), 'python'); }
      catch (e) { if (e instanceof CalcError) throw new CalcError(`${no}번째 줄: ${e.message}`); throw e; }
    };
    let ast = part(last.body, last.no, '값');
    for (let i = clauses.length - 2; i >= 0; i--) {
      const c = clauses[i];
      ast = { k: 'call', fn: 'IF', args: [part(c.cond, c.no, '조건'), part(c.body, c.no, '값'), ast] };
    }
    return ast;
  }

  // 고급 수식 → AST (lang: excel | python | r)
  // 파이썬은 첫 줄(주석 제외)이 "if …:"로 끝나면 여러 줄 if / elif / else 로 읽는다
  function parseFormula(text, lang) {
    if (!lang || lang === 'excel') return parseTokens(tokenize(text));
    if (!DIALECT[lang]) throw new CalcError(`알 수 없는 문법입니다: ${lang}`);
    if (lang === 'python') {
      const first = String(text || '').split('\n').map(l => l.replace(/#.*$/, '').trim()).find(l => l) || '';
      if (/^if\b.*:\s*.*$/.test(first) && /:/.test(first)) return parsePythonBlock(text);
    }
    return parseDialect(tokenizeDialect(text, lang), lang);
  }

  // 수식이 [ ]로 가리키는 이름들(참조 검사·순서 계산용). 파이썬·R은 글자("…")·주석 안은 뺀다
  function formulaNames(text, lang) {
    if (!lang || lang === 'excel') return tokenize(text).filter(t => t.t === 'name').map(t => t.v);
    const clean = String(text || '').replace(/"[^"]*"|'[^']*'/g, '').replace(/#.*$/gm, '');
    return [...clean.matchAll(/\[([^\]]*)\]/g)].map(m => m[1].trim());
  }

  // ── 조건 묶음 ─────────────────────────────────────────────────────────────
  // {logic:'and'|'or', items:[ {left:ref, op, right:ref} | {logic, items:[...]} ]}
  function evalGroup(g, resolve) {
    if (!g || !g.items || !g.items.length) throw new CalcError('조건이 비어 있습니다');
    const test = (it) => it.items ? evalGroup(it, resolve) : compare(resolve(it.left), it.op, resolve(it.right));
    return g.logic === 'or' ? g.items.some(test) : g.items.every(test);
  }

  // ── 전략 구조 ─────────────────────────────────────────────────────────────
  function index(strategy) {
    const vars = new Map(strategy.variables.map(v => [v.id, v]));
    const nodes = new Map(strategy.nodes.map(n => [n.id, n]));
    const byName = new Map();
    for (const x of [...strategy.variables, ...strategy.nodes]) {
      byName.set(x.name, { k: strategy.nodes.includes(x) ? 'node' : 'var', id: x.id });
      for (const [part, label] of partsOf(x)) byName.set(`${x.name}${PART_SEP}${label}`, { k: 'part', id: x.id, part });
    }
    return { vars, nodes, byName };
  }

  // config 안의 모든 ref를 모은다(순서 계산·참조 검사·삭제 영향 확인용)
  function collectRefs(node, idx) {
    const out = [];
    const partOwner = (r) => ({ k: idx && idx.vars.has(r.id) ? 'var' : 'node', id: r.id });
    const walk = (x) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if ((x.k === 'var' || x.k === 'node') && x.id) { out.push(x); return; }
      if (x.k === 'part' && x.id) { out.push(partOwner(x)); return; }   // 중간값도 그 단계(부채표 변수)에 기대는 것
      for (const key of Object.keys(x)) walk(x[key]);
    };
    walk(node.config);
    if (node.type === 'formula' && idx) {
      try {
        for (const v of formulaNames(node.config.text, node.config.lang)) {
          if (idx.byName.has(v)) { const r = idx.byName.get(v); out.push(r.k === 'part' ? partOwner(r) : r); }
        }
      } catch (e) { /* 문법 오류는 검증 단계에서 알린다 */ }
    }
    // 조회하는 표의 계산식 칸이 가리키는 변수·단계에도 기댄다(그 단계가 먼저 계산돼야 한다)
    if (idx) {
      for (const r of [...out]) {
        const tv = r.k === 'var' && idx.vars.get(r.id);
        if (!tv || tv.type !== 'table') continue;
        for (const v of cellFormulaNames(tv)) {
          if (idx.byName.has(v)) { const x = idx.byName.get(v); out.push(x.k === 'part' ? partOwner(x) : x); }
        }
      }
    }
    return out;
  }

  // 간선(화살표) + 단계 참조를 합쳐 위상 정렬. 순환이 있으면 순환에 걸린 단계 목록을 돌려준다
  function order(strategy, idx) {
    idx = idx || index(strategy);
    const deps = new Map(strategy.nodes.map(n => [n.id, new Set()]));
    for (const e of strategy.edges) if (deps.has(e.to) && idx.nodes.has(e.from)) deps.get(e.to).add(e.from);
    for (const n of strategy.nodes) {
      for (const r of collectRefs(n, idx)) if (r.k === 'node' && idx.nodes.has(r.id) && r.id !== n.id) deps.get(n.id).add(r.id);
    }
    const indeg = new Map(), out = new Map();
    for (const n of strategy.nodes) { indeg.set(n.id, deps.get(n.id).size); out.set(n.id, []); }
    for (const [to, ds] of deps) for (const d of ds) out.get(d).push(to);
    // 같은 순위는 원래 배열 순서를 지킨다(화면 표시 순서가 들쭉날쭉하지 않게)
    const pos = new Map(strategy.nodes.map((n, i) => [n.id, i]));
    const ready = strategy.nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
    const result = [];
    while (ready.length) {
      ready.sort((a, b) => pos.get(a) - pos.get(b));
      const id = ready.shift();
      result.push(id);
      for (const nx of out.get(id)) { indeg.set(nx, indeg.get(nx) - 1); if (indeg.get(nx) === 0) ready.push(nx); }
    }
    const cycle = strategy.nodes.filter(n => indeg.get(n.id) > 0).map(n => n.id);
    return { order: result, cycle, deps };
  }

  function finalNodeId(strategy) {
    if (strategy.finalNodeId && strategy.nodes.some(n => n.id === strategy.finalNodeId)) return strategy.finalNodeId;
    const hasOut = new Set(strategy.edges.map(e => e.from));
    const ends = strategy.nodes.filter(n => !hasOut.has(n.id));
    return ends.length ? ends[ends.length - 1].id : (strategy.nodes.length ? strategy.nodes[strategy.nodes.length - 1].id : null);
  }

  // ── 계산 ─────────────────────────────────────────────────────────────────
  // 순서·수식 해석은 전략이 바뀔 때 한 번만 한다. 대량 시뮬레이션은 prepare 결과를 행마다 재사용한다
  function prepare(strategy) {
    const idx = index(strategy);
    const { order: ord, cycle, deps } = order(strategy, idx);
    const asts = new Map();
    for (const n of strategy.nodes) {
      if (n.type === 'pva') {
        for (const l of (n.config && n.config.lines) || []) {
          try { asts.set(`${n.id}#${l.id}`, parseTokens(l.tokens || [])); }
          catch (e) { if (!(e instanceof CalcError)) throw e; asts.set(`${n.id}#${l.id}`, new CalcError(`[${l.name}] 줄: ${e.message}`)); }
        }
        const rt = rateTokens(n.config || {});
        if (rt.length) {
          try { asts.set(`${n.id}#rate`, parseTokens(rt)); }
          catch (e) { if (!(e instanceof CalcError)) throw e; asts.set(`${n.id}#rate`, new CalcError(`${PVF_NAME} 금리: ${e.message}`)); }
        }
        continue;
      }
      if (n.type !== 'arith' && n.type !== 'formula') continue;
      try {
        asts.set(n.id, n.type === 'arith' ? parseTokens(n.config.tokens || []) : parseFormula(n.config.text, n.config.lang));
      } catch (e) {
        if (!(e instanceof CalcError)) throw e;
        asts.set(n.id, e);
      }
    }
    const incoming = new Map(strategy.nodes.map(n => [n.id, []]));
    for (const e of strategy.edges) if (incoming.has(e.to)) incoming.get(e.to).push(e);
    return { strategy, idx, ord, cycle, deps, asts, incoming };
  }

  // inputs: {변수id: 값} — 고객 입력값을 덮어쓴다(대량 시뮬레이션은 행마다 이것만 바꾼다)
  function evaluate(strategy, inputs, prep) {
    inputs = inputs || {};
    if (!prep || prep.strategy !== strategy) prep = prepare(strategy);
    const { idx, ord, cycle, deps, asts, incoming } = prep;
    const steps = {};
    const result = { status: 'ok', final: null, finalNodeId: finalNodeId(strategy), determinant: null, reason: null, steps, errors: [] };

    if (cycle.length) {
      result.status = 'error';
      result.errors.push(`순서가 고리처럼 돌아가는 단계가 있습니다: ${cycle.map(id => idx.nodes.get(id).name).join(', ')}`);
      return result;
    }

    const varValue = (v) => {
      if (v.type === 'table') throw new CalcError(`표 [${v.name}]은(는) 값으로 쓸 수 없습니다 — 표 조회 단계를 쓰세요`);
      if (v.type === 'debt') throw new CalcError(`부채표 [${v.name}]은(는) 값으로 쓸 수 없습니다 — [${v.name}${PART_SEP}고금리채무]처럼 합계를 고르세요`);
      const raw = Object.prototype.hasOwnProperty.call(inputs, v.id) && v.kind === 'input' ? inputs[v.id] : v.value;
      if (v.type === 'bool') return raw === true || raw === 1 || raw === '1' || raw === 'Y' || raw === '예' || raw === 'true' ? 1 : 0;
      if (v.type === 'choice') return raw === null || raw === undefined ? '' : String(raw);
      return raw;
    };

    const resolve = (ref) => {
      if (!ref) throw new CalcError('참조가 비어 있습니다');
      if (ref.k === 'num' || ref.k === 'str') return ref.v;
      if (ref.k === 'in' || (ref.k === 'name' && ref.v === IN_NAME)) return incomingValue();
      if (ref.k === 'name') {
        const r = idx.byName.get(ref.v);
        if (!r) throw new CalcError(`[${ref.v}]라는 변수나 단계가 없습니다`);
        return resolve(r);
      }
      if (ref.k === 'var') {
        const v = idx.vars.get(ref.id);
        if (!v) throw new CalcError('삭제된 변수를 참조하고 있습니다');
        return varValue(v);
      }
      if (ref.k === 'part' && idx.vars.has(ref.id)) {
        const v = idx.vars.get(ref.id);
        const d = debtOf(v);
        if (d.parts[ref.part] === undefined) {
          if (ref.part === 'high') throw new CalcError(`부채표 [${v.name}]의 고금리 기준을 정하세요(변수·표 탭)`);
          throw new CalcError(`[${v.name}${PART_SEP}${partLabel(v, ref.part)}] 값이 없습니다`);
        }
        return d.parts[ref.part];
      }
      if (ref.k === 'node' || ref.k === 'part') {
        const n = idx.nodes.get(ref.id);
        if (!n) throw new CalcError('삭제된 단계를 참조하고 있습니다');
        const s = steps[ref.id];
        if (!s || !s.active) throw new CalcError(`[${n.name}] 단계는 이번 계산 경로에 없습니다`);
        if (s.error) throw new CalcError(`[${n.name}] 단계에 오류가 있습니다`);
        if (ref.k === 'node') return s.value;
        if (!s.parts || !(ref.part in s.parts)) throw new CalcError(`[${n.name}${PART_SEP}${partLabel(n, ref.part)}] 값이 없습니다`);
        return s.parts[ref.part];
      }
      throw new CalcError('알 수 없는 참조입니다');
    };

    // 부채표 합계는 이번 계산에서 한 번만 구한다. 잔액은 고객 입력값 — 대량 시뮬레이션은 inputs[부채표 id]에 행 순서대로 잔액 배열을 넘긴다
    const debts = result.debts = {};
    const debtOf = (v) => {
      if (debts[v.id]) return debts[v.id];
      if (v.hiRate && v.hiRate.k !== 'var' && v.hiRate.k !== 'num') throw new CalcError(`부채표 [${v.name}]의 고금리 기준은 변수나 숫자로 정합니다`);
      const hi = v.hiRate ? num(resolve(v.hiRate), `[${v.name}] 고금리 기준`) : null;
      const given = Object.prototype.hasOwnProperty.call(inputs, v.id) && Array.isArray(inputs[v.id]) ? inputs[v.id] : null;
      return (debts[v.id] = debtAggregate(v, hi, given));
    };

    // 지금 계산 중인 단계로 "지나온" 화살표의 앞 단계 값. 활성 판정과 같은 기준으로 고른다
    let current = null;
    const taken = (e) => {
      const s = steps[e.from];
      if (!s || !s.active) return false;
      return idx.nodes.get(e.from).type !== 'branch' || s.value === e.label;
    };
    const incomingValue = () => {
      const ins = incoming.get(current.node.id);
      if (ins.length < 2) throw new CalcError(`[${IN_NAME}]는 화살표가 두 개 이상 들어오는 단계에서만 쓸 수 있습니다`);
      const from = [...new Set(ins.filter(taken).map(e => e.from))];
      if (!from.length) throw new CalcError('지나온 경로가 없습니다');
      if (from.length > 1) throw new CalcError(`여러 경로(${from.map(id => idx.nodes.get(id).name).join(', ')})를 함께 지나와 [${IN_NAME}]을 정할 수 없습니다`);
      const src = steps[from[0]];
      if (src.error) throw new CalcError(`[${idx.nodes.get(from[0]).name}] 단계에 오류가 있습니다`);
      current.step.from = idx.nodes.get(from[0]).name;
      return src.value;
    };

    const refName = (ref) => {
      if (!ref) return '';
      if (ref.k === 'in') return IN_NAME;
      if (ref.k === 'part') { const x = idx.nodes.get(ref.id) || idx.vars.get(ref.id) || {}; return `${x.name || '(삭제됨)'}${PART_SEP}${partLabel(x, ref.part)}`; }
      if (ref.k === 'var') return (idx.vars.get(ref.id) || {}).name || '(삭제됨)';
      if (ref.k === 'node') return (idx.nodes.get(ref.id) || {}).name || '(삭제됨)';
      return fmtNum(ref.v);
    };

    const astOf = (id) => {
      const a = asts.get(id);
      if (a instanceof Error) throw a;
      return a;
    };

    let halted = false;
    for (const id of ord) {
      const node = idx.nodes.get(id);
      const step = steps[id] = { active: false, value: null };
      if (halted) { step.skipped = true; continue; }

      // 활성 판정: 들어오는 화살표가 없으면 시작 단계. 있으면 그중 하나라도 "탄 경로"여야 한다
      const ins = incoming.get(id);
      step.active = !ins.length || ins.some(taken);
      if (!step.active) continue;
      current = { node, step };

      try {
        evalNode(node, step);
      } catch (err) {
        if (!(err instanceof CalcError)) throw err;
        step.error = err.message;
        result.errors.push(`[${node.name}] ${err.message}`);
      }
      if (step.reject) {
        halted = true;
        result.status = 'reject';
        result.reason = step.reason;
        result.determinant = step.reason;
        result.final = 0;
      }
    }

    function evalNode(node, step) {
      const c = node.config || {};
      switch (node.type) {
        case 'pva': {
          const lines = c.lines || [];
          if (!lines.length) throw new CalcError('줄이 없습니다 — [+ 줄 추가]로 식을 만드세요');
          // 현가계수: 금리·기간을 둘 다 고르면 계산한다. 줄에서 쓰는데 비어 있으면 오류
          let factor;
          if (rateTokens(c).length && c.months) {
            // 금리 조각: 값·전략 파라미터·앞 단계 + 표 값(행·열 기준값으로 표의 숫자를 찾는다)
            const rateRef = (ref) => {
              if (!ref || ref.k !== 'tbl') return resolve(ref);
              const tv = ref.table && idx.vars.get(ref.table.id);
              if (!tv || tv.type !== 'table') throw new CalcError('금리를 가져올 표를 고르세요');
              return lookupTable(tv, resolve(ref.row), tv.cols ? resolve(ref.col) : null, resolve);
            };
            let rate;
            try { rate = num(evalAst(astOf(`${node.id}#rate`), rateRef), '현가계수 금리'); }
            catch (e) {
              if (!(e instanceof CalcError) || e.message.startsWith(`${PVF_NAME} 금리`)) throw e;
              throw new CalcError(`${PVF_NAME} 금리: ${e.message}`);
            }
            step.rate = rate;
            const r = rate / 12, m = num(resolve(c.months), '현가계수 기간');
            factor = r === 0 ? m : (1 - Math.pow(1 + r, -m)) / r;
          }
          const vals = {};
          const local = (ref) => {
            if (ref && ref.k === 'pvf') {
              if (factor === undefined) throw new CalcError(`${PVF_NAME}의 금리·기간을 고르세요`);
              return factor;
            }
            if (ref && ref.k === 'line') {
              const l = lines.find(x => x.id === ref.id);
              if (!l) throw new CalcError('삭제된 줄을 참조하고 있습니다');
              if (!(ref.id in vals)) throw new CalcError(`[${l.name}] 줄은 아래에 있어 쓸 수 없습니다(위 줄만 씁니다)`);
              return vals[ref.id];
            }
            return resolve(ref);
          };
          step.lines = [];
          for (const l of lines) {
            let v;
            try { v = num(evalAst(astOf(`${node.id}#${l.id}`), local), `[${l.name}] 계산 결과`); }
            catch (e) {
              if (!(e instanceof CalcError) || e.message.startsWith(`[${l.name}] 줄`)) throw e;
              throw new CalcError(`[${l.name}] 줄: ${e.message}`);
            }
            vals[l.id] = v;
            // 계산 과정 표시용: 조각마다 값(연산 기호·괄호는 null)
            step.lines.push({ id: l.id, name: l.name, value: v, vals: (l.tokens || []).map(t => (t.t === 'ref' ? local(t.ref) : t.t === 'num' ? t.v : null)) });
          }
          step.parts = Object.assign({}, vals, factor === undefined ? {} : { factor });
          if (factor !== undefined) step.factor = factor;
          step.value = vals[lines[lines.length - 1].id];
          break;
        }
        case 'arith': step.value = num(evalAst(astOf(node.id), resolve), '계산 결과'); break;
        case 'formula': step.value = evalAst(astOf(node.id), resolve); break;
        case 'lookup': {
          const tv = idx.vars.get(c.table && c.table.id);
          if (!tv || tv.type !== 'table') throw new CalcError('조회할 표를 고르세요');
          step.value = lookupTable(tv, resolve(c.row), tv.cols ? resolve(c.col) : null, resolve);
          break;
        }
        case 'progressive': {
          const tv = idx.vars.get(c.table && c.table.id);
          if (!tv || tv.type !== 'table') throw new CalcError('누진 합산할 구간표를 고르세요');
          step.value = progressiveSum(tv, num(resolve(c.base), refName(c.base)), resolve);
          break;
        }
        case 'minmax': {
          const items = c.items || [];
          if (!items.length) throw new CalcError('비교할 항목을 고르세요');
          const vals = items.map(r => num(resolve(r), refName(r)));
          let best = 0;
          for (let i = 1; i < vals.length; i++) if (c.mode === 'max' ? vals[i] > vals[best] : vals[i] < vals[best]) best = i;
          step.value = vals[best];
          step.chosen = refName(items[best]);
          step.candidates = items.map((r, i) => ({ name: refName(r), value: vals[i] }));
          break;
        }
        case 'cond': step.value = evalGroup(c.when, resolve) ? resolve(c.then) : resolve(c.else); break;
        case 'cutoff': {
          const hit = evalGroup(c.when, resolve);
          step.triggered = hit;
          if (hit && c.action === 'reject') { step.reject = true; step.reason = c.reason || node.name; step.value = 0; }
          else if (hit) { step.value = 0; step.reason = c.reason || node.name; }
          else step.value = c.input ? resolve(c.input) : null;
          break;
        }
        case 'branch': {
          const hitCase = (c.cases || []).find(k => evalGroup(k.when, resolve));
          step.value = hitCase ? hitCase.label : (c.elseLabel || '그 외');
          break;
        }
        default: throw new CalcError(`알 수 없는 계산 유형: ${node.type}`);
      }
    }

    if (result.status === 'reject') return result;

    const fid = result.finalNodeId;
    const fs = fid && steps[fid];
    if (!fs || !fs.active || fs.error) {
      result.status = 'error';
      if (!fid) result.errors.push('계산 단계가 없습니다');
      else if (fs && !fs.active) result.errors.push(`최종 단계 [${idx.nodes.get(fid).name}]까지 경로가 이어지지 않았습니다`);
      return result;
    }
    result.final = fs.value;

    // 결정요인: 최종 단계의 조상 중(자신 포함) 뒤에서부터 — 0원 컷오프가 걸렸으면 그 사유, 아니면 최솟값·최댓값 단계가 고른 항목
    const anc = new Set([fid]);
    const stack = [fid];
    while (stack.length) {
      const x = stack.pop();
      for (const d of deps.get(x)) if (!anc.has(d)) { anc.add(d); stack.push(d); }
    }
    for (let i = ord.length - 1; i >= 0; i--) {
      const id = ord[i];
      if (!anc.has(id)) continue;
      const s = steps[id];
      if (!s.active || s.error) continue;
      if (s.triggered && s.reason) { result.determinant = s.reason; result.reason = s.reason; break; }
      if (s.chosen) { result.determinant = s.chosen; break; }
    }
    if (result.errors.length) result.status = 'error';
    return result;
  }

  // ── 검증 ─────────────────────────────────────────────────────────────────
  function validate(strategy) {
    const issues = [];
    const idx = index(strategy);
    const names = new Map();
    for (const x of [...strategy.variables, ...strategy.nodes]) {
      if (!x.name || !x.name.trim()) issues.push('이름이 빈 항목이 있습니다');
      else if (names.has(x.name)) issues.push(`이름이 겹칩니다: ${x.name}`);
      else names.set(x.name, true);
      if (x.name && /[\[\]]/.test(x.name)) issues.push(`이름에 [ ] 를 쓸 수 없습니다: ${x.name}`);
    }
    for (const v of strategy.variables) {
      if (v.type === 'debt') {
        const keys = v.rows.map(r => `${r.sector}|${r.kind}`);
        if (new Set(keys).size !== keys.length) issues.push(`부채표 [${v.name}]에 업권·대출구분이 겹치는 행이 있습니다`);
        if (v.rows.some(r => !(toNum(r.months) > 0))) issues.push(`부채표 [${v.name}]의 대출기간은 0보다 커야 합니다`);
        if (v.rows.some(r => toNum(r.rate) === null || toNum(r.rate) < 0)) issues.push(`부채표 [${v.name}]의 대출금리를 확인하세요`);
        continue;
      }
      if (v.type !== 'table') continue;
      for (const ax of [v.rows, v.cols].filter(Boolean)) {
        if (ax.mode === 'band') {
          for (let i = 1; i < ax.keys.length; i++) {
            if (!(ax.keys[i] > ax.keys[i - 1])) { issues.push(`표 [${v.name}]의 구간 시작값은 작은 것부터 커져야 합니다`); break; }
          }
        } else if (new Set(ax.keys.map(String)).size !== ax.keys.length) issues.push(`표 [${v.name}]의 항목이 겹칩니다`);
      }
      for (const row of v.cells || []) for (const x of row || []) {
        if (!isCellFormula(x)) continue;
        try { cellAst(x); } catch (e) { issues.push(`표 [${v.name}]의 칸 수식 ${x}: ${e.message}`); }
      }
      for (const name of cellFormulaNames(v)) if (name !== IN_NAME && !idx.byName.has(name)) issues.push(`표 [${v.name}]의 칸 수식에서 [${name}]를 찾을 수 없습니다`);
    }
    for (const n of strategy.nodes) {
      for (const r of collectRefs(n, idx)) {
        if (r.k === 'var' && !idx.vars.has(r.id)) issues.push(`[${n.name}]이(가) 삭제된 변수를 참조합니다`);
        if (r.k === 'node' && !idx.nodes.has(r.id)) issues.push(`[${n.name}]이(가) 삭제된 단계를 참조합니다`);
      }
      if (n.type === 'pva') {
        const ln = new Set();
        for (const l of n.config.lines || []) {
          if (!l.name || !l.name.trim()) issues.push(`[${n.name}]에 이름이 빈 줄이 있습니다`);
          else if (ln.has(l.name)) issues.push(`[${n.name}]의 줄 이름이 겹칩니다: ${l.name}`);
          else if (/[\[\]›]/.test(l.name)) issues.push(`[${n.name}]의 줄 이름에 [ ] › 를 쓸 수 없습니다: ${l.name}`);
          ln.add(l.name);
          try { parseTokens(l.tokens || []); } catch (e) { issues.push(`[${n.name}] [${l.name}] 줄: ${e.message}`); }
        }
        const rt = rateTokens(n.config);
        try { if (rt.length) parseTokens(rt); } catch (e) { issues.push(`[${n.name}] ${PVF_NAME} 금리: ${e.message}`); }
        for (const t of rt) {
          const tv = t.ref && t.ref.k === 'tbl' && t.ref.table && idx.vars.get(t.ref.table.id);
          if (t.ref && t.ref.k === 'tbl' && (!tv || tv.type !== 'table')) issues.push(`[${n.name}] ${PVF_NAME} 금리의 표를 찾을 수 없습니다`);
        }
      }
      if (n.type === 'formula') {
        try {
          for (const v of formulaNames(n.config.text, n.config.lang)) if (v !== IN_NAME && !idx.byName.has(v)) issues.push(`[${n.name}] 수식의 [${v}]를 찾을 수 없습니다`);
          parseFormula(n.config.text, n.config.lang);
        } catch (e) { issues.push(`[${n.name}] 수식 오류: ${e.message}`); }
      }
    }
    const { cycle } = order(strategy, idx);
    if (cycle.length) issues.push(`순서가 고리처럼 돌아가는 단계: ${cycle.map(id => idx.nodes.get(id).name).join(', ')}`);
    return issues;
  }

  // ── 옛 형식 변환 ─────────────────────────────────────────────────────────
  // 없앤 유형으로 저장한 전략(브라우저 임시저장·내보낸 .json·서버 저장본)을 열면 같은 결과가 나오도록 바꾼다.
  // 바꾼 단계 수를 돌려준다
  //   절사·하한·상한 → 고급 수식 / 합류 → 지나온 경로의 값 (2026-09-29)
  //   부채 집계 → 단계를 없애고 부채표 합계를 바로 참조 / 현가계수 → 사칙연산 / 기초한도 요소 8개 → 줄 단위 식 (2026-10-01)
  function migrate(strategy) {
    let changed = 0;
    const idx = index(strategy);
    const expr = (ref) => {
      if (!ref) return '0';
      if (ref.k === 'var' || ref.k === 'node') {
        const x = (ref.k === 'var' ? idx.vars : idx.nodes).get(ref.id);
        return x ? `[${x.name}]` : '[삭제됨]';
      }
      if (ref.k === 'str') return `"${ref.v}"`;
      if (ref.k === 'in') return `[${IN_NAME}]`;
      return String(ref.v);
    };
    // 모든 단계 설정 안의 참조를 fn(ref)로 바꾼다(fn이 undefined를 돌려주면 그대로)
    const mapRefs = (fn) => {
      const walk = (x) => {
        if (!x || typeof x !== 'object') return x;
        if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) x[i] = walk(x[i]); return x; }
        if (typeof x.k === 'string' && (x.id || x.k === 'part')) { const y = fn(x); if (y !== undefined) return y; }
        for (const key of Object.keys(x)) x[key] = walk(x[key]);
        return x;
      };
      for (const n of strategy.nodes) n.config = walk(n.config);
    };
    const removeNode = (n) => {
      // 들어오는 화살표의 앞 단계를 나가는 화살표의 뒤 단계로 바로 잇는다(분기 경로 이름은 유지)
      const ins = strategy.edges.filter(e => e.to === n.id && e.from !== n.id), outs = strategy.edges.filter(e => e.from === n.id && e.to !== n.id);
      strategy.edges = strategy.edges.filter(e => e.from !== n.id && e.to !== n.id);
      const has = (f, t, l) => strategy.edges.some(e => e.from === f && e.to === t && (e.label || null) === (l || null));
      for (const i of ins) for (const o of outs) {
        if (has(i.from, o.to, i.label)) continue;
        const e = { from: i.from, to: o.to };
        if (i.label !== undefined) e.label = i.label;
        if (i.fa) e.fa = i.fa;
        if (o.ta) e.ta = o.ta;
        strategy.edges.push(e);
      }
      strategy.nodes = strategy.nodes.filter(x => x !== n);
      if (strategy.finalNodeId === n.id) strategy.finalNodeId = null;
    };

    for (const n of [...strategy.nodes]) {
      const c = n.config || {};
      if (n.type === 'clamp') {
        // 하한·상한 → 단위 순서(옛 계산과 같음)
        let x = expr(c.input);
        if (c.min) x = `MAX(${x}, ${expr(c.min)})`;
        if (c.max) x = `MIN(${x}, ${expr(c.max)})`;
        if (c.unit) {
          const u = expr(c.unit);
          x = c.round === 'ceil' ? `CEILING(${x}, ${u})` : c.round === 'round' ? `ROUND(${x} / ${u}, 0) * ${u}` : `FLOOR(${x}, ${u})`;
        }
        n.type = 'formula';
        n.config = { text: x };
        changed++;
      } else if (n.type === 'merge') {
        // 합류 도형 → 들어온 값을 그대로 넘기는 사칙연산(화살표·이름·참조는 그대로 둔다)
        n.type = 'arith';
        n.config = { tokens: [{ t: 'ref', ref: { k: 'in' } }] };
        changed++;
      } else if (n.type === 'pv') {
        // 현가계수 → 사칙연산: [월 상환액] × (1 − (1 + 금리 ÷ 12) ^ (0 − 기간)) ÷ (금리 ÷ 12)
        const op = (v) => ({ t: 'op', v }), lp = { t: 'lp' }, rp = { t: 'rp' }, R = refToken;
        const mr = [lp, R(c.rate), op('/'), { t: 'num', v: 12 }, rp];
        n.type = 'arith';
        n.config = { tokens: [
          ...(c.payment ? [R(c.payment), op('*')] : []),
          lp, { t: 'num', v: 1 }, op('-'), lp, { t: 'num', v: 1 }, op('+'), ...mr, rp, op('^'), lp, { t: 'num', v: 0 }, op('-'), R(c.months), rp, rp,
          op('/'), ...mr,
        ] };
        changed++;
      } else if (n.type === 'pva' && !Array.isArray(c.lines)) {
        // 요소 8개 → 기본형 줄(줄 id가 옛 중간값과 같아 참조가 그대로 이어진다)
        n.config = { lines: pvaDefaultLines((k) => refToken(c[k])), rate: c.rate || null, months: c.months || null };
        changed++;
      }
    }

    // 부채 집계: 그 단계의 중간값·값 참조를 부채표 합계로 옮기고, 고금리 기준은 부채표 설정으로 옮긴 뒤 단계를 없앤다
    for (const n of strategy.nodes.filter(x => x.type === 'debt')) {
      const c = n.config || {};
      const tv = c.table && strategy.variables.find(v => v.id === c.table.id && v.type === 'debt');
      if (tv) {
        if (!tv.hiRate && c.hiRate && (c.hiRate.k === 'var' || c.hiRate.k === 'num')) tv.hiRate = c.hiRate;
        mapRefs((r) => (r.id === n.id && (r.k === 'part' || r.k === 'node') ? { k: 'part', id: tv.id, part: r.k === 'node' ? 'pay' : r.part } : undefined));
        const label = (part) => (DEBT_PARTS.find(p => p[0] === part) || [])[1];
        for (const m of strategy.nodes) {
          if (m.type !== 'formula' || !m.config.text) continue;
          let t = m.config.text;
          for (const [part] of DEBT_PARTS) t = t.split(`[${n.name}${PART_SEP}${label(part)}]`).join(`[${tv.name}${PART_SEP}${label(part)}]`);
          m.config.text = t.split(`[${n.name}]`).join(`[${tv.name}${PART_SEP}${label('pay')}]`);
        }
      }
      removeNode(n);
      changed++;
    }
    return changed;
  }

  // ── 대량 시뮬레이션 입력 ───────────────────────────────────────────────
  // 엑셀 한 줄을 evaluate의 inputs로 바꾼다. 열 = 고객 입력값(표 제외) + 부채표 행별 잔액
  function inputColumns(strategy) {
    const cols = [];
    for (const v of strategy.variables) {
      if (v.kind !== 'input' || v.type === 'table') continue;
      if (v.type === 'debt') {
        v.rows.forEach((r, i) => cols.push({ key: `${v.id}#${i}`, label: `${v.name}_${r.sector}_${r.kind}`, varId: v.id, row: i, type: 'money', debt: true, desc: `${v.name} — ${r.sector} · ${r.kind} 잔액(원)` }));
        continue;
      }
      cols.push({ key: v.id, label: v.name, varId: v.id, type: v.type, options: v.options, desc: v.desc || '' });
    }
    return cols;
  }

  const normHeader = (x) => String(x ?? '').replace(/\s+/g, '').toLowerCase();

  // 열 제목이 변수 이름과 같으면(띄어쓰기·대소문자 무시) 자동으로 맞춘다. 결과: {열 key: 제목 번호 | -1}
  function autoMap(cols, headers) {
    const idx = new Map(headers.map((x, i) => [normHeader(x), i]));
    return Object.fromEntries(cols.map(c => [c.key, idx.has(normHeader(c.label)) ? idx.get(normHeader(c.label)) : -1]));
  }

  // 셀 하나 → 값. 비었으면 {empty}, 형식이 틀리면 {error}
  function parseInputCell(col, raw) {
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return { empty: true };
    if (col.type === 'bool') {
      const t = String(raw).trim().toUpperCase();
      if (['Y', '예', '1', 'TRUE', 'O'].includes(t)) return { value: true };
      if (['N', '아니오', '0', 'FALSE', 'X'].includes(t)) return { value: false };
      return { error: `예/아니오(Y/N)가 아닙니다: ${raw}` };
    }
    if (col.type === 'choice') {
      const t = String(raw).trim();
      return (col.options || []).includes(t) ? { value: t } : { error: `선택지(${(col.options || []).join('·')})에 없습니다: ${raw}` };
    }
    if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : { error: `숫자가 아닙니다: ${raw}` };
    const str = String(raw).trim();
    const pct = str.endsWith('%');
    const n = Number(str.replace(/[,\s원%]/g, ''));
    if (isNaN(n)) return { error: `숫자가 아닙니다: ${raw}` };
    return { value: pct ? n / 100 : n };
  }

  // 한 줄 → {inputs, warnings, errors}. 잔액 칸이 비면 0, 다른 칸이 비면 전략의 기본값을 쓰고 알린다
  function rowInputs(strategy, cols, mapping, row) {
    const inputs = {}, warnings = [], errors = [];
    const vars = new Map(strategy.variables.map(v => [v.id, v]));
    for (const c of cols) {
      const at = mapping[c.key];
      const cell = at >= 0 ? parseInputCell(c, row[at]) : { empty: true };
      if (cell.error) { errors.push(`${c.label}: ${cell.error}`); continue; }
      if (c.debt) {
        if (!inputs[c.varId]) inputs[c.varId] = vars.get(c.varId).rows.map(() => 0);
        inputs[c.varId][c.row] = cell.empty ? 0 : cell.value;
        continue;
      }
      if (cell.empty) { warnings.push(`${c.label} 기본값 사용`); continue; }
      inputs[c.varId] = cell.value;
    }
    return { inputs, warnings, errors };
  }

  // 이 변수·단계를 참조하는 단계 목록(삭제 전 영향 확인용)
  function findReferences(strategy, id) {
    const idx = index(strategy);
    return strategy.nodes.filter(n => n.id !== id && collectRefs(n, idx).some(r => r.id === id));
  }

  // 이름 변경 시 고급 수식·표의 계산식 칸 안의 [옛 이름]을 [새 이름]으로 바꾼다
  function renameInFormulas(strategy, oldName, newName) {
    const swap = (t) => t.split(`[${oldName}]`).join(`[${newName}]`)
      .split(`[${oldName}${PART_SEP}`).join(`[${newName}${PART_SEP}`);   // 기초한도 줄·부채표 합계 이름
    for (const n of strategy.nodes) {
      if (n.type !== 'formula' || !n.config.text) continue;
      n.config.text = swap(n.config.text);
    }
    for (const v of strategy.variables) {
      if (v.type !== 'table') continue;
      v.cells = v.cells.map(row => row.map(x => (isCellFormula(x) ? swap(x) : x)));
    }
  }

  // ── 표시 ─────────────────────────────────────────────────────────────────
  function fmtNum(v, digits) {
    const n = toNum(v);
    if (n === null) return fmtRaw(v);
    const d = digits !== undefined ? digits : (Math.abs(n) >= 1000 || Number.isInteger(n) ? 0 : 4);
    return n.toLocaleString('ko-KR', { maximumFractionDigits: d });
  }

  function fmtValue(v, format) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string') return v;
    switch (format) {
      case 'money': return `${fmtNum(v, 0)}원`;
      case 'percent': return `${fmtNum(v * 100, 2)}%`;
      default: return fmtNum(v);
    }
  }

  function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  function emptyStrategy(name) {
    const now = new Date().toISOString();
    return { schema: SCHEMA, meta: { name: name || '새 전략', description: '', created: now, updated: now }, variables: [], nodes: [], edges: [], finalNodeId: null };
  }

  return {
    SCHEMA, NODE_TYPES, VAR_TYPES, CMP_OPS, IN_NAME, PVF_NAME, PVA_SLOTS, DEBT_PARTS, DEBT_MORT, PART_SEP, CalcError,
    pvaDefaultLines, rateTokens, refToken, partsOf, monthlyPayment, debtAggregate, inputColumns, autoMap, parseInputCell, rowInputs,
    prepare, evaluate, validate, order, index, findReferences, renameInFormulas, finalNodeId, migrate,
    tokenize, parseTokens, evalAst, LANGS, parseFormula, formulaNames, lookupTable, progressiveSum, axisKeyLabel, isCellFormula,
    toNum, fmtNum, fmtValue, newId, emptyStrategy,
  };
});
