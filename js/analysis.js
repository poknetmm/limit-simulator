/* ============================================================================
   대량 분석기 집계 — 데이터 읽기·행별 계산·리포트 ①~⑤ 수치
   ----------------------------------------------------------------------------
   화면과 무관한 순수 함수. 브라우저(window.Analysis)와 Node(require) 양쪽에서 같은 코드를 쓴다.
   · 이 파일은 스튜디오 화면(index.html)에서 부르지 않는다. 내려받기 때 글로 읽어 분석기 파일 안에 넣는다(htmlexport.js)
   · 행 단위 값(원본 칸·건 ID)은 이 파일이 만드는 결과에 싣지 않는다. 행별 결과는 상태·최종한도·결정요인 번호만 배열로 둔다
   · 엔진·입력 오류 문장에는 칸 값이 섞일 수 있어 어디에도 담지 않는다. 오류는 열별 건수만 센다
   ========================================================================== */
(function (root, factory) {
  const X = factory(root && root.LimitEngine ? root.LimitEngine : require('./engine.js'));
  if (typeof module === 'object' && module.exports) module.exports = X;
  else root.Analysis = X;
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const MAX_ROWS = 50000;
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // ── 값 읽기 ─────────────────────────────────────────────────────────────
  const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

  // 칸 → 숫자(읽을 수 없으면 null). 쉼표·공백·원 제거, %는 ÷100 — E.parseInputCell과 같은 규칙
  function toNumber(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
    const s = String(raw).trim();
    if (!s) return null;
    const pct = s.endsWith('%');
    const t = s.replace(/[,\s원%]/g, '');
    if (!NUM_RE.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? (pct ? n / 100 : n) : null;
  }

  // 부실 여부 칸 → 1(불량) · 0(정상) · 2(판정 불가). 앞뒤 공백·대소문자 무시
  const BAD_SET = new Set(['Y', '1', 'TRUE', '예', 'O']);
  const GOOD_SET = new Set(['N', '0', 'FALSE', '아니오', 'X']);
  function badValue(raw) {
    if (raw === null || raw === undefined) return 2;
    const t = String(raw).trim().toUpperCase();
    return BAD_SET.has(t) ? 1 : GOOD_SET.has(t) ? 0 : 2;
  }

  // ── 붙여넣기 읽기 ───────────────────────────────────────────────────────
  // 엑셀에서 복사한 글: 줄 = \r\n 또는 \n, 칸 = 탭. 큰따옴표로 감싼 칸(줄바꿈·탭이 든 칸)은 따옴표를 풀고 ""는 "로.
  // 시간 조각으로 나눠 읽을 수 있게 step(예산 ms)를 둔다(5만 줄을 한 번에 읽으면 화면이 멈춘다)
  const MSG_NO_TAB = '탭으로 나뉜 표가 아닙니다 — 엑셀에서 제목줄을 포함해 범위를 복사하세요';
  const MSG_NO_ROWS = '제목줄만 있고 데이터 행이 없습니다 — 제목줄 아래 데이터까지 포함해 범위를 복사하세요';
  const MSG_RANGE = '시트 범위가 5만 행을 넘어 뒤쪽을 읽지 않았습니다. 빈 줄이나 서식만 있는 줄을 지우거나, 범위를 복사해 붙여 넣으세요';
  const MSG_EMPTY = '붙여 넣은 글이 비어 있습니다 — 엑셀에서 제목줄을 포함해 범위를 복사하세요';
  const overMessage = (total) => `5만 건까지 넣을 수 있습니다(지금 ${Number(total).toLocaleString('ko-KR')}건)`;

  function createPasteParser(text, maxRows) {
    text = String(text);
    maxRows = maxRows || MAX_ROWS;
    const len = text.length;
    let pos = 0, nextTab = -2, nextNl = -2;
    let headers = null, cur = [], rows = [], total = 0, shortRows = 0, longRows = 0, finished = false;

    // pos 이후 첫 탭·줄바꿈 위치(없으면 -1). 가까운 위치를 기억해 두어 줄이 길어도 처음부터 다시 찾지 않는다
    function delim(p) {
      if (nextTab !== -1 && nextTab < p) nextTab = text.indexOf('\t', p);
      if (nextNl !== -1 && nextNl < p) nextNl = text.indexOf('\n', p);
      if (nextTab === -1) return nextNl;
      if (nextNl === -1) return nextTab;
      return nextTab < nextNl ? nextTab : nextNl;
    }

    function finishRow() {
      const row = cur; cur = [];
      if (row.every(v => v.trim() === '')) return;
      if (headers === null) {
        headers = row.map(v => v.trim());
        if (headers.length < 2) finished = true;
        return;
      }
      total++;
      if (total > maxRows) return;
      if (row.length < headers.length) { shortRows++; while (row.length < headers.length) row.push(''); }
      else if (row.length > headers.length) { longRows++; row.length = headers.length; }
      rows.push(row);
    }

    function step(budgetMs) {
      const t0 = now();
      let k = 0;
      while (!finished && (pos < len || cur.length)) {
        let val, d, quoted = false;
        if (text.charCodeAt(pos) === 34) {
          // 따옴표 칸: 닫는 따옴표가 있고 그 바로 뒤가 탭·줄바꿈·끝일 때만 따옴표 칸으로 읽는다.
          // 아니면(닫히지 않음·뒤에 글자가 붙음) 따옴표 없는 칸으로 다시 읽어 뒤 데이터가 한 칸으로 합쳐지지 않게 한다
          let i = pos + 1, out = '', ok = false;
          for (;;) {
            const q = text.indexOf('"', i);
            if (q < 0) break;
            if (text.charCodeAt(q + 1) === 34) { out += text.slice(i, q + 1); i = q + 2; continue; }
            out += text.slice(i, q); i = q + 1;
            const c = text.charCodeAt(i);
            ok = i >= len || c === 9 || c === 10 || (c === 13 && (i + 1 >= len || text.charCodeAt(i + 1) === 10));
            break;
          }
          if (ok) {
            quoted = true;
            d = i < len ? delim(i) : -1;
            val = out;
          }
        }
        if (!quoted) {
          d = pos < len ? delim(pos) : -1;
          const end = d < 0 ? len : d;
          val = text.slice(pos, end);
          if ((d < 0 || text.charCodeAt(d) === 10) && val.endsWith('\r')) val = val.slice(0, -1);
        }
        cur.push(val);
        if (d >= 0 && text.charCodeAt(d) === 9) pos = d + 1;
        else { finishRow(); pos = d < 0 ? len : d + 1; }
        if ((++k & 255) === 0 && now() - t0 >= budgetMs) break;
      }
      if (pos >= len && !cur.length) finished = true;
      return finished;
    }

    function result() {
      if (headers === null) return { ok: false, message: MSG_EMPTY };
      if (headers.length < 2) return { ok: false, message: MSG_NO_TAB };
      if (total === 0) return { ok: false, message: MSG_NO_ROWS };
      if (total > maxRows) return { ok: false, message: overMessage(total), total };
      return { ok: true, headers, rows, total, short: shortRows, long: longRows };
    }
    return { step, result, get done() { return finished; }, get pos() { return pos; }, get length() { return len; } };
  }

  function parsePaste(text, maxRows) {
    const p = createPasteParser(text, maxRows);
    while (!p.step(1e9)) { /* 한 번에 끝까지 */ }
    return p.result();
  }

  // 엑셀 시트를 2차원 배열(sheet_to_json header:1)로 읽은 것 → 제목줄 + 행. totalHint: 5만 건을 넘을 때 알릴 건수
  function fromAoa(aoa, opt) {
    opt = opt || {};
    const maxRows = opt.maxRows || MAX_ROWS;
    if (!aoa || !aoa.length) return { ok: false, message: '첫 시트가 비어 있습니다' };
    const headers = aoa[0].map(x => (x === null || x === undefined ? '' : String(x).trim()));
    if (!headers.length) return { ok: false, message: '첫 시트가 비어 있습니다' };
    const w = headers.length, rows = [];
    for (let r = 1; r < aoa.length; r++) {
      const src = aoa[r], row = new Array(w);
      let blank = true;
      for (let j = 0; j < w; j++) {
        let v = src[j];
        if (v === null || v === undefined) v = '';
        else if (typeof v === 'boolean') v = v ? 'TRUE' : 'FALSE';
        else if (v instanceof Date) v = String(v.toISOString());
        if (blank && !(v === '' || (typeof v === 'string' && v.trim() === ''))) blank = false;
        row[j] = v;
      }
      if (!blank) rows.push(row);
    }
    if (rows.length > maxRows) return { ok: false, message: overMessage(Math.max(rows.length, opt.totalHint || 0)), total: rows.length };
    if (!rows.length) return { ok: false, message: MSG_NO_ROWS };
    return { ok: true, headers, rows, total: rows.length, short: 0, long: 0 };
  }

  // ── 열 맞춤 자동 찾기 ───────────────────────────────────────────────────
  const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, '').toLowerCase();
  function findHeader(headers, names) {
    const set = new Set(names.map(norm));
    return headers.findIndex(h => set.has(norm(h)));
  }
  const autoBadCol = (headers) => findHeader(headers, ['부실', '불량', '부실여부', '불량여부', 'bad']);
  const autoAmtCol = (headers) => findHeader(headers, ['실행금액', '대출금액', '기존한도']);

  // ── 행별 계산 ───────────────────────────────────────────────────────────
  // 상태 번호: 0 정상 · 1 거절 · 2 계산 오류 · 3 입력 오류
  const ST_OK = 0, ST_REJECT = 1, ST_ERROR = 2, ST_INPUT = 3;

  // 전략 하나를 모든 행에 돌린다. step(예산 ms)로 시간 조각을 나눠 부른다(화면이 양보하며 진행률을 그리게).
  // 행마다 상태·최종한도·결정요인 번호만 남긴다(단계별 값·오류 문장은 남기지 않는다).
  // opt.watch: 단계 id 목록 — 그 단계를 지난 행(활성·오류 없음) 표시를 남긴다(③ "기준 최소 단계를 지난 건")
  function createRunner(strategy, cols, mapping, rows, opt) {
    opt = opt || {};
    const n = rows.length;
    const prep = E.prepare(strategy);      // 행마다가 아니라 한 번만 준비
    const status = new Uint8Array(n), final = new Float64Array(n), det = new Uint16Array(n);
    const labels = [''], labelIdx = new Map([['', 0]]);
    const labelOf = (t) => {
      t = t == null ? '' : String(t);
      let k = labelIdx.get(t);
      if (k === undefined) { if (labels.length >= 65535) return 0; k = labels.length; labels.push(t); labelIdx.set(t, k); }
      return k;
    };
    const watch = (opt.watch || []).map(id => ({ id, arr: new Uint8Array(n) }));
    const errCols = new Map();
    let defaults = 0, i = 0;

    function countErrCols(row) {
      for (const c of cols) {
        const at = mapping[c.key];
        if (!(at >= 0)) continue;
        if (E.parseInputCell(c, row[at]).error) errCols.set(c.label, (errCols.get(c.label) || 0) + 1);
      }
    }

    function one(k) {
      const row = rows[k];
      const ri = E.rowInputs(strategy, cols, mapping, row);
      if (ri.warnings.length) defaults++;
      if (ri.errors.length) { status[k] = ST_INPUT; if (opt.countErrors !== false) countErrCols(row); return; }
      let r;
      try { r = E.evaluate(strategy, ri.inputs, prep); } catch (e) { status[k] = ST_ERROR; return; }
      if (r.status === 'reject') { status[k] = ST_REJECT; final[k] = 0; det[k] = labelOf(r.reason); }
      else if (r.status === 'ok' && typeof r.final === 'number' && Number.isFinite(r.final)) { status[k] = ST_OK; final[k] = r.final; det[k] = labelOf(r.determinant); }
      else status[k] = ST_ERROR;
      for (const w of watch) { const s = r.steps[w.id]; if (s && s.active && !s.error) w.arr[k] = 1; }
    }

    function step(budgetMs) {
      const t0 = now();
      let c = 0;
      while (i < n) {
        one(i); i++;
        if ((++c & 31) === 0 && now() - t0 >= budgetMs) break;   // 약 32건마다 경과 시간을 본다
      }
      return i >= n;
    }

    function result() {
      const passed = {};
      for (const w of watch) passed[w.id] = w.arr;
      return { n, status, final, det, labels, passed, inputErrCols: [...errCols.entries()], defaults };
    }
    return { step, result, get done() { return i >= n; }, get index() { return i; }, total: n };
  }

  // ── 분석 맥락 ───────────────────────────────────────────────────────────
  // o: {headers, rows, badCol, amtCol, orig, changed}
  function makeContext(o) {
    const n = o.rows.length;
    const bad = new Uint8Array(n);
    for (let i = 0; i < n; i++) bad[i] = o.badCol >= 0 ? badValue(o.rows[i][o.badCol]) : 2;
    let amt = null, amtInvalid = 0;
    if (o.amtCol >= 0) {
      amt = new Float64Array(n);
      for (let i = 0; i < n; i++) { const v = toNumber(o.rows[i][o.amtCol]); if (v === null) { amt[i] = 0; amtInvalid++; } else amt[i] = v; }
    }
    return { n, headers: o.headers, rows: o.rows, bad, amt, amtInvalid, orig: o.orig, changed: o.changed || null, colCache: new Map() };
  }

  // 열 하나를 숫자로 읽은 것: state 0 빈 값 · 1 숫자 · 2 숫자 아님
  function colInfo(ctx, c) {
    let ci = ctx.colCache.get(c);
    if (ci) return ci;
    const n = ctx.n, num = new Float64Array(n), state = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const raw = ctx.rows[i][c];
      if (isBlank(raw)) { state[i] = 0; num[i] = NaN; continue; }
      const v = toNumber(raw);
      if (v === null) { state[i] = 2; num[i] = NaN; } else { state[i] = 1; num[i] = v; }
    }
    ci = { num, state };
    ctx.colCache.set(c, ci);
    return ci;
  }

  // ── ① 대상자 선정 ───────────────────────────────────────────────────────
  const COND_OPS = ['=', '≠', '>', '≥', '<', '≤', '비어 있음', '비어 있지 않음', '포함'];
  const NO_VALUE_OPS = new Set(['비어 있음', '비어 있지 않음']);

  function condTest(ctx, cond) {
    const info = colInfo(ctx, cond.col), c = cond.col, op = cond.op;
    const rows = ctx.rows;
    if (op === '비어 있음') return (i) => info.state[i] === 0;
    if (op === '비어 있지 않음') return (i) => info.state[i] !== 0;
    const v = String(cond.value == null ? '' : cond.value).trim();
    const vn = toNumber(v);
    const text = (i) => { const r = rows[i][c]; return r === null || r === undefined ? '' : String(r).trim(); };
    if (op === '포함') return (i) => text(i).includes(v);
    const ordering = op === '>' || op === '≥' || op === '<' || op === '≤';
    return (i) => {
      let a, b;
      if (vn !== null && info.state[i] === 1) { a = info.num[i]; b = vn; }
      else if (vn !== null && ordering) return false;     // 비교 값이 숫자이면 빈 칸·숫자 아님은 크기 비교에서 거짓
      else { a = text(i); b = v; }
      switch (op) {
        case '=': return a === b;
        case '≠': return a !== b;
        case '>': return a > b;
        case '≥': return a >= b;
        case '<': return a < b;
        case '≤': return a <= b;
      }
      return false;
    };
  }

  const condText = (ctx, cond) => `[${ctx.headers[cond.col] || ''}] ${cond.op}${NO_VALUE_OPS.has(cond.op) ? '' : ` ${cond.value == null ? '' : cond.value}`}`;

  // conds: [{col, op, value, name}] — 앞 줄에서 남은 건에만 차례로 적용한다. 반환 keep = 분석 대상 표시(1)
  function selection(ctx, conds) {
    const n = ctx.n, bad = ctx.bad;
    const keep = new Uint8Array(n).fill(1);
    let totalBad = 0;
    for (let i = 0; i < n; i++) if (bad[i] === 1) totalBad++;
    const steps = [{ kind: 'start', name: '최초 대상(전체)', cond: '', before: n, excl: null, exclBad: null, remain: n, remainBad: totalBad }];
    const apply = (kind, name, cond, test) => {
      let before = 0, excl = 0, exclBad = 0, remainBad = 0;
      for (let i = 0; i < n; i++) {
        if (!keep[i]) continue;
        before++;
        if (test(i)) { keep[i] = 0; excl++; if (bad[i] === 1) exclBad++; } else if (bad[i] === 1) remainBad++;
      }
      steps.push({ kind, name, cond, before, excl, exclBad, remain: before - excl, remainBad });
    };
    apply('auto', '부실 여부 판정 불가', '부실 여부 칸이 허용 표기가 아니거나 비어 있음', (i) => bad[i] === 2);
    apply('auto', '입력·계산 오류', '원래 전략에서 입력 칸 형식 오류 또는 계산 오류', (i) => ctx.orig.status[i] >= ST_ERROR);
    (conds || []).forEach((cond, k) => apply('user', cond.name || `제외 조건 ${k + 1}`, condText(ctx, cond), condTest(ctx, cond)));
    const last = steps[steps.length - 1];
    return { steps, keep, target: last.remain, targetBad: last.remainBad, total: n };
  }

  // ── ② AS-IS / 원래 / 바꾼 전략 요약 ─────────────────────────────────────
  // pick(i) → 금액(없으면 null = 집계에서 뺀다). 건수 = 금액 > 0, 0원·거절 = 금액 ≤ 0
  function tally(ctx, keep, pick) {
    let count = 0, sum = 0, badN = 0, badAmt = 0, zeroN = 0, zeroBad = 0, skipped = 0;
    const bad = ctx.bad;
    for (let i = 0; i < ctx.n; i++) {
      if (!keep[i]) continue;
      const a = pick(i);
      if (a === null) { skipped++; continue; }
      if (a > 0) { count++; sum += a; if (bad[i] === 1) { badN++; badAmt += a; } }
      else { zeroN++; if (bad[i] === 1) zeroBad++; }
    }
    return {
      count, sum, ticket: count ? sum / count : null, badN, badRate: count ? badN / count : null,
      badAmt, badAmtRate: sum ? badAmt / sum : null, zeroN, zeroBad, zeroRate: zeroN ? zeroBad / zeroN : null, skipped,
    };
  }
  const strategyPick = (res) => (i) => (res.status[i] === ST_OK ? res.final[i] : res.status[i] === ST_REJECT ? 0 : null);

  // rate: 연 금리(소수, 기본 0.2). 수익 = 금액 합 × (금리 − 불량률(금액)). 증가율 = 첫 줄 대비
  function summaryRows(ctx, keep, rate, extra) {
    const list = [];
    if (ctx.amt) list.push(Object.assign({ key: 'asis', name: 'AS-IS(실적)' }, tally(ctx, keep, (i) => ctx.amt[i])));
    list.push(Object.assign({ key: 'orig', name: '원래 전략' }, tally(ctx, keep, strategyPick(ctx.orig))));
    if (ctx.changed) list.push(Object.assign({ key: 'changed', name: '바꾼 전략' }, tally(ctx, keep, strategyPick(ctx.changed))));
    for (const e of extra || []) list.push(Object.assign({ key: e.key, name: e.name }, tally(ctx, keep, strategyPick(e.res))));
    withProfit(list, rate);
    return list;
  }
  function withProfit(list, rate) {
    for (const r of list) r.profit = r.badAmtRate === null ? null : r.sum * (rate - r.badAmtRate);
    const f = list[0];
    list.forEach((r, k) => {
      r.sumGrowth = k === 0 || !f.sum ? null : r.sum / f.sum - 1;
      r.profitGrowth = k === 0 || f.profit === null || !f.profit || r.profit === null ? null : (r.profit - f.profit) / Math.abs(f.profit);
    });
    return list;
  }

  // ── ③ 단계·CAP 조합 ─────────────────────────────────────────────────────
  // 비교 항목의 이름(엔진이 결정요인으로 쓰는 이름과 같다)
  function itemLabel(strategy, ref) {
    if (!ref) return '';
    const vars = new Map(strategy.variables.map(v => [v.id, v])), nodes = new Map(strategy.nodes.map(x => [x.id, x]));
    if (ref.k === 'in') return E.IN_NAME;
    if (ref.k === 'part') {
      const x = nodes.get(ref.id) || vars.get(ref.id) || {};
      const label = (E.partsOf(x).find(p => p[0] === ref.part) || [, ref.part])[1];
      return `${x.name || '(삭제됨)'}${E.PART_SEP}${label}`;
    }
    if (ref.k === 'var') return (vars.get(ref.id) || {}).name || '(삭제됨)';
    if (ref.k === 'node') return (nodes.get(ref.id) || {}).name || '(삭제됨)';
    return E.fmtNum(ref.v);
  }

  // 조합의 기준이 될 수 있는 최소(min) 단계들: 최종 단계로 이어지는 것, 계산 순서대로. 기본 = 마지막
  function minStepCandidates(strategy) {
    const prep = E.prepare(strategy);
    const fid = E.finalNodeId(strategy);
    if (!fid || prep.cycle.length) return [];
    const anc = new Set([fid]), stack = [fid];
    while (stack.length) { const x = stack.pop(); for (const d of prep.deps.get(x) || []) if (!anc.has(d)) { anc.add(d); stack.push(d); } }
    const nodes = new Map(strategy.nodes.map(x => [x.id, x]));
    return prep.ord.filter(id => anc.has(id)).map(id => nodes.get(id))
      .filter(x => x.type === 'minmax' && (x.config || {}).mode !== 'max' && ((x.config || {}).items || []).length)
      .map(x => ({ id: x.id, name: x.name, items: x.config.items.map(r => itemLabel(strategy, r)) }));
  }

  // 기본 조합: 기초만 / 기초 + CAP 하나씩 / 전부 — 최대 8행(마지막은 늘 전부). 각 행 = 남길 항목 번호 목록
  function defaultCombos(itemCount, baseIdx, maxRows) {
    maxRows = maxRows || 8;
    const all = Array.from({ length: itemCount }, (_, k) => k);
    if (itemCount <= 1) return [all];
    const out = [[baseIdx]];
    for (const k of all) if (k !== baseIdx && out.length < maxRows - 1) out.push([baseIdx, k].sort((a, b) => a - b));
    out.push(all);
    return out;
  }

  // 그 단계의 비교 항목을 고른 것만 남긴 전략 사본(원본은 그대로)
  function comboStrategy(strategy, nodeId, keepIdx) {
    const copy = JSON.parse(JSON.stringify(strategy));
    const node = copy.nodes.find(x => x.id === nodeId);
    node.config.items = keepIdx.map(k => node.config.items[k]);
    return copy;
  }

  const sameKeep = (a, b) => a.length === b.length && a.every((v, k) => v === b[k]);

  // ── ④ 한도 구간 × 결정요인 ──────────────────────────────────────────────
  // 경계 정리: 숫자만, 작은 것부터, 같은 값은 합침
  function normalizeEdges(arr) {
    return [...new Set((arr || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  }
  // 값이 속한 구간 번호: -1 = 첫 경계 미만, j = [edges[j], edges[j+1]) , 마지막은 이상
  function binIndex(v, edges) {
    if (v < edges[0]) return -1;
    let j = edges.length - 1;
    while (j > 0 && v < edges[j]) j--;
    return j;
  }

  // 기본 한도 구간 경계: 0원은 따로, 나머지는 구간이 12개 이하가 되는 단위(100만·200만·500만·1,000만…)
  function limitEdges(ctx, keep, res) {
    let max = 0;
    for (let i = 0; i < ctx.n; i++) if (keep[i] && res.status[i] === ST_OK && res.final[i] > max) max = res.final[i];
    if (max <= 0) return [0];
    const units = [];
    for (let e = 6; e <= 12; e++) units.push(1 * 10 ** e, 2 * 10 ** e, 5 * 10 ** e);
    const unit = units.find(u => Math.floor(max / u) + 1 <= 12) || units[units.length - 1];
    const out = [];
    for (let v = 0; v <= max; v += unit) out.push(v);
    return out;
  }

  // 반환: {labels(열 이름), rows:[{kind, lo, hi, cells:[{n, bad}], total:{n, bad}}], total:{cells, total}}
  //   열 = 라벨(거절 사유·결정요인) 건수 많은 순 최대 topN개 + 기타. 거절 행은 거절 사유가 같은 열에 들어간다
  function limitMatrix(ctx, keep, res, edges, topN) {
    topN = topN || 8;
    edges = normalizeEdges(edges);
    if (!edges.length) edges = [0];
    const cnt = new Map();
    let target = 0;
    for (let i = 0; i < ctx.n; i++) {
      if (!keep[i]) continue;
      const st = res.status[i];
      if (st !== ST_OK && st !== ST_REJECT) continue;
      target++;
      cnt.set(res.det[i], (cnt.get(res.det[i]) || 0) + 1);
    }
    const order = [...cnt.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(x => x[0]);
    const top = order.slice(0, topN);
    const colOf = new Map(top.map((k, c) => [k, c]));
    const hasOther = order.length > topN;
    const nc = top.length + (hasOther ? 1 : 0);
    const names = top.map(k => res.labels[k] || '—');
    if (hasOther) names.push('기타');
    const mk = () => ({ cells: Array.from({ length: nc }, () => ({ n: 0, bad: 0 })), total: { n: 0, bad: 0 } });
    const rows = [{ kind: 'reject', name: '거절', lo: null, hi: null, ...mk() }, { kind: 'zero', name: '0원', lo: null, hi: null, ...mk() }];
    const under = { kind: 'under', name: '', lo: null, hi: edges[0], ...mk() };
    const bins = edges.map((e, j) => ({ kind: 'bin', name: '', lo: e, hi: j + 1 < edges.length ? edges[j + 1] : null, ...mk() }));
    const all = { kind: 'all', name: '전체', lo: null, hi: null, ...mk() };
    const put = (row, c, isBad) => { const cell = row.cells[c]; cell.n++; row.total.n++; if (isBad) { cell.bad++; row.total.bad++; } };
    for (let i = 0; i < ctx.n; i++) {
      if (!keep[i]) continue;
      const st = res.status[i];
      if (st !== ST_OK && st !== ST_REJECT) continue;
      const c = colOf.has(res.det[i]) ? colOf.get(res.det[i]) : nc - 1;
      const isBad = ctx.bad[i] === 1;
      let row;
      if (st === ST_REJECT) row = rows[0];
      else if (!(res.final[i] > 0)) row = rows[1];
      else { const j = binIndex(res.final[i], edges); row = j < 0 ? under : bins[j]; }
      put(row, c, isBad);
      put(all, c, isBad);
    }
    const out = rows.concat(under.total.n ? [under] : [], bins, [all]);
    return { names, rows: out, target };
  }

  // ── ⑤ 변수 구간별 분석 ──────────────────────────────────────────────────
  // 10분위수 기본 경계: 최솟값부터 10%씩(최대 10구간). 경계가 실제 행 값 그대로 화면·집계 파일에 실리지 않게
  // 유효숫자 2자리로 반올림하고(3,512,345 → 3,500,000) 같아진 경계는 합친다. 사용자가 직접 고친 경계는 그대로 둔다
  const round2 = (v) => (v === 0 ? 0 : Number(v.toPrecision(2)));
  function decileEdges(values) {
    const m = values.length;
    if (!m) return [];
    const sorted = Float64Array.from(values).sort();
    const out = [];
    for (let p = 0; p < 10; p++) out.push(round2(sorted[Math.min(m - 1, Math.floor(p * m / 10))]));
    return normalizeEdges(out);
  }

  const fmtEdge = (v) => E.fmtNum(v, 6);
  function rangeLabel(edges, j, fmt) {
    fmt = fmt || fmtEdge;
    if (j < 0) return `${fmt(edges[0])} 미만`;
    return j + 1 < edges.length ? `${fmt(edges[j])} 이상 ~ ${fmt(edges[j + 1])} 미만` : `${fmt(edges[j])} 이상`;
  }

  // 누적·KS를 채운다. rows: [{n, bad}] 순서대로 쌓는다
  function cumulate(binRows, target) {
    let totBad = 0, totGood = 0;
    for (const r of binRows) { totBad += r.bad; totGood += r.n - r.bad; }
    let cb = 0, cg = 0, maxKs = null;
    for (const r of binRows) {
      r.good = r.n - r.bad;
      cb += r.bad; cg += r.good;
      r.cumBad = cb; r.cumGood = cg;
      r.cumBadRate = totBad ? cb / totBad : null;
      r.cumGoodRate = totGood ? cg / totGood : null;
      r.ks = r.cumBadRate === null || r.cumGoodRate === null ? null : Math.abs(r.cumBadRate - r.cumGoodRate);
      if (r.ks !== null && (maxKs === null || r.ks > maxKs)) maxKs = r.ks;
      r.share = target ? r.n / target : null;
      r.badRate = r.n ? r.bad / r.n : null;
    }
    return maxKs;
  }

  const MIN_CAT = 5;          // 5건 미만 범주는 "기타"
  const MAX_CAT_UNIQUE = 50;  // 범주 분석은 고유값 50개 이하
  const MAX_CAT_SHARE = 0.05; // 이면서 분석 대상 건수의 5% 이하

  // col: 열 번호. opt.edges: 사용자가 고친 경계(숫자 열). 반환 {kind, rows, ks, edges, target, unique}
  //   kind: numeric · category · blocked(값 종류가 너무 많음) · empty(값이 없음)
  function varTable(ctx, keep, col, opt) {
    opt = opt || {};
    const info = colInfo(ctx, col);
    let target = 0, blank = 0, numeric = 0, other = 0, bad = 0, good = 0;
    const blankRow = { type: 'blank', label: '빈 값', n: 0, bad: 0 }, otherRow = { type: 'other', label: '숫자 아님', n: 0, bad: 0 };
    for (let i = 0; i < ctx.n; i++) {
      if (!keep[i]) continue;
      target++;
      const isBad = ctx.bad[i] === 1;
      if (isBad) bad++; else good++;
      const st = info.state[i];
      if (st === 0) { blank++; blankRow.n++; if (isBad) blankRow.bad++; }
      else if (st === 1) numeric++;
      else { other++; otherRow.n++; if (isBad) otherRow.bad++; }
    }
    const nonblank = numeric + other;
    const finish = (kind, binRows, ks, extra) => {
      const rows = binRows.slice();
      const tail = [];
      for (const r of [blankRow, otherRow]) {
        if (r.type === 'other' && kind !== 'numeric') continue;
        r.good = r.n - r.bad; r.share = target ? r.n / target : null; r.badRate = r.n ? r.bad / r.n : null;
        tail.push(r);
      }
      const total = { type: 'total', label: '전체', n: target, bad, good, share: target ? 1 : null, badRate: target ? bad / target : null, ks };
      return Object.assign({ kind, rows: rows.concat(tail, [total]), ks, target }, extra);
    };
    if (nonblank === 0) return finish('empty', [], null, {});

    if (numeric / nonblank >= 0.95) {
      const vals = [];
      for (let i = 0; i < ctx.n; i++) if (keep[i] && info.state[i] === 1) vals.push(info.num[i]);
      let edges = opt.edges ? normalizeEdges(opt.edges) : [];
      const isDefault = !edges.length;
      if (isDefault) edges = decileEdges(vals);
      const bins = [], under = { type: 'bin', j: -1, n: 0, bad: 0 };
      edges.forEach((e, j) => bins.push({ type: 'bin', j, n: 0, bad: 0 }));
      for (let i = 0; i < ctx.n; i++) {
        if (!keep[i] || info.state[i] !== 1) continue;
        const j = binIndex(info.num[i], edges);
        const r = j < 0 ? under : bins[j];
        r.n++; if (ctx.bad[i] === 1) r.bad++;
      }
      const list = (under.n ? [under] : []).concat(bins);
      const ks = cumulate(list, target);
      for (const r of list) {
        r.label = rangeLabel(edges, r.j);
        r.lo = r.j < 0 ? null : edges[r.j];
        r.hi = r.j < 0 ? edges[0] : (r.j + 1 < edges.length ? edges[r.j + 1] : null);
      }
      return finish('numeric', list, ks, { edges, isDefault });
    }

    // 범주형: 값마다 한 행. 고유값이 너무 많으면(이름·번호 열일 수 있음) 값을 싣지 않는다
    const cats = new Map();
    for (let i = 0; i < ctx.n; i++) {
      if (!keep[i] || info.state[i] === 0) continue;
      const key = String(ctx.rows[i][col]).trim();
      let c = cats.get(key);
      if (!c) { c = { n: 0, bad: 0 }; cats.set(key, c); }
      c.n++; if (ctx.bad[i] === 1) c.bad++;
    }
    const unique = cats.size;
    if (unique > MAX_CAT_UNIQUE || unique > target * MAX_CAT_SHARE) return finish('blocked', [], null, { unique });
    const list = [];
    let etc = { type: 'bin', label: '기타', n: 0, bad: 0, etc: true };
    for (const [key, c] of cats) {
      if (c.n < MIN_CAT) { etc.n += c.n; etc.bad += c.bad; } else list.push({ type: 'bin', label: key, n: c.n, bad: c.bad });
    }
    list.sort((a, b) => (b.bad / b.n) - (a.bad / a.n) || b.n - a.n || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    if (etc.n) list.push(etc);
    const ks = cumulate(list, target);
    return finish('category', list, ks, { unique });
  }

  return {
    MAX_ROWS, MIN_CAT, MAX_CAT_UNIQUE, MAX_CAT_SHARE, COND_OPS, NO_VALUE_OPS, ST_OK, ST_REJECT, ST_ERROR, ST_INPUT,
    isBlank, toNumber, badValue, createPasteParser, parsePaste, fromAoa, overMessage, MSG_RANGE, MSG_NO_TAB, MSG_NO_ROWS, MSG_EMPTY,
    findHeader, autoBadCol, autoAmtCol, createRunner, makeContext, colInfo, condTest, condText, selection,
    tally, strategyPick, summaryRows, withProfit, itemLabel, minStepCandidates, defaultCombos, comboStrategy, sameKeep,
    normalizeEdges, binIndex, limitEdges, limitMatrix, decileEdges, rangeLabel, cumulate, varTable,
  };
});
