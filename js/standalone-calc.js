/* ============================================================================
   간이 한도 산출기 — 내려받은 단독 HTML 파일 안에서 도는 화면 스크립트
   ----------------------------------------------------------------------------
   · 이 파일은 스튜디오 화면(index.html)에서 부르지 않는다. 내려받기 때 글로 읽어 파일 안에 넣는다(htmlexport.js)
   · 파일 안의 계산 엔진(engine.js)과 설명 문장(describe.js)을 그대로 쓴다. 전략은 #strategy 블록에서 읽는다
   · 고칠 수 있는 것은 고객 입력값(E.inputColumns가 알려 주는 칸)뿐이다. 입력을 바꾸면 곧바로 다시 계산한다
   · 글자는 모두 textContent로만 그린다(innerHTML을 쓰지 않는다). 네트워크·저장소를 쓰지 않는다
   ========================================================================== */
(function (root) {
  'use strict';
  const E = root.LimitEngine, D = root.Describe;
  const doc = root.document;
  const strategy = root.Store.strategy;
  const prep = E.prepare(strategy);
  const cols = E.inputColumns(strategy);
  const varById = new Map(strategy.variables.map(v => [v.id, v]));
  const nodeById = new Map(strategy.nodes.map(n => [n.id, n]));
  const ordIds = prep.ord.concat(prep.cycle);

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
  const noCheck = { spellcheck: 'false', autocomplete: 'off' };

  // ── 값 표시 ─────────────────────────────────────────────────────────────
  const truthy = (raw) => raw === true || raw === 1 || raw === '1' || raw === 'Y' || raw === '예' || raw === 'true';
  // fmt: money · percent · bool · ''(숫자/글자)
  function fmtBy(v, fmt) {
    if (v === null || v === undefined) return '—';
    if (fmt === 'bool') return v ? '예' : '아니오';
    if (fmt === 'money' || fmt === 'percent') return E.fmtValue(v, fmt);
    return typeof v === 'string' ? v : E.fmtNum(v);
  }
  const readsText = (st) => ((st && st.reads) || []).map(x => `[${x.name}] = ${fmtBy(x.value, x.fmt)}`).join(' · ');
  const TYPE_LABEL = { money: '금액', number: '숫자', percent: '비율', choice: '선택형', bool: '예/아니오' };

  // 입력칸에 보이는 글 ↔ 값. 비율은 %로 보이고(90) 저장값은 0.9다(스튜디오 단일 시뮬레이션과 같은 규칙)
  function toText(col, val) {
    if (val === null || val === undefined || val === '') return '';
    if (col.type === 'bool') return truthy(val) ? '예' : '아니오';
    if (col.type === 'choice') return String(val);
    const n = E.toNum(val);
    if (n === null) return String(val);
    if (col.type === 'percent') return E.fmtNum(n * 100, 6);
    if (col.type === 'money') return E.fmtNum(n, 0);
    return E.fmtNum(n, 10);
  }
  function defaultText(col) {
    const v = varById.get(col.varId);
    if (col.debt) return v.rows[col.row].balance ? E.fmtNum(v.rows[col.row].balance, 0) : '0';
    return toText(col, v.value);
  }
  // 칸의 글 → 읽은 값. 비율 칸은 %를 붙여 읽는다
  function readCell(col, text) {
    let t = String(text);
    if (col.type === 'percent' && t.trim() !== '' && t.indexOf('%') < 0) t += '%';
    return { t, cell: E.parseInputCell(col, t) };
  }

  // ── 입력 영역 ───────────────────────────────────────────────────────────
  const controls = new Map();   // 열 key → 입력 요소
  const initial = Object.fromEntries(cols.map(c => [c.key, defaultText(c)]));

  function makeControl(col) {
    let el;
    if (col.type === 'bool') {
      el = h('select', Object.assign({ class: 'sa-in', 'aria-label': col.label }, noCheck), h('option', { value: '예' }, '예'), h('option', { value: '아니오' }, '아니오'));
    } else if (col.type === 'choice') {
      el = h('select', Object.assign({ class: 'sa-in', 'aria-label': col.label }, noCheck), (col.options || []).map(o => h('option', { value: o }, o)));
    } else {
      el = h('input', Object.assign({ type: 'text', inputmode: 'decimal', class: 'sa-in sa-num', 'aria-label': col.label }, noCheck));
      if (!col.debt) el.placeholder = initial[col.key];
      el.addEventListener('blur', () => { const r = readCell(col, el.value); if (r.cell.value !== undefined) el.value = toText(col, r.cell.value); });
    }
    el.value = initial[col.key];
    el.addEventListener('input', recompute);
    controls.set(col.key, el);
    return el;
  }

  const debtCells = new Map();   // 부채표 id → {rows: [{high, pay}], parts: {part: td}}
  function debtBlock(v, no) {
    const myCols = cols.filter(c => c.debt && c.varId === v.id);
    const cells = { rows: [], parts: {} };
    debtCells.set(v.id, cells);
    const body = v.rows.map((r, i) => {
      const col = myCols.find(c => c.row === i);
      const high = h('td', { class: 'sa-c' }, '—'), pay = h('td', { class: 'sa-r' }, '—');
      cells.rows.push({ high, pay });
      return h('tr', {}, h('td', {}, r.sector), h('td', {}, r.kind),
        h('td', { class: 'sa-r' }, col ? makeControl(col) : '—'),
        h('td', { class: 'sa-r' }, E.fmtNum(r.months)), h('td', { class: 'sa-r' }, E.fmtValue(r.rate, 'percent')), high, pay);
    });
    const foot = E.DEBT_PARTS.filter(p => p[0] !== 'high' || v.hiRate).map(p => {
      const td = h('td', { class: 'sa-r', colspan: 3 }, '—');
      cells.parts[p[0]] = td;
      return h('tr', {}, h('th', { colspan: 4, class: 'sa-l' }, p[1]), td);
    });
    return h('section', { class: 'sa-sec', 'data-debt': v.id },
      h('h3', {}, `${no}. 부채표 [${v.name}]`), v.desc ? h('p', { class: 'sa-note' }, v.desc) : null,
      h('div', { class: 'sa-scroll' }, h('table', { class: 'sa-tbl sa-debt' },
        h('thead', {}, h('tr', {}, ['업권', '대출구분', '잔액(원, 입력)', '기간(개월)', '금리(연)', '고금리', '월 원리금'].map(t => h('th', {}, t)))),
        h('tbody', {}, body), h('tfoot', {}, foot))));
  }

  function otherBlock(no) {
    const others = cols.filter(c => !c.debt);
    const rows = others.map(c => h('tr', {},
      h('td', {}, c.label),
      h('td', { class: 'sa-r' }, c.type === 'percent' || c.type === 'money'
        ? h('span', { class: 'sa-wrap' }, makeControl(c), h('span', { class: 'sa-suffix' }, c.type === 'percent' ? '%' : '원')) : makeControl(c)),
      h('td', {}, TYPE_LABEL[c.type] || c.type),
      h('td', { class: 'sa-note' }, c.desc || '')));
    return h('section', { class: 'sa-sec', 'data-other': '1' },
      h('h3', {}, `${no}. 기타 입력`),
      others.length ? h('div', { class: 'sa-scroll' }, h('table', { class: 'sa-tbl' },
        h('thead', {}, h('tr', {}, ['항목', '값(입력)', '구분', '비고'].map(t => h('th', {}, t)))), h('tbody', {}, rows)))
        : h('p', { class: 'sa-note' }, '고객 입력값이 없습니다.'));
  }

  // ── 표 보기 ─────────────────────────────────────────────────────────────
  const cellText = (v) => (E.isCellFormula(v) || typeof v === 'string' ? String(v) : v === null || v === undefined ? '' : E.fmtNum(v));
  // hit: {r, c} 찾은 칸 | {rows: Set} 누진 합산에 쓴 구간
  function tableView(tv, hit) {
    const head = tv.cols
      ? h('tr', {}, h('th', {}), tv.cols.keys.map((k, i) => h('th', {}, E.axisKeyLabel(tv.cols, i))))
      : h('tr', {}, h('th', {}, '구간·항목'), h('th', {}, '값'));
    const body = tv.rows.keys.map((k, r) => {
      const n = tv.cols ? tv.cols.keys.length : 1;
      const tds = [];
      for (let c = 0; c < n; c++) {
        const raw = ((tv.cells || [])[r] || [])[c];
        const on = hit && ((hit.rows && hit.rows.has(r)) || (hit.r === r && hit.c === c));
        tds.push(h('td', { class: `sa-r${on ? ' sa-hit' : ''}`, 'data-raw': raw === null || raw === undefined ? '' : String(raw) }, cellText(raw)));
      }
      return h('tr', { class: hit && ((hit.rows && hit.rows.has(r)) || hit.r === r) ? 'sa-pick' : '' }, h('th', { class: 'sa-l' }, E.axisKeyLabel(tv.rows, r)), tds);
    });
    return h('div', { class: 'sa-scroll' }, h('table', { class: 'sa-tbl sa-tview' }, h('thead', {}, head), h('tbody', {}, body)));
  }

  // ── 계산 단계 블록 ──────────────────────────────────────────────────────
  const userOpen = new Map();   // 사용자가 직접 여닫은 블록·표 보기 (id → 열림)
  function detailsEl(key, open, cls, summary) {
    const d = h('details', { class: cls });
    if (userOpen.has(key) ? userOpen.get(key) : open) d.setAttribute('open', '');
    const s = h('summary', {}, summary);
    s.addEventListener('click', () => setTimeout(() => userOpen.set(key, d.open), 0));
    d.appendChild(s);
    return d;
  }

  // 단계 하나의 표 행: {item, value, formula, note, cls}
  function stepRows(node, st) {
    const c = node.config || {};
    const reads = readsText(st);
    const money = (v) => E.fmtValue(v, 'money');
    const val = (v) => E.fmtValue(v, node.format);
    const one = (item) => [{ item, value: val(st.value), formula: D.describe(node), note: reads }];
    switch (node.type) {
      case 'pva': {
        const fmtOf = (ref) => {
          if (ref.k === 'line') return 'money';
          const name = D.refText(ref, node).replace(/^\[|\]$/g, ''), x = (st.reads || []).find(q => q.name === name);
          return x ? x.fmt : '';
        };
        const rows = (st.lines || []).map((l, i) => {
          const cfg = (c.lines || []).find(x => x.id === l.id) || { tokens: [] };
          const note = (cfg.tokens || []).map((t, j) => (t.t === 'ref' && l.vals[j] !== null && l.vals[j] !== undefined && t.ref.k !== 'pvf'
            ? `${D.refText(t.ref, node)} = ${fmtBy(l.vals[j], fmtOf(t.ref))}` : t.t === 'ref' && t.ref.k === 'pvf' ? `[${E.PVF_NAME}] = ${fmtBy(l.vals[j], '')}` : null)).filter(Boolean).join(' · ');
          return { item: l.name, value: money(l.value), formula: D.tokensText(cfg.tokens, node), note, cls: i === st.lines.length - 1 ? 'sa-pick' : '' };
        });
        if (st.factor !== undefined) {
          rows.push({ item: E.PVF_NAME, value: E.fmtNum(st.factor), formula: `연 ${E.rateTokens(c).map(t => D.rateTokenText(t, node)).join(' ')}, ${D.refText(c.months)}개월`,
            note: `금리(연) = ${E.fmtValue(st.rate, 'percent')} · 기간(개월) = ${E.fmtNum(st.months)}` });
        }
        return rows;
      }
      case 'arith': case 'formula': return one('결과');
      case 'lookup': {
        const tv = varById.get(c.table && c.table.id), look = st.look || {};
        const rows = [{ item: '행 기준값', value: fmtBy(look.rowKey, ''), formula: D.refText(c.row), note: '' }];
        if (tv && tv.cols) rows.push({ item: '열 기준값', value: fmtBy(look.colKey, ''), formula: D.refText(c.col), note: '' });
        rows.push({ item: '찾은 값', value: val(st.value), formula: D.describe(node), note: reads, cls: 'sa-pick' });
        return rows;
      }
      case 'progressive': {
        const look = st.look || {};
        return [{ item: '기준값', value: fmtBy(look.base, ''), formula: D.refText(c.base), note: '' },
          { item: '합계', value: val(st.value), formula: D.describe(node), note: reads, cls: 'sa-pick' }];
      }
      case 'minmax': {
        return (st.candidates || []).map((k, i) => {
          const x = (st.reads || []).find(q => q.name === k.name);
          return { item: `${i === st.best ? '★ ' : ''}${k.name}`, value: val(k.value), formula: i === 0 ? D.describe(node) : '', note: x ? `[${x.name}] = ${fmtBy(x.value, x.fmt)}` : '', cls: i === st.best ? 'sa-pick' : '' };
        });
      }
      case 'cond': {
        const tf = st.hit === undefined ? '—' : st.hit ? '참' : '거짓';
        return [{ item: '조건', value: tf, formula: D.groupText(c.when), note: '' },
          { item: '고른 값', value: val(st.value), formula: `${st.hit ? '참이면' : '거짓이면'} ${D.refText(st.hit ? c.then : c.else)}`, note: reads, cls: 'sa-pick' }];
      }
      case 'cutoff': {
        const rows = [{ item: '조건', value: st.triggered ? '걸림' : '걸리지 않음', formula: D.groupText(c.when), note: reads },
          { item: '결과', value: D.stepValueText(node, st), formula: `${c.action === 'reject' ? '대출 거절' : '0원'}${c.input ? `, 아니면 ${D.refText(c.input)}` : ''}`, note: '', cls: 'sa-pick' }];
        if (st.triggered) rows.push({ item: '사유', value: st.reason || node.name, formula: '', note: '' });
        return rows;
      }
      case 'branch': {
        const cases = c.cases || [];
        const rows = cases.map((k, i) => ({ item: k.label, value: st.picked === i ? '● 해당' : (st.picked !== undefined && (st.picked < 0 || st.picked > i) ? '아니오' : '검사 안 함'),
          formula: D.groupText(k.when), note: st.picked === i ? reads : '', cls: st.picked === i ? 'sa-pick' : '' }));
        rows.push({ item: c.elseLabel || '그 외', value: st.picked === -1 ? '● 해당' : '—', formula: '그 외', note: st.picked === -1 ? reads : '', cls: st.picked === -1 ? 'sa-pick' : '' });
        return rows;
      }
    }
    return one('결과');
  }

  function stepBlock(id, no, st, finalId) {
    const node = nodeById.get(id);
    const on = !!st.active && !st.skipped && !st.cycle && !st.stopped;
    const status = D.stepValueText(node, st);
    const d = detailsEl(id, on, `sa-block${on ? '' : ' sa-off'}${st.error ? ' sa-err' : ''}`,
      [h('span', { class: 'sa-block-no' }, `${no}.`), ' ', h('span', { class: 'sa-block-name' }, node.name), h('span', { class: 'sa-block-type' }, ` · ${E.NODE_TYPES[node.type] || node.type} · `),
        h('span', { class: 'sa-block-status' }, status), id === finalId ? h('span', { class: 'sa-tag' }, '최종') : null]);
    d.setAttribute('data-node', id);
    d.setAttribute('data-no', String(no));
    if (!on) { d.appendChild(h('p', { class: 'sa-note' }, st.error || `${status} — 이번 계산 경로에서 계산하지 않았습니다.`)); return d; }
    let rows;
    try { rows = stepRows(node, st); } catch (e) { rows = [{ item: '결과', value: D.stepValueText(node, st), formula: D.describe(node), note: '' }]; }
    if (st.error) rows = [{ item: '오류', value: '—', formula: D.describe(node), note: st.error }];
    d.appendChild(h('div', { class: 'sa-scroll' }, h('table', { class: 'sa-tbl sa-step' },
      h('thead', {}, h('tr', {}, ['항목', '값', '산식', '비고'].map(t => h('th', {}, t)))),
      h('tbody', {}, rows.map(r => h('tr', { class: r.cls || '' }, h('td', {}, r.item), h('td', { class: 'sa-r' }, r.value), h('td', { class: 'sa-formula' }, r.formula || ''), h('td', { class: 'sa-note' }, r.note || '')))))));
    if (!st.error && (node.type === 'lookup' || node.type === 'progressive')) {
      const tv = varById.get(node.config.table && node.config.table.id);
      if (tv && tv.type === 'table') {
        let hit;
        if (node.type === 'lookup') hit = st.look ? { r: st.look.r, c: st.look.c } : null;
        else if (st.look) { hit = { rows: new Set() }; tv.rows.keys.forEach((k, i) => { const to = i + 1 < tv.rows.keys.length ? tv.rows.keys[i + 1] : Infinity; if (Math.max(Math.min(st.look.base, to) - k, 0) > 0) hit.rows.add(i); }); }
        const tvd = detailsEl(`${id}#tbl`, false, 'sa-tview-wrap', '표 보기');
        tvd.appendChild(h('div', { class: 'sa-note' }, `[${tv.name}]${hit && node.type === 'lookup' ? ' — 찾은 칸을 강조했습니다' : ''}`));
        tvd.appendChild(tableView(tv, hit));
        d.appendChild(tvd);
      }
    }
    return d;
  }

  // ── 결과 상자·경로 ──────────────────────────────────────────────────────
  const stepsHost = h('div', { class: 'sa-steps-list' });
  const pathHost = h('div', { class: 'sa-path' });
  const resultHost = h('div', { class: 'sa-resultbox' });

  function renderPath(r) {
    const parts = [];
    for (const id of prep.ord) {
      const n = nodeById.get(id), st = r.steps[id];
      if (n.type === 'branch' && st && st.active && !st.error) parts.push(`${n.name} → ${st.value}`);
    }
    clear(pathHost).append(h('span', { class: 'sa-path-label' }, '지나온 경로 '), h('span', { class: 'sa-path-text' }, parts.length ? parts.join('  ·  ') : '분기 단계가 없거나 지나지 않았습니다'));
  }

  function renderResult(r, bad) {
    const fid = r.finalNodeId && nodeById.get(r.finalNodeId);
    const fmt = (v) => E.fmtValue(v, fid ? fid.format : 'money');
    const label = r.status === 'ok' ? '정상' : r.status === 'reject' ? '거절' : '오류';
    clear(resultHost);
    resultHost.className = `sa-resultbox${bad.length ? ' sa-stale' : ''}`;
    resultHost.append(
      h('div', { class: 'sa-res-label' }, fid ? fid.name : '최종한도'),
      h('div', { class: 'sa-res-value', id: 'saFinal' }, r.final === null || r.final === undefined ? '—' : fmt(r.final)),
      h('div', {}, h('span', { class: `sa-badge sa-badge-${r.status}`, id: 'saStatus' }, label)),
      h('dl', { class: 'sa-res-list' },
        h('dt', {}, r.status === 'reject' ? '거절 사유' : '결정요인'), h('dd', { id: 'saDet' }, r.determinant || '—'),
        r.reason && r.status !== 'reject' ? [h('dt', {}, '0원 사유'), h('dd', { id: 'saReason' }, r.reason)] : null));
    if (bad.length) resultHost.append(h('div', { class: 'sa-res-err', id: 'saInputErr' }, h('strong', {}, '입력 오류 — '), bad.join(', '), h('div', { class: 'sa-note' }, '입력을 바로잡으면 다시 계산합니다. 아래 계산 단계는 마지막 정상 계산입니다.')));
    if (r.errors && r.errors.length && !bad.length) resultHost.append(h('ul', { class: 'sa-res-errors', id: 'saErrors' }, r.errors.map(m => h('li', {}, m))));
  }

  function renderDebts(r) {
    for (const [id, cells] of debtCells) {
      const d = r.debts && r.debts[id];
      const v = varById.get(id);
      v.rows.forEach((row, i) => {
        const x = d && d.rows[i];
        cells.rows[i].high.textContent = !x || d.hiRate === null ? '—' : x.high ? '예' : '아니오';
        cells.rows[i].pay.textContent = x ? E.fmtValue(x.pay, 'money') : '—';
      });
      for (const [part, td] of Object.entries(cells.parts)) td.textContent = d && d.parts[part] !== undefined ? E.fmtValue(d.parts[part], 'money') : '—';
    }
  }

  function renderSteps(r, bad) {
    const finalId = r.finalNodeId;
    const frag = doc.createDocumentFragment();
    ordIds.forEach((id, i) => frag.appendChild(stepBlock(id, i + 1, r.steps[id] || {}, finalId)));
    clear(stepsHost).appendChild(frag);
    stepsHost.classList.toggle('sa-stale', bad.length > 0);
    pathHost.classList.toggle('sa-stale', bad.length > 0);
  }

  // ── 계산 ────────────────────────────────────────────────────────────────
  let lastGood = null;
  function recompute() {
    const bad = [];
    const row = cols.map(c => {
      const el = controls.get(c.key), r = readCell(c, el.value);
      const err = !!r.cell.error;
      el.classList.toggle('invalid', err);
      el.setAttribute('aria-invalid', err ? 'true' : 'false');
      if (err) bad.push(c.label);
      return r.t;
    });
    if (bad.length && lastGood) { renderResult(lastGood, bad); renderSteps(lastGood, bad); renderDebts(lastGood); return; }
    let r;
    try {
      const mapping = Object.fromEntries(cols.map((c, i) => [c.key, i]));
      r = E.evaluate(strategy, E.rowInputs(strategy, cols, mapping, row).inputs, prep, { trace: true });
    } catch (e) {
      r = { status: 'error', final: null, finalNodeId: E.finalNodeId(strategy), determinant: null, reason: null, steps: {}, errors: [`계산 중 예상하지 못한 오류: ${e.message}`] };
    }
    lastGood = r;
    renderResult(r, bad);
    renderPath(r);
    renderSteps(r, bad);
    renderDebts(r);
  }

  function reset() {
    for (const c of cols) controls.get(c.key).value = initial[c.key];
    recompute();
  }

  // ── 전략값 보기(글자만) ─────────────────────────────────────────────────
  function valueText(v) {
    if (v.type === 'bool') return truthy(v.value) ? '예' : '아니오';
    if (v.type === 'choice') return String(v.value);
    return fmtBy(E.toNum(v.value) === null ? v.value : E.toNum(v.value), v.type === 'money' || v.type === 'percent' ? v.type : '');
  }
  function strategyValues() {
    const params = strategy.variables.filter(v => v.kind === 'param' && v.type !== 'table' && v.type !== 'debt');
    const tables = strategy.variables.filter(v => v.type === 'table');
    const debts = strategy.variables.filter(v => v.type === 'debt');
    const hiText = (v) => {
      if (!v.hiRate) return '정하지 않음';
      if (v.hiRate.k === 'num') return E.fmtValue(v.hiRate.v, 'percent');
      const x = varById.get(v.hiRate.id);
      return x ? `${x.name} = ${valueText(x)}` : '(삭제됨)';
    };
    return h('details', { class: 'sa-values', id: 'saValues' },
      h('summary', {}, '전략값 보기 (보기 전용)'),
      h('section', { class: 'sa-sec' }, h('h3', {}, '전략 파라미터'),
        params.length ? h('table', { class: 'sa-tbl', id: 'saParams' }, h('thead', {}, h('tr', {}, ['이름', '값', '설명'].map(t => h('th', {}, t)))),
          h('tbody', {}, params.map(v => h('tr', { 'data-var': v.id }, h('td', {}, v.name), h('td', { class: 'sa-r', 'data-raw': String(v.value) }, valueText(v)), h('td', { class: 'sa-note' }, v.desc || ''))))) : h('p', { class: 'sa-note' }, '없음')),
      h('section', { class: 'sa-sec' }, h('h3', {}, '표(기준표)'),
        tables.length ? tables.map(tv => h('div', { class: 'sa-tbox', 'data-table': tv.id }, h('h4', {}, tv.name), tv.desc ? h('p', { class: 'sa-note' }, tv.desc) : null, tableView(tv, null))) : h('p', { class: 'sa-note' }, '없음')),
      h('section', { class: 'sa-sec' }, h('h3', {}, '부채표 기간·금리·고금리 기준'),
        debts.length ? debts.map(v => h('div', { class: 'sa-tbox', 'data-debtvals': v.id }, h('h4', {}, v.name),
          h('table', { class: 'sa-tbl' }, h('thead', {}, h('tr', {}, ['업권', '대출구분', '기간(개월)', '금리(연)'].map(t => h('th', {}, t)))),
            h('tbody', {}, v.rows.map(r => h('tr', {}, h('td', {}, r.sector), h('td', {}, r.kind), h('td', { class: 'sa-r', 'data-raw': String(r.months) }, E.fmtNum(r.months)), h('td', { class: 'sa-r', 'data-raw': String(r.rate) }, E.fmtValue(r.rate, 'percent')))))),
          h('p', { class: 'sa-note' }, `고금리 기준: ${hiText(v)}`))) : h('p', { class: 'sa-note' }, '없음')));
  }

  // ── 화면 만들기 ─────────────────────────────────────────────────────────
  function mount() {
    const inputs = h('section', { class: 'sa-col sa-inputs' }, h('h2', {}, '입력'));
    let no = 1;
    for (const v of strategy.variables.filter(x => x.type === 'debt' && cols.some(c => c.debt && c.varId === x.id))) inputs.appendChild(debtBlock(v, no++));
    inputs.appendChild(otherBlock(no));
    const steps = h('section', { class: 'sa-col sa-steps' }, h('h2', {}, '계산 단계'), pathHost, stepsHost);
    const result = h('aside', { class: 'sa-col sa-result' }, h('h2', {}, '결과'), resultHost);
    clear(doc.getElementById('app')).append(h('div', { class: 'sa-grid' }, inputs, steps, result), strategyValues());
    doc.getElementById('saTools').appendChild(h('button', { type: 'button', class: 'sa-btn', id: 'saReset', onclick: reset }, '처음 값으로'));
    recompute();
  }

  mount();
})(typeof self !== 'undefined' ? self : this);
