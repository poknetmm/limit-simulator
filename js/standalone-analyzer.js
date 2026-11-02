/* ============================================================================
   대량 분석기 — 내려받은 단독 HTML 파일 안에서 도는 화면 스크립트
   ----------------------------------------------------------------------------
   · 이 파일은 스튜디오 화면(index.html)에서 부르지 않는다. 내려받기 때 글로 읽어 파일 안에 넣는다(htmlexport.js)
   · 흐름: 데이터 넣기(붙여넣기·엑셀) → 열 맞춤 → 계산 → 리포트 ①~⑤ → 전략값 고치기(바꾼 전략)
   · 데이터는 페이지 변수에만 있다. 네트워크·저장소를 쓰지 않고, 글자는 모두 textContent로만 그린다(innerHTML 없음)
   · 엔진·입력 오류 문장은 화면·파일에 싣지 않는다. 오류는 열별 건수만 보인다
   ========================================================================== */
(function (root) {
  'use strict';
  const E = root.LimitEngine, A = root.Analysis, XL = root.XLSX;
  const doc = root.document;
  const strategy = JSON.parse(doc.getElementById('strategy').textContent);
  const cols = E.inputColumns(strategy);
  const $ = (id) => doc.getElementById(id);

  // ── DOM 도우미 ──────────────────────────────────────────────────────────
  function h(tag, props, ...kids) {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    const add = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.appendChild(c instanceof root.Node ? c : doc.createTextNode(String(c)));
    };
    kids.forEach(add);
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const NO_CHECK = { spellcheck: 'false', autocomplete: 'off' };
  const nf = (v) => Number(v).toLocaleString('ko-KR');
  const yieldUI = () => new Promise((res) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); res(); }; ch.port2.postMessage(0); });
  const nowMs = () => root.performance.now();
  // 오래 걸리는 동기 작업(엑셀 읽기·쓰기) 앞에서 안내 글이 먼저 그려지게 한다. 백그라운드 탭에서는 프레임이 멈추므로 80ms 뒤에는 그냥 진행한다
  const paint = () => new Promise((res) => { let done = false; const f = () => { if (!done) { done = true; res(); } }; root.requestAnimationFrame(() => root.setTimeout(f, 0)); root.setTimeout(f, 80); });

  const btn = (label, onclick, cls, attrs) => h('button', Object.assign({ type: 'button', class: `sa-btn${cls ? ` ${cls}` : ''}`, onclick }, attrs), label);
  function select(opts, value, onchange, attrs) {
    const el = h('select', Object.assign({ class: 'sa-in' }, NO_CHECK, attrs), opts.map(o => h('option', { value: String(o.v) }, o.t)));
    el.value = String(value);
    if (onchange) el.addEventListener('change', () => onchange(el.value));
    return el;
  }
  function textIn(value, onchange, attrs) {
    const el = h('input', Object.assign({ type: 'text', class: 'sa-in' }, NO_CHECK, attrs));
    el.value = value;
    if (onchange) el.addEventListener('change', () => onchange(el.value));
    return el;
  }

  // ── 상태 ────────────────────────────────────────────────────────────────
  const S = {
    data: null,            // {headers, rows, source}
    map: {}, badCol: -1, amtCol: -1,
    units: {}, amtUnit: 1,      // 금액 열 단위(배수) — 없으면 원
    orig: null, changed: null, changedInfo: null,
    ctx: null, sel: null,
    conds: [], rate: 20,
    p3: { cands: [], nodeId: null, base: 0, rows: [], results: new Map() },
    p4: { target: 'orig', view: 'share', edges: null },
    p5: [], p5seq: 0,
    busy: false, stop: false, seq: 0,
    notes: [], runNotes: [],
  };

  // ── 알림 ────────────────────────────────────────────────────────────────
  function flash(text, kind) {
    const box = $('anNotice');
    clear(box);
    box.className = `an-notice an-${kind || 'info'}`;
    for (const t of Array.isArray(text) ? text : [text]) box.appendChild(h('div', {}, t));
    box.hidden = false;
  }
  function setProgress(t) { $('anProgress').textContent = t; }

  // ── 표 모델 → 화면 ──────────────────────────────────────────────────────
  // 칸: {v, t} — t: n 건수 · m 금액 · p 비율 · s 글자
  const C = (v, t) => ({ v, t });
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  function cellText(c) {
    if (c.v === null || c.v === undefined || (typeof c.v === 'number' && !Number.isFinite(c.v))) return '—';
    switch (c.t) {
      case 'n': return nf(c.v);
      case 'm': return E.fmtNum(c.v, 0);
      case 'p': return `${(c.v * 100).toFixed(2)}%`;
      default: return String(c.v);
    }
  }
  function tableEl(model, key) {
    const head = h('tr', {}, model.head.map(t => h('th', {}, t)));
    const body = model.rows.map(r => h('tr', { class: r.cls || '' }, r.cells.map(c => h('td', {
      class: c.t === 's' ? '' : 'sa-r', 'data-raw': c.t !== 's' && finite(c.v) ? String(c.v) : null,
    }, cellText(c)))));
    return h('div', { class: 'sa-scroll' }, h('table', { class: 'sa-tbl an-tbl', 'data-tbl': key }, h('thead', {}, head), h('tbody', {}, body)));
  }

  function moneyEdge(v) {
    if (v === 0) return '0원';
    if (v % 1e8 === 0) return `${E.fmtNum(v / 1e8)}억`;
    if (v >= 1e4 && v % 1e4 === 0) return `${E.fmtNum(v / 1e4)}만`;
    return `${E.fmtNum(v)}원`;
  }

  // ── 모델 ① ──────────────────────────────────────────────────────────────
  function model1() {
    const n0 = S.sel.total;
    const rows = S.sel.steps.map(s => ({
      cls: s.kind === 'start' ? 'an-strong' : '',
      cells: [C(s.name, 's'), C(s.cond, 's'), C(s.before, 'n'),
        C(s.excl, 'n'), C(s.exclBad, 'n'), C(s.excl === null ? null : (n0 ? s.excl / n0 : null), 'p'), C(s.excl ? s.exclBad / s.excl : null, 'p'),
        C(s.remain, 'n'), C(s.remainBad, 'n'), C(n0 ? s.remain / n0 : null, 'p'), C(s.remain ? s.remainBad / s.remain : null, 'p')],
    }));
    rows.push({
      cls: 'an-strong',
      cells: [C('분석 대상', 's'), C('', 's'), C(null, 'n'), C(null, 'n'), C(null, 'n'), C(null, 'p'), C(null, 'p'),
        C(S.sel.target, 'n'), C(S.sel.targetBad, 'n'), C(n0 ? S.sel.target / n0 : null, 'p'), C(S.sel.target ? S.sel.targetBad / S.sel.target : null, 'p')],
    });
    return { head: ['방법', '조건', '기존 건수', '제외 건수', '제외 불량건', '제외 비중', '제외 불량률', '잔존 건수', '잔존 불량건', '잔존 비중', '잔존 불량률'], rows };
  }

  // ── 모델 ② · ③ ──────────────────────────────────────────────────────────
  const SUM_HEAD = ['건수', '금액 합(원)', '금액 증가율', '티켓 크기(원)', '불량건', '불량률(건)', '불량금액/불량한도(원)', '불량률(금액)', '수익(원)', '수익 증가율', '0원·거절 건', '그중 불량건', '그 불량률'];
  const sumCells = (r) => [C(r.count, 'n'), C(r.sum, 'm'), C(r.sumGrowth, 'p'), C(r.ticket, 'm'), C(r.badN, 'n'), C(r.badRate, 'p'), C(r.badAmt, 'm'), C(r.badAmtRate, 'p'),
    C(r.profit, 'm'), C(r.profitGrowth, 'p'), C(r.zeroN, 'n'), C(r.zeroBad, 'n'), C(r.zeroRate, 'p')];
  const summaryList = () => A.summaryRows(S.ctx, S.sel.keep, S.rate / 100);
  function model2(list) {
    return { head: ['구분', ...SUM_HEAD], rows: list.map(r => ({ cells: [C(r.name, 's'), ...sumCells(r)] })) };
  }

  const targetRun = () => S.changed || S.orig;
  const targetStrategy = () => (S.changedInfo ? S.changedInfo.strategy : strategy);
  const targetId = () => (S.changedInfo ? `changed${S.changedInfo.seq}` : 'orig');
  const comboKey = (keep) => `${targetId()}|${S.p3.nodeId}|${keep.join(',')}`;
  const candOf = () => S.p3.cands.find(c => c.id === S.p3.nodeId);
  const isFull = (keep) => keep.length === candOf().items.length;
  function comboName(keep) {
    const items = candOf().items;
    if (isFull(keep)) return '전부';
    if (keep.length === 1 && keep[0] === S.p3.base) return '기초만';
    return `기초 + ${keep.filter(k => k !== S.p3.base).map(k => items[k]).join(' + ')}`;
  }
  function comboRes(keep) { return isFull(keep) ? targetRun() : S.p3.results.get(comboKey(keep)) || null; }

  function model3() {
    const items = candOf().items;
    const defs = S.p3.rows.map(r => ({ keep: r.keep, name: comboName(r.keep), res: comboRes(r.keep) }));
    const tallies = defs.map(d => (d.res ? Object.assign({ name: d.name }, A.tally(S.ctx, S.sel.keep, A.strategyPick(d.res))) : null));
    A.withProfit(tallies.filter(Boolean), S.rate / 100);
    return {
      head: ['조합', ...items, ...SUM_HEAD],
      rows: defs.map((d, k) => ({
        cells: [C(d.name, 's'), ...items.map((_, j) => C(d.keep.includes(j) ? 'V' : '', 's')),
          ...(tallies[k] ? sumCells(tallies[k]) : SUM_HEAD.map(() => C(null, 'n')))],
      })),
    };
  }

  // ── 모델 ④ ──────────────────────────────────────────────────────────────
  const VIEWS = [['share', '비중'], ['badrate', '불량률'], ['count', '건수'], ['bad', '불량건']];
  function runOf(which) { return which === 'changed' ? S.changed : S.orig; }
  function matrixFor(which) { return A.limitMatrix(S.ctx, S.sel.keep, runOf(which), S.p4.edges || A.limitEdges(S.ctx, S.sel.keep, S.orig)); }
  function model4(view, which) {
    const m = matrixFor(which);
    const val = (cell, tgt) => {
      switch (view) {
        case 'share': return C(tgt ? cell.n / tgt : null, 'p');
        case 'badrate': return C(cell.n ? cell.bad / cell.n : null, 'p');
        case 'count': return C(cell.n, 'n');
        default: return C(cell.bad, 'n');
      }
    };
    const label = (r) => {
      if (r.kind === 'under') return `${moneyEdge(r.hi)} 미만`;
      if (r.kind === 'bin') return r.hi === null ? `${moneyEdge(r.lo)} 이상` : `${moneyEdge(r.lo)} 이상 ~ ${moneyEdge(r.hi)} 미만`;
      return r.name;
    };
    return {
      head: ['한도 구간', ...m.names, '전체'],
      rows: m.rows.map(r => ({ cls: r.kind === 'all' ? 'an-strong' : '', cells: [C(label(r), 's'), ...r.cells.map(c => val(c, m.target)), val(r.total, m.target)] })),
      target: m.target,
    };
  }

  // ── 모델 ⑤ ──────────────────────────────────────────────────────────────
  const VAR_HEAD = ['건수', '불량건수', '우량건수', '누적 불량건수', '누적 불량률', '누적 우량건수', '누적 우량률', '비중', '불량률', 'KS'];
  function model5(vt, colName) {
    const rows = vt.rows.map(r => ({
      cls: r.type === 'total' ? 'an-strong' : '',
      cells: [C(r.label, 's'), C(r.n, 'n'), C(r.bad, 'n'), C(r.good, 'n'),
        C(r.type === 'bin' ? r.cumBad : null, 'n'), C(r.type === 'bin' ? r.cumBadRate : null, 'p'), C(r.type === 'bin' ? r.cumGood : null, 'n'), C(r.type === 'bin' ? r.cumGoodRate : null, 'p'),
        C(r.share, 'p'), C(r.badRate, 'p'), C(r.type === 'bin' ? r.ks : r.type === 'total' ? vt.ks : null, 'p')],
    }));
    return { head: [vt.kind === 'category' ? '값' : '범위', ...VAR_HEAD], rows, title: colName };
  }

  // ── 구간 경계 편집기 ────────────────────────────────────────────────────
  // edges: 숫자 목록. onChange(새 목록) — 칸을 고치고 나올 때(change)만 부른다
  function edgeEditor(edges, onChange, onDefault, unit) {
    const box = h('div', { class: 'an-edges' });
    const show = (v) => E.fmtNum(v, 6);
    edges.forEach((e, k) => {
      const inp = textIn(show(e), (txt) => {
        const v = A.toNumber(txt);
        if (v === null) { inp.value = show(e); return; }
        const next = edges.slice(); next[k] = v; onChange(A.normalizeEdges(next));
      }, { 'aria-label': `경계 ${k + 1}`, class: 'sa-in sa-num an-edge' });
      box.appendChild(h('span', { class: 'an-edge-item' }, inp, edges.length > 1 ? btn('삭제', () => onChange(edges.filter((_, j) => j !== k)), 'sa-mini') : null));
    });
    const add = textIn('', null, { placeholder: '경계 값', 'aria-label': '경계 추가', class: 'sa-in sa-num an-edge' });
    box.appendChild(h('span', { class: 'an-edge-item' }, add, btn('경계 추가', () => {
      const v = A.toNumber(add.value);
      if (v === null) { add.value = ''; return; }
      onChange(A.normalizeEdges([...edges, v]));
    }, 'sa-mini'), onDefault ? btn('기본 경계로', onDefault, 'sa-mini') : null));
    box.appendChild(h('div', { class: 'sa-note' }, `구간은 아래 경계 이상 · 위 경계 미만, 마지막은 이상${unit ? ` (${unit})` : ''}`));
    return box;
  }

  // ── 데이터 넣기 ─────────────────────────────────────────────────────────
  // 리포트 영역의 표·편집기를 모두 비운다(결과를 지우면 화면에도 수치가 남지 않게)
  function clearReportDom() {
    for (const id of ['anCondHost', 'anRateHost', 'anT1', 'anT2', 'anN2', 'anC3', 'anN3', 'anT3', 'anC4', 'anT4', 'anC5', 'anT5']) { const el = $(id); if (el) clear(el); }
  }

  function resetResults() {
    clearReportDom();
    S.orig = null; S.changed = null; S.changedInfo = null; S.ctx = null; S.sel = null;
    S.p3.results = new Map(); S.p3.cands = []; S.p3.rows = []; S.p3.nodeId = null;
    S.p4.edges = null; S.p4.target = 'orig'; S.p5 = []; S.runNotes = [];
    setProgress('');
  }

  function loadData(res, source) {
    if (!res.ok) { flash(res.message, 'danger'); return false; }
    resetResults();
    S.conds = [];
    S.data = { headers: res.headers, rows: res.rows, source };
    S.map = E.autoMap(cols, res.headers);
    S.badCol = A.autoBadCol(res.headers);
    S.amtCol = A.autoAmtCol(res.headers);
    S.units = {}; S.amtUnit = 1;
    const notes = [`${source}로 ${nf(res.rows.length)}건 × ${nf(res.headers.length)}열을 읽었습니다. 이 PC 브라우저 메모리에만 있고 저장하지 않습니다.`];
    if (res.short) notes.push(`칸 수가 제목줄보다 적은 줄 ${nf(res.short)}건은 모자란 칸을 빈 칸으로 채웠습니다.`);
    if (res.long) notes.push(`칸 수가 제목줄보다 많은 줄 ${nf(res.long)}건은 남는 칸을 버렸습니다.`);
    flash(notes, res.short || res.long ? 'warn' : 'ok');
    renderData(); renderMap(); renderRun(); renderReport(); renderEditState();
    return true;
  }

  function clearData() {
    if (S.busy) { S.stop = true; }
    S.data = null; S.map = {}; S.badCol = -1; S.amtCol = -1; S.units = {}; S.amtUnit = 1; S.conds = [];
    resetResults();
    const f = $('anFile'); if (f) f.value = '';
    renderData(); renderMap(); renderRun(); renderReport(); renderEditState();
    flash('입력한 데이터와 계산 결과·리포트를 모두 지웠습니다.', 'info');
  }

  async function startPaste(text) {
    if (S.busy) { flash('계산 중에는 새 데이터를 넣을 수 없습니다 — 멈춘 뒤 다시 하세요', 'warn'); return; }
    if (!String(text || '').trim()) { flash(A.MSG_EMPTY, 'danger'); return; }
    S.busy = true; renderRun();
    try {
      const p = A.createPasteParser(text);
      while (!p.step(40)) { setProgress(`붙여 넣은 글을 읽는 중… ${Math.round(100 * p.pos / p.length)}%`); await yieldUI(); }
      setProgress('');
      loadData(p.result(), '붙여넣기');
    } finally { S.busy = false; renderRun(); }
  }

  async function openFile(file) {
    if (S.busy) { flash('계산 중에는 새 데이터를 넣을 수 없습니다 — 멈춘 뒤 다시 하세요', 'warn'); return; }
    if (!/\.xlsx$/i.test(file.name)) { flash('.xlsx 파일만 올릴 수 있습니다 — .xls·.csv는 엑셀에서 .xlsx로 저장하거나, 범위를 복사해 붙여 넣으세요', 'danger'); return; }
    S.busy = true; renderRun();
    try {
      setProgress('엑셀 파일을 읽는 중… (건수가 많으면 몇 초 걸리며 그동안 화면이 멈춥니다)');
      await paint();
      let aoa, hint = 0, truncated = false;
      try {
        const buf = await file.arrayBuffer();
        const wb = XL.read(new Uint8Array(buf), { type: 'array', sheetRows: A.MAX_ROWS + 2, cellFormula: false, cellHTML: false, cellStyles: false });
        const ws = wb.Sheets[wb.SheetNames[0]];
        if (!ws) throw new Error('empty');
        if (ws['!fullref']) { hint = XL.utils.decode_range(ws['!fullref']).e.r; truncated = hint >= A.MAX_ROWS + 2; }
        aoa = XL.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
      } catch (e) {
        setProgress('');
        flash('엑셀 파일을 읽지 못했습니다 — 회사 문서 보안으로 암호화된 파일이면 읽을 수 없습니다. 엑셀에서 제목줄을 포함해 범위를 복사한 뒤 붙여 넣으세요', 'danger');
        return;
      }
      setProgress('');
      const res = A.fromAoa(aoa, { totalHint: hint });
      // 읽기가 잘렸는데(시트 범위가 상한을 넘음) 읽은 건수는 상한 이하면 — 빈 줄이 섞여 뒤쪽을 못 읽은 것이므로 앞부분만 받지 않는다
      if (truncated && !(res.ok === false && res.total > A.MAX_ROWS)) { flash(A.MSG_RANGE, 'danger'); return; }
      loadData(res, '엑셀 올리기');
    } finally { S.busy = false; renderRun(); }
  }

  // ── 열 맞춤 ─────────────────────────────────────────────────────────────
  function headerOpts(noneText) {
    return [{ v: -1, t: noneText }].concat(S.data.headers.map((x, i) => ({ v: i, t: x || `(제목 없음 ${i + 1})` })));
  }

  function onMapChange() {
    // 전략 입력 열을 바꾸면 행별 결과가 달라지므로 계산 결과를 지운다
    if (S.orig) { resetResults(); renderRun(); renderReport(); renderEditState(); flash('열 맞춤이 바뀌어 계산 결과를 지웠습니다 — 다시 계산하세요.', 'info'); }
    else renderRun();
  }
  function onCol2Change() {
    if (S.orig && S.badCol < 0) { resetResults(); renderReport(); renderEditState(); flash('부실 여부 열을 비워 계산 결과를 지웠습니다 — 열을 고르고 다시 계산하세요.', 'info'); return; }
    if (S.orig) { rebuildCtx(); refreshTables(); }
    renderRun();
  }

  function renderMap() {
    const sec = $('anSecMap');
    const prevBox = $('anMapBody').querySelector('details.an-mapbox');
    const wasOpen = !!(prevBox && prevBox.open);      // 단위를 바꿔 다시 그려도 펼친 표를 닫지 않는다
    clear($('anMapBody'));
    sec.hidden = !S.data;
    if (!S.data) return;
    const body = $('anMapBody');
    const miss = cols.filter(c => !(S.map[c.key] >= 0));
    body.appendChild(h('div', { class: 'sa-note' }, '제목이 변수 이름과 같으면 자동으로 맞춥니다. 없는 열은 잔액 0·그 밖 전략의 기본값으로 계산합니다. 천 원 단위 표시처럼 화면 형식이 값과 다르면 일반 숫자 형식으로 바꿔 복사하세요.'));
    const moneyCols = cols.filter(c => c.type === 'money');
    const unitOf = (c) => S.units[c.key] || 1;
    const allUnits = new Set(moneyCols.map(unitOf).concat(S.amtUnit));
    const unitOpts = A.UNITS.map(u => ({ v: u.v, t: u.t }));
    const key = h('div', { class: 'an-keycols' },
      h('label', {}, h('span', { class: 'an-lbl' }, '금액 열 단위 (전체 한 번에)'),
        select((allUnits.size > 1 ? [{ v: 0, t: '(열마다 다름)' }] : []).concat(unitOpts), allUnits.size > 1 ? 0 : [...allUnits][0],
          (v) => { const u = Number(v); if (!(u > 0)) return; moneyCols.forEach(c => { S.units[c.key] = u; }); S.amtUnit = u; onMapChange(); renderMap(); }, { id: 'anUnitAll', 'aria-label': '금액 열 단위 전체' })),
      h('label', {}, h('span', { class: 'an-lbl' }, '부실 여부 열 (필수)'),
        select(headerOpts('(고르세요)'), S.badCol, (v) => { S.badCol = Number(v); onCol2Change(); renderMap(); }, { id: 'anBadCol', 'aria-label': '부실 여부 열' })),
      h('label', {}, h('span', { class: 'an-lbl' }, '실행금액(기존 한도) 열 (선택)'),
        select(headerOpts('(없음 — AS-IS 줄을 만들지 않음)'), S.amtCol, (v) => { S.amtCol = Number(v); onCol2Change(); }, { id: 'anAmtCol', 'aria-label': '실행금액 열' })),
      h('label', {}, h('span', { class: 'an-lbl' }, '실행금액 단위'),
        select(unitOpts, S.amtUnit, (v) => { S.amtUnit = Number(v); onCol2Change(); renderMap(); }, { id: 'anAmtUnit', 'aria-label': '실행금액 단위' })));
    body.appendChild(key);
    body.appendChild(h('div', { class: 'sa-note' }, '단위는 계산과 AS-IS 금액에만 적용합니다. 리포트 금액은 원으로 나오고, 제외 조건·⑤ 구간·건별 결과의 원본 칸은 데이터에 적힌 값 그대로입니다.'));
    body.appendChild(h('div', { class: 'sa-note', id: 'anBadHint' }, 'AS-IS는 실행금액 열이 있을 때만 만듭니다. 불량은 Y·1·TRUE·예·O, 정상은 N·0·FALSE·아니오·X로 읽습니다(그 밖·빈 칸은 판정 불가).'));
    const rows = cols.map(c => h('tr', { class: S.map[c.key] >= 0 ? '' : 'an-unmapped' },
      h('td', {}, c.label), h('td', { class: 'sa-note' }, E.VAR_TYPES[c.type] || c.type),
      h('td', {}, select(headerOpts(c.debt ? '(없음 — 잔액 0)' : '(없음 — 기본값)'), S.map[c.key] >= 0 ? S.map[c.key] : -1,
        (v) => { S.map[c.key] = Number(v); onMapChange(); renderMap(); }, { 'data-map': c.key, 'aria-label': c.label })),
      h('td', {}, c.type === 'money'
        ? select(unitOpts, unitOf(c), (v) => { S.units[c.key] = Number(v); onMapChange(); renderMap(); }, { 'data-unit': c.key, 'aria-label': `${c.label} 단위` })
        : '—')));
    body.appendChild(h('details', { class: 'an-mapbox', open: wasOpen || (miss.length > 0 && miss.length < cols.length) ? true : null },
      h('summary', {}, miss.length ? `전략 입력 열 맞춤 — ${miss.length}개 열이 데이터에 없습니다(기본값으로 계산)` : '전략 입력 열 맞춤 — 모든 입력 열을 찾았습니다'),
      h('div', { class: 'sa-scroll' }, h('table', { class: 'sa-tbl' }, h('thead', {}, h('tr', {}, ['전략 입력', '형태', '데이터 열', '단위'].map(t => h('th', {}, t)))), h('tbody', {}, rows)))));
  }

  function renderData() {
    const info = $('anDataInfo'), prev = $('anPreview'), box = $('anPreviewBox');
    clear(info); clear(prev);
    box.hidden = !S.data;
    $('anClear').disabled = !S.data;
    if (!S.data) { info.textContent = '아직 넣은 데이터가 없습니다.'; return; }
    info.textContent = `${nf(S.data.rows.length)}건 · 열 ${nf(S.data.headers.length)}개 (${S.data.source})`;
    const cut = (v) => { const t = v === null || v === undefined ? '' : String(v); return t.length > 40 ? `${t.slice(0, 40)}…` : t; };
    prev.appendChild(h('thead', {}, h('tr', {}, S.data.headers.map(t => h('th', {}, cut(t))))));
    prev.appendChild(h('tbody', {}, S.data.rows.slice(0, 5).map(r => h('tr', {}, r.map(v => h('td', {}, cut(v)))))));
  }

  // ── 계산 ────────────────────────────────────────────────────────────────
  function renderRun() {
    const run = $('anRun'), stop = $('anStop');
    const need = !S.data ? '' : S.badCol < 0 ? '부실 여부 열을 고르면 계산할 수 있습니다' : '';
    run.disabled = !S.data || S.badCol < 0 || S.busy;
    stop.disabled = !S.busy;
    $('anRunHint').textContent = S.data && S.badCol < 0 ? need : '';
    $('anSecRun').hidden = !S.data;
    const rr = $('anRunNotes'); clear(rr);
    for (const t of S.runNotes) rr.appendChild(h('div', {}, t));
    $('anRerun').disabled = !S.orig || S.busy;
    const rb = $('anRowsBtn'); if (rb) rb.disabled = !S.orig || S.busy;
  }

  async function drive(runner, label) {
    while (!runner.step(40)) {
      setProgress(`${label}… ${nf(runner.index)} / ${nf(runner.total)}건 (${Math.floor(100 * runner.index / runner.total)}%)`);
      await yieldUI();
      if (S.stop) return false;
    }
    return !S.stop;
  }

  function rebuildCtx() {
    S.ctx = A.makeContext({ headers: S.data.headers, rows: S.data.rows, badCol: S.badCol, amtCol: S.amtCol, amtUnit: S.amtUnit, orig: S.orig, changed: S.changed });
  }

  async function calculate() {
    if (S.busy || !S.data || S.badCol < 0) return;
    S.busy = true; S.stop = false; renderRun();
    const t0 = nowMs();
    try {
      const watch = A.minStepCandidates(strategy).map(c => c.id);
      const runner = A.createRunner(strategy, cols, S.map, S.data.rows, { watch, units: S.units });
      const ok = await drive(runner, '원래 전략 계산 중');
      if (!ok) { setProgress(''); flash('계산을 멈췄습니다. 결과를 만들지 않았습니다.', 'warn'); return; }
      const keepP5 = S.p5;
      resetResults();
      S.p5 = keepP5;
      S.orig = runner.result();
      rebuildCtx();
      const secs = ((nowMs() - t0) / 1000).toFixed(1);
      const r = S.orig;
      S.runNotes = [`원래 전략 ${nf(r.n)}건을 ${secs}초에 계산했습니다.`];
      if (r.inputErrCols.length) S.runNotes.push(`입력 칸 형식 오류 — ${r.inputErrCols.map(([l, n]) => `${l} ${nf(n)}건`).join(' · ')} (오류 문장은 싣지 않고 건수만 보입니다)`);
      let nErr = 0; for (let i = 0; i < r.n; i++) if (r.status[i] === A.ST_ERROR) nErr++;
      if (nErr) S.runNotes.push(`계산 오류 ${nf(nErr)}건`);
      if (r.defaults) S.runNotes.push(`전략의 기본값을 쓴 칸이 있는 건 ${nf(r.defaults)}건 (데이터에 없거나 비어 있는 입력 칸)`);
      setProgress('');
      renderRun(); renderReport(); renderEditState();
      refreshAll(true);
    } finally { S.busy = false; S.stop = false; renderRun(); }
  }

  // ── 리포트 틀 ───────────────────────────────────────────────────────────
  function renderReport() {
    const rep = $('anReport');
    rep.hidden = !S.orig;
  }

  function mountReport() {
    const rep = $('anReport');
    const sec = (id, title, ...kids) => h('section', { class: 'an-sec', id }, h('h3', {}, title), ...kids);
    rep.append(
      sec('an1', '① 대상자 선정', h('div', { id: 'anCondHost' }), h('div', { id: 'anT1' })),
      sec('an2', '② AS-IS / TO-BE 요약', h('div', { id: 'anRateHost' }), h('div', { id: 'anT2' }), h('div', { id: 'anN2', class: 'an-notes' })),
      sec('an3', '③ 단계·CAP 조합별 상세', h('div', { id: 'anC3' }), h('div', { id: 'anN3', class: 'an-notes' }), h('div', { id: 'anT3' })),
      sec('an4', '④ 한도 구간 × 결정요인', h('div', { id: 'anC4' }), h('div', { id: 'anT4' })),
      sec('an5', '⑤ 변수 구간별 분석', h('div', { id: 'anC5' }), h('div', { id: 'anT5' })),
      h('section', { class: 'an-sec an-dl' }, h('h3', {}, '결과 내려받기'),
        h('div', { class: 'an-row' },
          btn('집계 리포트 내려받기(.xlsx)', downloadSummary, '', { id: 'anSumBtn' }),
          btn('건별 결과 내려받기(.xlsx)', downloadRows, '', { id: 'anRowsBtn' })),
        h('p', { class: 'sa-note' }, '집계 리포트에는 행 단위 값이 없습니다. 건별 결과는 고객 단위 파일이라 회사 PC에만 두고 Claude·외부 AI·메일로 보내지 마세요.')));
  }

  // 표 영역 다시 그리기(편집기는 그대로). 집계만 다시 하며 엔진은 다시 돌리지 않는다
  function refreshTables() {
    if (!S.orig) return;
    S.sel = A.selection(S.ctx, S.conds);
    render1(); render2(); render3Table(); render4Table(); render5();
  }
  function refreshAll(editors) {
    if (!S.orig) return;
    S.sel = A.selection(S.ctx, S.conds);
    if (editors) { initCombos(); renderConds(); renderRate(); render3Ctl(); render4Ctl(); render5Ctl(); }
    refreshTables();
  }

  // ── ① ──────────────────────────────────────────────────────────────────
  function renderConds() {
    const host = clear($('anCondHost'));
    const hdr = S.data.headers;
    const hopts = hdr.map((x, i) => ({ v: i, t: x || `(제목 없음 ${i + 1})` }));
    const upd = () => refreshTables();
    host.appendChild(h('div', { class: 'sa-note' }, '앞 줄에서 남은 건에만 차례로 적용합니다. 숫자 비교는 양쪽이 숫자로 읽힐 때만, 아니면 글자 비교입니다. 줄을 더하면 "그리고"로 이어집니다. 크기 비교(>, ≥, <, ≤)에서 빈 칸·숫자 아닌 칸은 거짓이니, 빈 칸은 "비어 있음" 조건으로 거르세요.'));
    const list = h('div', { class: 'an-conds' });
    S.conds.forEach((c, k) => {
      const val = textIn(c.value, (t) => { c.value = t; upd(); }, { 'aria-label': '조건 값', placeholder: '값' });
      val.disabled = A.NO_VALUE_OPS.has(c.op);
      list.appendChild(h('div', { class: 'an-cond', 'data-cond': k },
        select(hopts, c.col, (v) => { c.col = Number(v); upd(); }, { 'aria-label': '제외 조건 열' }),
        select(A.COND_OPS.map(o => ({ v: o, t: o })), c.op, (v) => { c.op = v; renderConds(); upd(); }, { 'aria-label': '연산자' }),
        val,
        textIn(c.name, (t) => { c.name = t; upd(); }, { 'aria-label': '조건 이름', placeholder: '이름(선택)' }),
        btn('올리기', () => { if (k > 0) { [S.conds[k - 1], S.conds[k]] = [S.conds[k], S.conds[k - 1]]; renderConds(); upd(); } }, 'sa-mini', { disabled: k === 0 ? true : null }),
        btn('내리기', () => { if (k < S.conds.length - 1) { [S.conds[k + 1], S.conds[k]] = [S.conds[k], S.conds[k + 1]]; renderConds(); upd(); } }, 'sa-mini', { disabled: k === S.conds.length - 1 ? true : null }),
        btn('지우기', () => { S.conds.splice(k, 1); renderConds(); upd(); }, 'sa-mini')));
    });
    host.appendChild(list);
    host.appendChild(btn('제외 조건 추가', () => { S.conds.push({ col: 0, op: '=', value: '', name: '' }); renderConds(); upd(); }, '', { id: 'anAddCond' }));
  }
  function render1() { clear($('anT1')).appendChild(tableEl(model1(), '1')); }

  // ── ② ──────────────────────────────────────────────────────────────────
  function renderRate() {
    const host = clear($('anRateHost'));
    host.appendChild(h('label', { class: 'an-inline' }, '연 금리 ',
      textIn(String(S.rate), (t) => {
        const v = A.toNumber(String(t).replace('%', ''));
        if (v === null || v < 0) { $('anRate').value = String(S.rate); return; }
        S.rate = v; render2(); render3Table();
      }, { id: 'anRate', class: 'sa-in sa-num an-rate', 'aria-label': '금리(연 %)' }), ' % (수익 열만 바뀝니다)'));
  }
  function render2() {
    const list = summaryList();
    const host = clear($('anT2'));
    host.appendChild(tableEl(model2(list), '2'));
    const nt = clear($('anN2'));
    const lines = ['수익 = 금액 합 × (금리 − 불량률(금액)). 건수는 금액이 0보다 큰 건, 0원·거절은 분석 대상 중 금액이 0 이하인 건입니다. 증가율은 맨 위 줄 대비입니다.',
      '원래 전략·바꾼 전략의 불량은 데이터의 부실 여부 열을 그대로 씁니다 — 한도가 바뀌어도 부실 여부는 같다고 보는 추정입니다.'];
    if (S.ctx.amt && S.ctx.amtInvalid) lines.push(`실행금액 칸이 비었거나 숫자가 아닌 건 ${nf(S.ctx.amtInvalid)}건은 0원으로 봤습니다.`);
    if (S.changed) {
      let e = 0; const keep = S.sel.keep;
      for (let i = 0; i < S.ctx.n; i++) if (keep[i] && S.changed.status[i] === A.ST_ERROR) e++;
      if (e) lines.push(`바꾼 전략 오류 ${nf(e)}건 (바꾼 전략 줄에서 뺐습니다)`);
    }
    for (const t of lines) nt.appendChild(h('div', { class: 'sa-note' }, t));
  }

  // ── ③ ──────────────────────────────────────────────────────────────────
  function initCombos() {
    const p = S.p3;
    p.results = new Map();
    p.cands = A.minStepCandidates(targetStrategy());
    if (!p.cands.length) { p.nodeId = null; p.rows = []; return; }
    // 바꾼 전략으로 다시 돌릴 때처럼 기준 최소 단계가 그대로면 사용자가 고른 기초 항목을 유지한다
    if (p.cands.some(c => c.id === p.nodeId)) { if (!(p.base >= 0 && p.base < candOf().items.length)) p.base = 0; }
    else { p.nodeId = p.cands[p.cands.length - 1].id; p.base = 0; }
    resetComboRows();
  }
  function resetComboRows() {
    S.p3.rows = A.defaultCombos(candOf().items.length, S.p3.base).map(keep => ({ keep }));
  }
  function render3Ctl() {
    const host = clear($('anC3'));
    const p = S.p3;
    if (!p.cands.length) { host.appendChild(h('div', { class: 'an-warn' }, '최소 단계가 없어 조합 분석을 할 수 없습니다')); return; }
    const cand = candOf();
    host.appendChild(h('div', { class: 'an-row' },
      h('label', {}, h('span', { class: 'an-lbl' }, '기준 최소 단계'), select(p.cands.map(c => ({ v: c.id, t: c.name })), p.nodeId, (v) => { p.nodeId = v; p.base = 0; p.results = new Map(); resetComboRows(); render3Ctl(); render3Table(); }, { id: 'anStep' })),
      h('label', {}, h('span', { class: 'an-lbl' }, '기초 항목'), select(cand.items.map((t, i) => ({ v: i, t })), p.base, (v) => { p.base = Number(v); resetComboRows(); render3Ctl(); render3Table(); }, { id: 'anBaseItem' }))));
    const rowsBox = h('div', { class: 'an-combo-rows' });
    p.rows.forEach((r, k) => rowsBox.appendChild(h('span', { class: 'an-chip' }, comboName(r.keep),
      isFull(r.keep) ? null : btn('지우기', () => { p.rows.splice(k, 1); render3Ctl(); render3Table(); }, 'sa-mini'))));
    host.appendChild(rowsBox);
    // 행 더하기: 기초는 늘 남기고 나머지 항목을 골라 더한다(최대 8행)
    const picks = cand.items.map((t, i) => {
      const cb = h('input', Object.assign({ type: 'checkbox', 'aria-label': `조합에 넣을 항목 ${t}` }, NO_CHECK));
      if (i === p.base) { cb.checked = true; cb.disabled = true; }
      return h('label', { class: 'an-pick' }, cb, ' ', t, i === p.base ? ' (기초)' : '');
    });
    host.appendChild(h('div', { class: 'an-add3' }, ...picks, btn('조합 행 추가', () => {
      const keep = picks.map((l, i) => (i === p.base || l.firstChild.checked ? i : -1)).filter(i => i >= 0);
      if (p.rows.length >= 8) { flash('조합은 최대 8행까지 둘 수 있습니다', 'warn'); return; }
      if (p.rows.some(r => A.sameKeep(r.keep, keep))) { flash('같은 조합이 이미 있습니다', 'warn'); return; }
      p.rows.splice(Math.max(0, p.rows.length - 1), 0, { keep });
      render3Ctl(); render3Table();
    }, '', { id: 'anAddCombo' })));
    host.appendChild(h('div', { class: 'an-row' }, btn('조합 계산', calcCombos, 'sa-primary', { id: 'anCombo' }), h('span', { class: 'sa-note', id: 'anComboProg' })));
  }
  function render3Table() {
    const p = S.p3;
    const host = clear($('anT3')), nt = clear($('anN3'));
    if (!p.cands.length) return;
    const tr = targetRun();
    const pass = tr.passed[p.nodeId];
    let passed = 0, tgt = 0;
    for (let i = 0; i < S.ctx.n; i++) if (S.sel.keep[i]) { tgt++; if (pass && pass[i]) passed++; }
    nt.appendChild(h('div', { class: 'sa-note' }, `대상 전략: ${S.changedInfo ? '바꾼 전략' : '원래 전략'} · 기준 최소 단계: ${candOf().name}`));
    nt.appendChild(h('div', { class: 'sa-note', id: 'anPassed', 'data-raw': String(passed) }, `기준 최소 단계를 지난 건 ${nf(passed)}건 (분석 대상 ${nf(tgt)}건 중) — 분기로 그 단계를 안 지난 건은 조합과 관계없이 한도가 같습니다.`));
    nt.appendChild(h('div', { class: 'sa-note' }, '뺀 CAP 쪽에 있는 거절·오류는 그대로 걸립니다 — 항목만 빼고 그 항목을 만든 단계는 남기 때문입니다.'));
    nt.appendChild(h('div', { class: 'sa-note' }, '증가율은 맨 위 조합 대비입니다. 아직 계산하지 않은 조합은 "조합 계산"을 누르면 채워집니다.'));
    host.appendChild(tableEl(model3(), '3'));
  }
  async function calcCombos() {
    const p = S.p3;
    if (S.busy || !p.cands.length) return;
    const todo = p.rows.filter(r => !isFull(r.keep) && !p.results.has(comboKey(r.keep)));
    if (!todo.length) { flash('계산할 조합이 없습니다 — 모두 계산되어 있습니다', 'info'); return; }
    S.busy = true; S.stop = false; renderRun();
    $('anCombo').disabled = true;
    try {
      const ts = targetStrategy();
      let k = 0;
      for (const r of todo) {
        k++;
        const copy = A.comboStrategy(ts, p.nodeId, r.keep);          // 사본마다 준비는 한 번(createRunner 안)
        const runner = A.createRunner(copy, cols, S.map, S.data.rows, { countErrors: false, units: S.units });
        const ok = await drive(runner, `조합 ${k}/${todo.length}`);
        if (!ok) { flash('조합 계산을 멈췄습니다', 'warn'); break; }
        p.results.set(comboKey(r.keep), runner.result());
        render3Table();
      }
      setProgress('');
    } finally { S.busy = false; S.stop = false; renderRun(); const b = $('anCombo'); if (b) b.disabled = false; }
  }

  // ── ④ ──────────────────────────────────────────────────────────────────
  function render4Ctl() {
    const host = clear($('anC4'));
    const p = S.p4;
    host.appendChild(h('div', { class: 'an-row' },
      h('label', {}, h('span', { class: 'an-lbl' }, '전략'), select([{ v: 'orig', t: '원래 전략' }].concat(S.changed ? [{ v: 'changed', t: '바꾼 전략' }] : []), p.target, (v) => { p.target = v; render4Table(); }, { id: 'anT4Target' })),
      h('div', { class: 'an-views', role: 'group', 'aria-label': '보기' }, VIEWS.map(([k, t]) => btn(t, () => { p.view = k; render4Ctl(); render4Table(); }, p.view === k ? 'sa-primary' : '', { 'data-view': k })))));
    const edges = A.normalizeEdges(p.edges || A.limitEdges(S.ctx, S.sel.keep, S.orig));
    host.appendChild(edgeEditor(edges, (e) => { p.edges = e.length ? e : [0]; render4Ctl(); render4Table(); }, p.edges ? () => { p.edges = null; render4Ctl(); render4Table(); } : null, '원'));
  }
  function render4Table() {
    const p = S.p4;
    if (p.target === 'changed' && !S.changed) p.target = 'orig';
    const host = clear($('anT4'));
    const m = model4(p.view, p.target);
    host.appendChild(h('div', { class: 'sa-note' }, `${p.target === 'changed' ? '바꾼 전략' : '원래 전략'} · ${VIEWS.find(v => v[0] === p.view)[1]} 보기 · 기준 건수 ${nf(m.target)}건 (정상·거절만, 오류 제외). 열은 결정요인(거절 행은 거절 사유) 건수 많은 순 최대 8개와 기타입니다.`));
    host.appendChild(tableEl(m, '4'));
  }

  // ── ⑤ ──────────────────────────────────────────────────────────────────
  function render5Ctl() {
    const host = clear($('anC5'));
    const opts = S.data.headers.map((x, i) => ({ v: i, t: x || `(제목 없음 ${i + 1})` }));
    const pick = select(opts, 0, null, { id: 'anVarCol', 'aria-label': '분석할 열' });
    host.appendChild(h('div', { class: 'an-row' }, h('label', {}, h('span', { class: 'an-lbl' }, '분석할 열'), pick),
      btn('표 추가', () => { S.p5.push({ id: ++S.p5seq, col: Number(pick.value), edges: null }); render5(); }, '', { id: 'anAddVar' })));
    host.appendChild(h('div', { class: 'sa-note' }, '숫자 열은 10분위수를 기본 경계로 구간을 나누고, 범주형 열은 값마다 한 행입니다(고유값 50개 이하이면서 분석 대상의 5% 이하일 때만, 5건 미만 값은 기타). 구간 KS = |누적 불량률 − 누적 우량률|, 전체 KS는 그 최댓값입니다.'));
  }
  function render5() {
    const host = clear($('anT5'));
    for (const panel of S.p5) {
      const name = S.data.headers[panel.col] || `(제목 없음 ${panel.col + 1})`;
      const vt = A.varTable(S.ctx, S.sel.keep, panel.col, { edges: panel.edges });
      panel.last = vt;
      const box = h('div', { class: 'an-var', 'data-var': panel.id },
        h('div', { class: 'an-var-head' }, h('strong', {}, name), btn('표 지우기', () => { S.p5 = S.p5.filter(x => x !== panel); render5(); }, 'sa-mini')));
      if (vt.kind === 'blocked') box.appendChild(h('div', { class: 'an-warn' }, '값 종류가 너무 많습니다(이름·번호 열일 수 있습니다) — 값을 표에 싣지 않습니다.'));
      else if (vt.kind === 'empty') box.appendChild(h('div', { class: 'an-warn' }, '분석 대상에 이 열의 값이 없습니다.'));
      else {
        if (vt.kind === 'numeric') box.appendChild(edgeEditor(vt.edges, (e) => { panel.edges = e; render5(); }, panel.edges ? () => { panel.edges = null; render5(); } : null, ''));
        box.appendChild(h('div', { class: 'sa-note' }, vt.kind === 'numeric' ? `숫자 열 · 전체 KS ${vt.ks === null ? '—' : `${(vt.ks * 100).toFixed(2)}%`}` : `범주형 열(고유값 ${nf(vt.unique)}개) · 전체 KS ${vt.ks === null ? '—' : `${(vt.ks * 100).toFixed(2)}%`}`));
        box.appendChild(tableEl(model5(vt, name), `5-${panel.id}`));
      }
      host.appendChild(box);
    }
  }

  // ── 전략값 고치기(바꾼 전략) ────────────────────────────────────────────
  const edits = [];     // {kind, label, init, el, ...}
  const truthy = (raw) => raw === true || raw === 1 || raw === '1' || raw === 'Y' || raw === '예' || raw === 'true';
  const paramInit = (v) => {
    if (v.type === 'bool') return truthy(v.value) ? '예' : '아니오';
    if (v.type === 'choice') return String(v.value);
    const n = E.toNum(v.value);
    if (n === null) return String(v.value);
    return v.type === 'percent' ? E.fmtNum(n * 100, 6) : v.type === 'money' ? E.fmtNum(n, 0) : E.fmtNum(n, 10);
  };
  function parsePercentText(t) { return A.toNumber(String(t).indexOf('%') < 0 ? `${String(t).trim()}%` : t); }
  function parseParam(v, text) {
    const t = String(text).trim();
    if (v.type === 'bool') return { value: t === '예' };
    if (v.type === 'choice') return { value: t };
    if (t === '') return { error: true };
    const n = v.type === 'percent' ? parsePercentText(t) : A.toNumber(t);
    return n === null ? { error: true } : { value: n };
  }
  const cellInit = (raw) => (E.isCellFormula(raw) ? String(raw) : raw === null || raw === undefined ? '' : typeof raw === 'number' ? E.fmtNum(raw, 10) : String(raw));
  function parseCell(text) {
    const t = String(text).trim();
    if (t === '') return { value: null };
    if (t.startsWith('=')) return { value: t };
    const n = A.toNumber(t);
    return n === null ? { error: true } : { value: n };
  }

  function addEdit(spec, el) { spec.el = el; spec.init = el.value; edits.push(spec); el.addEventListener('input', renderChanged); el.addEventListener('change', renderChanged); return el; }

  function paramControl(v) {
    const init = paramInit(v);
    let el;
    if (v.type === 'bool') el = select([{ v: '예', t: '예' }, { v: '아니오', t: '아니오' }], init, null, { 'aria-label': v.name });
    else if (v.type === 'choice') el = select((v.options || []).map(o => ({ v: o, t: o })), init, null, { 'aria-label': v.name });
    else el = textIn(init, null, { class: 'sa-in sa-num', 'aria-label': v.name });
    addEdit({ kind: 'param', v, name: v.name }, el);
    return v.type === 'percent' || v.type === 'money' ? h('span', { class: 'sa-wrap' }, el, h('span', { class: 'sa-suffix' }, v.type === 'percent' ? '%' : '원')) : el;
  }

  function buildEditArea() {
    const host = clear($('anEditBody'));
    const params = strategy.variables.filter(v => v.kind === 'param' && v.type !== 'table' && v.type !== 'debt');
    const tables = strategy.variables.filter(v => v.type === 'table');
    const debts = strategy.variables.filter(v => v.type === 'debt');
    host.appendChild(h('p', { class: 'sa-note' }, '고칠 수 있는 것은 전략 파라미터·표(기준표) 칸·부채표 기간·금리·고금리 기준뿐입니다. 단계 구조와 단계 안에 직접 적은 숫자는 고치지 않습니다 — 바꿔 볼 값은 스튜디오에서 전략 파라미터·표로 빼 둔 뒤 다시 내려받으세요.'));
    host.appendChild(h('section', { class: 'sa-sec' }, h('h4', {}, '전략 파라미터'),
      params.length ? h('div', { class: 'sa-scroll' }, h('table', { class: 'sa-tbl' }, h('thead', {}, h('tr', {}, ['이름', '값', '설명'].map(t => h('th', {}, t)))),
        h('tbody', {}, params.map(v => h('tr', { 'data-pvar': v.id }, h('td', {}, v.name), h('td', { class: 'sa-r' }, paramControl(v)), h('td', { class: 'sa-note' }, v.desc || '')))))) : h('p', { class: 'sa-note' }, '없음')));
    host.appendChild(h('section', { class: 'sa-sec' }, h('h4', {}, '표(기준표)'),
      tables.length ? tables.map(tv => {
        const nc = tv.cols ? tv.cols.keys.length : 1;
        const head = h('tr', {}, h('th', {}), tv.cols ? tv.cols.keys.map((k, i) => h('th', {}, E.axisKeyLabel(tv.cols, i))) : h('th', {}, '값'));
        const body = tv.rows.keys.map((k, r) => h('tr', {}, h('th', { class: 'sa-l' }, E.axisKeyLabel(tv.rows, r)),
          Array.from({ length: nc }, (_, c) => {
            const raw = ((tv.cells || [])[r] || [])[c];
            const el = textIn(cellInit(raw), null, { class: 'sa-in sa-num an-cell', 'aria-label': `${tv.name} ${E.axisKeyLabel(tv.rows, r)}${tv.cols ? ` ${E.axisKeyLabel(tv.cols, c)}` : ''}` });
            addEdit({ kind: 'cell', v: tv, r, c, name: `${tv.name} [${E.axisKeyLabel(tv.rows, r)}${tv.cols ? `, ${E.axisKeyLabel(tv.cols, c)}` : ''}]` }, el);
            return h('td', { class: 'sa-r' }, el);
          })));
        return h('details', { class: 'an-tbox', 'data-etable': tv.id }, h('summary', {}, tv.name),
          h('div', { class: 'sa-scroll' }, h('table', { class: 'sa-tbl' }, h('thead', {}, head), h('tbody', {}, body))));
      }) : h('p', { class: 'sa-note' }, '없음')));
    host.appendChild(h('section', { class: 'sa-sec' }, h('h4', {}, '부채표 기간·금리·고금리 기준'),
      debts.length ? debts.map(v => {
        const rows = v.rows.map((r, i) => {
          const m = textIn(E.fmtNum(r.months, 10), null, { class: 'sa-in sa-num', 'aria-label': `${v.name} ${r.sector} ${r.kind} 기간` });
          const q = textIn(E.fmtNum(r.rate * 100, 6), null, { class: 'sa-in sa-num', 'aria-label': `${v.name} ${r.sector} ${r.kind} 금리` });
          addEdit({ kind: 'debt', v, row: i, part: 'months', name: `${v.name} ${r.sector}·${r.kind} 기간(개월)` }, m);
          addEdit({ kind: 'debt', v, row: i, part: 'rate', name: `${v.name} ${r.sector}·${r.kind} 금리(연 %)` }, q);
          return h('tr', {}, h('td', {}, r.sector), h('td', {}, r.kind), h('td', { class: 'sa-r' }, m), h('td', { class: 'sa-r' }, q));
        });
        let hi = null;
        if (v.hiRate && v.hiRate.k === 'num') {
          const el = textIn(E.fmtNum(v.hiRate.v * 100, 6), null, { class: 'sa-in sa-num', 'aria-label': `${v.name} 고금리 기준` });
          addEdit({ kind: 'hi', v, name: `${v.name} 고금리 기준(연 %)` }, el);
          hi = h('p', { class: 'sa-note' }, '고금리 기준(연 %) ', el);
        } else if (v.hiRate && v.hiRate.k === 'var') hi = h('p', { class: 'sa-note' }, '고금리 기준은 전략 파라미터를 따릅니다(위 파라미터에서 고침).');
        return h('div', { class: 'an-tbox', 'data-edebt': v.id }, h('h4', {}, v.name),
          h('div', { class: 'sa-scroll' }, h('table', { class: 'sa-tbl' }, h('thead', {}, h('tr', {}, ['업권', '대출구분', '기간(개월)', '금리(연 %)'].map(t => h('th', {}, t)))), h('tbody', {}, rows))), hi);
      }) : h('p', { class: 'sa-note' }, '없음')));
    renderChanged();
  }

  // 고친 값을 읽어 바꾼 전략 사본을 만든다. 칸 글이 처음과 같으면 건드리지 않는다(처음 값이 그대로 남음)
  function readEdits() {
    const copy = JSON.parse(JSON.stringify(strategy));
    const changes = [], invalid = [];
    for (const ed of edits) {
      const text = ed.el.value;
      const bad = (on) => { ed.el.classList.toggle('invalid', on); ed.el.setAttribute('aria-invalid', on ? 'true' : 'false'); };
      if (text === ed.init) { bad(false); continue; }
      const cv = copy.variables.find(x => x.id === ed.v.id);
      let res;
      if (ed.kind === 'param') { res = parseParam(ed.v, text); if (!res.error) cv.value = res.value; }
      else if (ed.kind === 'cell') { res = parseCell(text); if (!res.error) cv.cells[ed.r][ed.c] = res.value; }
      else if (ed.kind === 'hi') { res = parsePercentText(text); res = res === null || res < 0 ? { error: true } : { value: res }; if (!res.error) cv.hiRate = { k: 'num', v: res.value }; }
      else {
        if (ed.part === 'months') { const n = A.toNumber(text); res = n === null || !(n > 0) ? { error: true } : { value: n }; if (!res.error) cv.rows[ed.row].months = res.value; }
        else { const n = parsePercentText(text); res = n === null || n < 0 ? { error: true } : { value: n }; if (!res.error) cv.rows[ed.row].rate = res.value; }
      }
      bad(!!res.error);
      if (res.error) invalid.push(ed.name); else changes.push({ name: ed.name, from: ed.init, to: text.trim() });
    }
    return { strategy: copy, changes, invalid };
  }

  function renderChanged() {
    const box = $('anChanged');
    if (!box) return;
    clear(box);
    const r = readEdits();
    const list = S.changedInfo ? S.changedInfo.changes : r.changes;
    box.appendChild(h('div', { class: 'an-lbl' }, S.changedInfo ? `바꾼 전략에 적용된 값 ${list.length}개` : `고친 값 ${list.length}개 (아직 돌리지 않음)`));
    if (r.invalid.length) box.appendChild(h('div', { class: 'an-warn', id: 'anInvalid' }, `읽을 수 없는 값: ${r.invalid.join(', ')}`));
    box.appendChild(h('ul', { class: 'an-changes', id: 'anChangeList' }, list.map(c => h('li', {}, `${c.name} · ${c.from} → ${c.to}`))));
  }

  function renderEditState() { renderRun(); renderChanged(); }

  async function rerun() {
    if (S.busy || !S.orig) return;
    const r = readEdits();
    renderChanged();
    if (r.invalid.length) { flash(`값을 읽을 수 없는 칸이 있습니다: ${r.invalid.join(', ')}`, 'danger'); return; }
    if (!r.changes.length) { flash('고친 값이 없습니다 — 파라미터·표·부채표 값을 고친 뒤 누르세요', 'warn'); return; }
    const issues = E.validate(r.strategy);
    if (issues.length) { flash(`확인 필요 항목이 있어 돌리지 않았습니다 — ${issues.slice(0, 3).join(' / ')}${issues.length > 3 ? ` 외 ${issues.length - 3}건` : ''}`, 'danger'); return; }
    S.busy = true; S.stop = false; renderRun();
    const t0 = nowMs();
    try {
      const runner = A.createRunner(r.strategy, cols, S.map, S.data.rows, { countErrors: false, units: S.units, watch: A.minStepCandidates(r.strategy).map(c => c.id) });
      const ok = await drive(runner, '바꾼 전략 계산 중');
      if (!ok) { setProgress(''); flash('계산을 멈췄습니다. 바꾼 전략 결과를 만들지 않았습니다.', 'warn'); return; }
      S.changed = runner.result();
      S.changedInfo = { strategy: r.strategy, changes: r.changes, seq: ++S.seq };
      rebuildCtx();
      setProgress('');
      S.runNotes = S.runNotes.filter(t => !t.startsWith('바꾼 전략')).concat([`바꾼 전략 ${nf(S.changed.n)}건을 ${((nowMs() - t0) / 1000).toFixed(1)}초에 계산했습니다 (고친 값 ${r.changes.length}개).`]);
      renderRun(); renderChanged();
      refreshAll(true);
    } finally { S.busy = false; S.stop = false; renderRun(); }
  }

  function revert() {
    for (const ed of edits) { ed.el.value = ed.init; ed.el.classList.remove('invalid'); ed.el.setAttribute('aria-invalid', 'false'); }
    const had = !!S.changed;
    S.changed = null; S.changedInfo = null;
    S.runNotes = S.runNotes.filter(t => !t.startsWith('바꾼 전략'));
    if (S.orig) { rebuildCtx(); S.p4.target = 'orig'; }
    renderRun(); renderChanged();
    if (S.orig) refreshAll(true);
    if (had) flash('고친 값을 버리고 바꾼 전략 줄을 없앴습니다.', 'info');
  }

  // ── 내려받기 ────────────────────────────────────────────────────────────
  const pad2 = (n) => String(n).padStart(2, '0');
  const stampNow = () => { const d = new Date(); return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`; };
  const stratName = () => String(strategy.meta && strategy.meta.name || '전략').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim() || '전략';

  function saveBytes(name, bytes) {
    const blob = new root.Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = root.URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name, hidden: true });
    doc.body.appendChild(a);
    a.click();
    a.remove();
    root.setTimeout(() => root.URL.revokeObjectURL(url), 2000);
  }
  const FMT_Z = { n: '#,##0', m: '#,##0', p: '0.00%' };
  function modelAoa(model) {
    const rows = [model.head.slice()];
    for (const r of model.rows) rows.push(r.cells.map(c => {
      if (c.t === 's') return c.v === null || c.v === undefined ? '' : String(c.v);
      if (!finite(c.v)) return '—';
      return { t: 'n', v: c.v, z: FMT_Z[c.t] };
    }));
    return rows;
  }
  const sheetName = (t) => t.replace(/[\[\]:*?\/\\]/g, '_').slice(0, 31);
  function addSheet(wb, name, aoa, widths) {
    const ws = XL.utils.aoa_to_sheet(aoa);
    if (widths) ws['!cols'] = widths.map(w => ({ wch: w }));
    XL.utils.book_append_sheet(wb, ws, sheetName(name));
  }

  const unitTag = (u) => { const f = A.UNITS.find(x => x.v === u); return f && u > 1 ? ` (단위 ${f.t})` : ''; };
  function conditionRows() {
    const hd = S.data.headers, t = (i) => (i >= 0 ? hd[i] || `(제목 없음 ${i + 1})` : '(없음)');
    const rows = [['항목', '값'],
      ['전략 이름', strategy.meta && strategy.meta.name || ''], ['서버 버전', $('saVer').textContent.replace(/^\s*\(서버 v?|\)\s*$/g, '')],
      ['내려받은 시각', $('saTime').textContent], ['리포트 만든 시각', `${stampNow()}`],
      ['데이터 건수', S.ctx.n], ['분석 대상 건수', S.sel.target], ['데이터 출처', S.data.source],
      ['부실 여부 열', t(S.badCol)], ['실행금액 열', t(S.amtCol) + unitTag(S.amtUnit)]];
    for (const c of cols) rows.push([`열 맞춤 — ${c.label}`, t(S.map[c.key] >= 0 ? S.map[c.key] : -1) + unitTag(c.type === 'money' ? S.units[c.key] : 1)]);
    S.sel.steps.filter(s => s.kind === 'user').forEach((s, k) => rows.push([`제외 조건 ${k + 1}`, `${s.name} — ${s.cond}`]));
    rows.push(['금리(연 %)', S.rate]);
    rows.push(['바꾼 값', S.changedInfo ? S.changedInfo.changes.map(c => `${c.name}: ${c.from} → ${c.to}`).join(' / ') : '(없음 — 원래 전략만)']);
    rows.push(['TO-BE 불량 가정', '원래·바꾼 전략의 불량은 데이터의 부실 여부 열을 그대로 쓴다(한도가 바뀌어도 부실 여부는 같다고 보는 추정)']);
    for (const [l, n] of S.orig.inputErrCols) rows.push([`입력 칸 형식 오류 — ${l}`, n]);
    if (S.orig.defaults) rows.push(['전략 기본값을 쓴 칸이 있는 건', S.orig.defaults]);
    if (S.p3.cands.length) rows.push(['③ 기준 최소 단계', `${candOf().name} (대상: ${S.changedInfo ? '바꾼 전략' : '원래 전략'})`]);
    return rows;
  }

  async function downloadSummary() {
    if (S.busy || !S.orig) return;
    try {
      const wb = XL.utils.book_new();
      addSheet(wb, '① 대상자 선정', modelAoa(model1()), [26, 40, 12, 12, 12, 12, 12, 12, 12, 12, 12]);
      addSheet(wb, '② 요약', modelAoa(model2(summaryList())).concat([[], ['불량은 데이터의 부실 여부 열을 그대로 씁니다(한도가 바뀌어도 부실 여부는 같다고 보는 추정). 수익 = 금액 합 × (금리 − 불량률(금액)).']]), [16, 10, 16, 12, 14, 10, 12, 18, 12, 16, 12, 12, 12, 12]);
      if (S.p3.cands.length) {
        const a3 = modelAoa(model3());
        addSheet(wb, '③ 조합', [[`기준 최소 단계: ${candOf().name} · 대상: ${S.changedInfo ? '바꾼 전략' : '원래 전략'}`], []].concat(a3), [24]);
      } else addSheet(wb, '③ 조합', [['최소 단계가 없어 조합 분석을 할 수 없습니다']]);
      const a4 = [];
      for (const which of ['orig'].concat(S.changed ? ['changed'] : [])) for (const [view, vt] of VIEWS) {
        a4.push([`${which === 'changed' ? '바꾼 전략' : '원래 전략'} · ${vt} 보기`]);
        a4.push(...modelAoa(model4(view, which)), []);
      }
      addSheet(wb, '④ 한도구간×결정요인', a4, [26]);
      const a5 = [];
      for (const panel of S.p5) {
        const name = S.data.headers[panel.col] || `(제목 없음 ${panel.col + 1})`;
        const vt = panel.last || A.varTable(S.ctx, S.sel.keep, panel.col, { edges: panel.edges });
        a5.push([`열: ${name}`]);
        if (vt.kind === 'blocked') a5.push(['값 종류가 너무 많아 값을 싣지 않습니다(이름·번호 열일 수 있습니다)']);
        else if (vt.kind === 'empty') a5.push(['분석 대상에 이 열의 값이 없습니다']);
        else a5.push(...modelAoa(model5(vt, name)));
        a5.push([]);
      }
      if (!a5.length) a5.push(['⑤ 표를 추가하지 않았습니다']);
      addSheet(wb, '⑤ 변수 구간별', a5, [30]);
      addSheet(wb, '조건', conditionRows(), [34, 80]);
      saveBytes(`대량분석_집계_${stratName()}_${stampNow()}.xlsx`, XL.write(wb, { bookType: 'xlsx', type: 'array', compression: true }));
      flash('집계 리포트를 내려받았습니다 — 행 단위 값은 들어 있지 않습니다.', 'ok');
    } catch (e) { flash('집계 리포트를 만들지 못했습니다', 'danger'); }
  }

  const ROW_CONFIRM = '고객 단위 파일입니다. 회사 PC에만 두고 Claude·외부 AI·메일로 보내지 마세요.';
  const STATUS_TEXT = ['정상', '거절', '계산 오류', '입력 오류'];
  async function downloadRows() {
    if (S.busy || !S.orig) return;
    if (!root.confirm(ROW_CONFIRM)) return;      // 취소면 아무것도 만들지 않는다
    S.busy = true; renderRun();
    try {
      flash('건별 결과 파일을 만드는 중입니다 — 건수가 많으면 시간이 걸립니다…', 'info');
      await paint();
      const head = S.data.headers.concat(['원래 전략 상태', '원래 전략 한도', '원래 전략 결정요인'], S.changed ? ['바꾼 전략 상태', '바꾼 전략 한도', '바꾼 전략 결정요인'] : []);
      const tail = (res, i) => {
        const st = res.status[i];
        return [STATUS_TEXT[st], st === A.ST_OK ? res.final[i] : st === A.ST_REJECT ? 0 : '', st <= A.ST_REJECT ? (res.labels[res.det[i]] || '') : ''];
      };
      const aoa = [head];
      const rows = S.data.rows;
      for (let i = 0; i < rows.length; i++) {
        aoa.push(rows[i].concat(tail(S.orig, i), S.changed ? tail(S.changed, i) : []));
        if ((i & 4095) === 4095) await yieldUI();
      }
      await paint();
      const wb = XL.utils.book_new();
      XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet(aoa), '건별 결과');
      await paint();
      saveBytes(`[건별]대량분석_${stratName()}_${stampNow()}.xlsx`, XL.write(wb, { bookType: 'xlsx', type: 'array', compression: true }));
      flash('건별 결과를 내려받았습니다 — 고객 단위 파일입니다. 회사 PC에만 두세요.', 'warn');
    } catch (e) { flash('건별 결과를 만들지 못했습니다', 'danger'); }
    finally { S.busy = false; renderRun(); }
  }

  // ── 화면 만들기 ─────────────────────────────────────────────────────────
  function mount() {
    const fileInput = h('input', Object.assign({ type: 'file', id: 'anFile', accept: '.xlsx', hidden: true, 'aria-label': '엑셀 파일 고르기' }, NO_CHECK));
    fileInput.addEventListener('change', () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) openFile(f); });
    const zone = h('div', { class: 'an-drop', id: 'anPasteZone', tabindex: '0', role: 'button', 'aria-label': '붙여넣기 영역' },
      h('strong', {}, '여기를 누른 뒤 Ctrl+V'), h('div', { class: 'sa-note' }, '엑셀에서 제목줄을 포함해 범위를 복사해 붙여 넣습니다(5만 건까지). 엑셀 파일(.xlsx)을 여기에 끌어 놓아도 됩니다.'));
    zone.addEventListener('paste', (e) => { e.preventDefault(); e.stopPropagation(); startPaste(e.clipboardData ? e.clipboardData.getData('text/plain') : ''); });
    zone.addEventListener('dragover', (e) => { if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; zone.classList.add('an-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('an-over'));
    zone.addEventListener('drop', (e) => { zone.classList.remove('an-over'); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) openFile(f); });
    zone.addEventListener('click', () => zone.focus());
    // 창 어디에 끌어 놓아도 브라우저가 파일을 열어 버리지 않게 한다(분석기 화면이 사라지는 것을 막음)
    for (const ev of ['dragover', 'drop']) doc.addEventListener(ev, (e) => { e.preventDefault(); });
    // 붙여넣기 영역 밖에서 Ctrl+V를 눌러도 읽는다(입력칸 안에서는 그 칸에 붙인다)
    doc.addEventListener('paste', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('input, select, textarea')) return;
      e.preventDefault();
      // 데이터가 이미 있으면 영역 밖 Ctrl+V로 바로 덮지 않고 먼저 묻는다
      if (S.data && !root.confirm('지금 데이터와 결과를 지우고 새로 붙여 넣을까요?')) return;
      startPaste(e.clipboardData ? e.clipboardData.getData('text/plain') : '');
    });

    $('saTools').appendChild(btn('데이터 지우기', clearData, '', { id: 'anClear', disabled: true }));

    clear($('app')).append(
      h('div', { class: 'an-protect', id: 'anProtect' }, '실제 데이터는 이 PC 브라우저 메모리에서만 계산합니다. 파일·서버에 저장하거나 보내지 않습니다. 창을 닫으면 지워집니다.'),
      h('div', { class: 'an-notice an-info', id: 'anNotice', role: 'status', 'aria-live': 'polite', hidden: true }),
      h('section', { class: 'an-sec an-data', id: 'anSecData' }, h('h3', {}, '1. 데이터 넣기'),
        h('div', { class: 'an-row' }, btn('엑셀(.xlsx) 올리기', () => fileInput.click(), 'sa-primary', { id: 'anPick' }), fileInput, h('span', { class: 'sa-note', id: 'anDataInfo' })),
        zone,
        h('p', { class: 'sa-note' }, '회사 문서 보안(DRM)으로 .xlsx를 열 수 없으면 엑셀에서 범위를 복사해 붙여 넣으세요. 암호화된 엑셀 파일은 이 도구가 읽지 못합니다.'),
        h('div', { id: 'anPreviewBox', class: 'an-data', hidden: true }, h('div', { class: 'sa-note' }, '미리 보기 — 제목줄과 처음 5행(열 맞춤 확인용, 인쇄하지 않습니다)'),
          h('div', { class: 'sa-scroll' }, h('table', { class: 'sa-tbl an-preview', id: 'anPreview' })))),
      h('section', { class: 'an-sec an-data', id: 'anSecMap', hidden: true }, h('h3', {}, '2. 열 맞춤'), h('div', { id: 'anMapBody' })),
      h('section', { class: 'an-sec', id: 'anSecRun', hidden: true }, h('h3', {}, '3. 계산'),
        h('div', { class: 'an-row' }, btn('계산', calculate, 'sa-primary', { id: 'anRun' }), btn('멈추기', () => { S.stop = true; }, '', { id: 'anStop', disabled: true }),
          h('span', { class: 'sa-note', id: 'anRunHint' }), h('span', { class: 'an-progress', id: 'anProgress', role: 'status' })),
        h('div', { class: 'an-notes', id: 'anRunNotes' })),
      h('div', { class: 'an-report', id: 'anReport', hidden: true }),
      h('section', { class: 'an-sec', id: 'anSecEdit' }, h('h3', {}, '전략값 고치기 (바꾼 전략)'),
        h('div', { class: 'an-row' }, btn('바꾼 전략으로 다시 돌리기', rerun, 'sa-primary', { id: 'anRerun', disabled: true }), btn('원래대로', revert, '', { id: 'anRevert' })),
        h('div', { id: 'anChanged', class: 'an-changed' }),
        h('div', { id: 'anEditBody' })));
    mountReport();
    buildEditArea();
    renderData(); renderRun();
  }

  mount();
})(typeof self !== 'undefined' ? self : this);
