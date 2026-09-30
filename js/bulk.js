/* ============================================================================
   대량 시뮬레이션 · 전략 비교 탭
   ----------------------------------------------------------------------------
   · 양식 내려받기(열 = 고객 입력값 + 부채표 행별 잔액) → 가상 데이터 엑셀 올리기
     → 열 맞춤 → 일괄 계산 → 요약(분포) → 결과 표 → 결과 내려받기
   · 전략 비교: 같은 데이터에 비교 기준(A)과 지금 전략(B)을 돌려 건별 차이·결정요인 변화
   · 행을 누르면 "이 건 보기" — 프로세스 탭에서 그 건의 값으로 계산해 보여 준다
   올린 데이터는 이 브라우저 메모리에만 두고 서버·임시저장에 남기지 않는다.
   엑셀 읽기·쓰기는 SheetJS(lib/xlsx.full.min.js)를 쓴다.
   ========================================================================== */
(function (root) {
  'use strict';
  const E = root.LimitEngine, S = root.Store, { h, clear } = root.UI;

  const SHOW_MAX = 500;      // 화면 표에 보여 줄 건수(전체는 내려받기)
  // 계산 사이에 화면에 한 번 양보한다. setTimeout은 백그라운드 탭에서 최대 1분까지 늦춰지므로(크롬 타이머 제한) 메시지 채널을 쓴다
  const yieldToUI = () => new Promise((res) => { const ch = new MessageChannel(); ch.port1.onmessage = () => res(); ch.port2.postMessage(0); });
  const CHUNK = 1000;        // 한 번에 계산할 건수 — 사이사이 화면을 갱신해 멈춘 것처럼 보이지 않게

  let bulkHost, cmpHost;
  let data = null;           // {fileName, headers, rows, idCol}
  let mapping = {};          // 지금 전략의 열 key → 엑셀 제목 번호(-1 = 없음)
  let bulk = null;           // {stamp, rows:[{id, status, final, det, errors, warnings, values}]}
  let base = null;           // 비교 기준 {strategy, label, at}
  let cmp = null;            // {stamp, rows:[{id, a, b, diff}]}
  let busy = false;

  const XLSX = () => root.XLSX;
  const money = (v) => E.fmtValue(v, 'money');
  // 요약용 짧은 금액: 1억 이상은 억(소수 둘째 자리), 1만 이상은 만
  const man = (v) => (Math.abs(v) >= 1e8 ? `${E.fmtNum(Math.round(v / 1e6) / 100, 2)}억` : Math.abs(v) >= 1e4 ? `${E.fmtNum(Math.round(v / 1e4))}만` : E.fmtNum(v));
  const statusText = { ok: '정상', reject: '거절', error: '오류', input: '입력 오류' };
  const statusBadge = { ok: 'ok', reject: 'danger', error: 'warn', input: 'warn' };

  function mount(bulkEl, cmpEl) {
    bulkHost = bulkEl; cmpHost = cmpEl;
    S.subscribe((reason) => {
      if (['saved', 'exported', 'canvas-move', 'view', 'test-input'].includes(reason)) return;
      if (['load', 'new', 'example', 'import'].includes(reason)) { bulk = null; cmp = null; }
      renderBulk(); renderCompare();
    });
    renderBulk(); renderCompare();
  }

  const cols = () => E.inputColumns(S.strategy);
  // 전략이 바뀌면(변수 추가 등) 새 열만 자동으로 맞추고, 사람이 고른 것은 둔다
  function currentMapping() {
    if (!data) return {};
    const auto = E.autoMap(cols(), data.headers);
    for (const c of cols()) if (!(c.key in mapping)) mapping[c.key] = auto[c.key];
    return mapping;
  }

  function section(title, ...children) {
    return h('div', { class: 'bulk-card' }, h('div', { class: 'panel-title' }, title), ...children);
  }

  // ── 양식 ────────────────────────────────────────────────────────────────
  function cellFor(c, inputs, s) {
    const v = s.variables.find(x => x.id === c.varId);
    if (c.debt) return ((inputs && inputs[c.varId]) || v.rows.map(r => r.balance || 0))[c.row] || 0;
    const val = inputs && Object.prototype.hasOwnProperty.call(inputs, c.varId) ? inputs[c.varId] : v.value;
    return c.type === 'bool' ? (val ? 'Y' : 'N') : val;
  }

  function downloadTemplate(withSamples) {
    const s = S.strategy, cs = cols();
    const head = ['건 ID', ...cs.map(c => c.label)];
    const rows = withSamples ? (s.samples && s.samples.length ? s.samples : [{ id: '테스트입력값', inputs: {} }])
      .map(sm => [sm.id, ...cs.map(c => cellFor(c, sm.inputs, s))]) : [];
    const wb = XLSX().utils.book_new();
    const ws = XLSX().utils.aoa_to_sheet([head, ...rows]);
    ws['!cols'] = head.map(x => ({ wch: Math.max(10, String(x).length * 2) }));
    XLSX().utils.book_append_sheet(wb, ws, '입력');
    const TYPE = { money: '금액(원) — 숫자, 쉼표 가능', number: '숫자', percent: '비율 — 0.7 또는 70%', bool: 'Y / N', choice: '선택' };
    const guide = XLSX().utils.aoa_to_sheet([
      ['열', '형태', '설명'],
      ['건 ID', '글자', '건을 구분하는 이름(비워도 됨 — 줄 번호를 씀)'],
      ...cs.map(c => [c.label, c.type === 'choice' ? `선택: ${(c.options || []).join(' / ')}` : TYPE[c.type] || c.type, c.desc || '']),
      [],
      ['가상 데이터 전용 — 고객 개인신용정보를 넣지 마세요. 잔액 칸이 비면 0, 다른 칸이 비면 전략의 기본값으로 계산합니다.'],
    ]);
    guide['!cols'] = [{ wch: 30 }, { wch: 28 }, { wch: 60 }];
    XLSX().utils.book_append_sheet(wb, guide, '설명');
    XLSX().writeFile(wb, `${safe(s.meta.name)}_대량시뮬레이션_양식${withSamples ? '_예시' : ''}.xlsx`);
  }
  const safe = (x) => String(x || '전략').replace(/[\\/:*?"<>|]/g, '_');

  // ── 올리기 ──────────────────────────────────────────────────────────────
  // CSV는 UTF-8로 읽고, 글자가 깨지면(엑셀 기본 저장 = EUC-KR) 한 번 더 EUC-KR로 읽는다
  async function readFile(file) {
    const buf = await file.arrayBuffer();
    let wb;
    if (/\.csv$/i.test(file.name)) {
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('�')) text = new TextDecoder('euc-kr').decode(buf);
      wb = XLSX().read(text.replace(/^﻿/, ''), { type: 'string', raw: true });
    } else {
      wb = XLSX().read(buf, { type: 'array' });
    }
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX().utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    if (!aoa.length) throw new Error('첫 시트가 비어 있습니다');
    const headers = aoa[0].map(x => (x === null ? '' : String(x).trim()));
    const rows = aoa.slice(1).filter(r => r.some(x => x !== null && String(x).trim() !== ''));
    const idCol = headers.findIndex(x => /^(건\s*id|id|건\s*이름|이름)$/i.test(x));
    return { fileName: file.name, headers, rows, idCol };
  }

  // 파일 선택 칸은 화면을 다시 그려도 남도록 한 번만 만든다(hidden)
  function fileInput(cls, accept, onFile) {
    let input = document.querySelector(`input.${cls}`);
    if (!input) {
      input = h('input', { type: 'file', class: cls, accept, hidden: true });
      input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; if (f) onFile(f); });
      document.body.appendChild(input);
    }
    return input;
  }

  function pickFile() { fileInput('bulk-file', '.xlsx,.xls,.csv', onDataFile).click(); }

  async function onDataFile(f) {
    try {
      data = await readFile(f);
      mapping = E.autoMap(cols(), data.headers);
      bulk = null; cmp = null;
      root.App.flash(`${f.name} — ${data.rows.length.toLocaleString('ko-KR')}건을 읽었습니다 (브라우저 안에서만 계산, 저장하지 않음)`, 'ok');
    } catch (e) {
      root.App.flash(`파일을 읽지 못했습니다: ${e.message}`, 'danger');
    }
    renderBulk(); renderCompare();
  }

  // ── 계산 ────────────────────────────────────────────────────────────────
  const rowId = (row, i) => (data.idCol >= 0 && row[data.idCol] !== null && String(row[data.idCol]).trim() !== '' ? String(row[data.idCol]) : `${i + 1}행`);

  // 전략 하나를 데이터 전체에 돌린다. keepValues면 단계별 값도 남긴다(결과 내려받기용)
  async function runAll(strategy, map, keepValues, onProgress) {
    const cs = E.inputColumns(strategy);
    const prep = E.prepare(strategy);
    const out = [];
    for (let i = 0; i < data.rows.length; i++) {
      const row = data.rows[i];
      const { inputs, warnings, errors } = E.rowInputs(strategy, cs, map, row);
      if (errors.length) out.push({ id: rowId(row, i), status: 'input', final: null, det: '', errors, warnings });
      else {
        let r;
        try { r = E.evaluate(strategy, inputs, prep); } catch (e) { r = { status: 'error', final: null, errors: [e.message], steps: {} }; }
        const rec = { id: rowId(row, i), status: r.status, final: r.final, det: (r.status === 'reject' ? r.reason : r.determinant) || '', errors: r.errors || [], warnings };
        if (keepValues) rec.values = Object.fromEntries(Object.entries(r.steps).filter(([, st]) => st.active && !st.error).map(([id, st]) => [id, st.value]));
        out.push(rec);
      }
      if ((i + 1) % CHUNK === 0) { onProgress(i + 1); await yieldToUI(); }
    }
    return out;
  }

  async function runBulk() {
    if (busy || !data) return;
    busy = true;
    const prog = bulkHost.querySelector('.bulk-progress');
    try {
      const rows = await runAll(S.strategy, currentMapping(), true, (n) => { if (prog) prog.textContent = `계산 중… ${n.toLocaleString('ko-KR')} / ${data.rows.length.toLocaleString('ko-KR')}건`; });
      bulk = { stamp: S.strategy.meta.updated, rows };
    } finally { busy = false; }
    renderBulk();
  }

  // ── 요약 ────────────────────────────────────────────────────────────────
  function bars(items, total) {
    const max = Math.max(1, ...items.map(x => x[1]));
    return h('div', { class: 'bars' }, items.map(([label, n, tip]) => h('div', { class: 'bar-row' },
      h('span', { class: 'bar-label', title: tip || label }, label),
      h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: `width:${(n / max) * 100}%` })),
      h('span', { class: 'bar-num' }, `${n.toLocaleString('ko-KR')}건`, h('span', { class: 'muted' }, ` ${((n / total) * 100).toFixed(1)}%`)))));
  }

  function countBy(list, key) {
    const m = new Map();
    for (const x of list) m.set(key(x), (m.get(key(x)) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  // 최종한도 구간: 0원은 따로, 나머지는 구간이 12개 이하가 되는 단위(100만·200만·500만·1,000만…)로 나눈다
  function limitBuckets(list) {
    const finals = list.filter(x => x.status === 'ok').map(x => x.final);
    if (!finals.length) return [];
    const max = Math.max(...finals);
    const step = [1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8].find(st => Math.ceil(max / st) <= 12) || 1e8;
    const out = [['0원', finals.filter(v => v <= 0).length]];
    for (let lo = 0; lo < max; lo += step) out.push([`${man(lo)} ~ ${man(lo + step)}`, finals.filter(v => v > lo && v <= lo + step).length, `${man(lo)} 초과 ~ ${man(lo + step)} 이하`]);
    return out;
  }

  function median(xs) { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }

  function summary(list) {
    const ok = list.filter(x => x.status === 'ok'), n = list.length;
    const finals = ok.map(x => x.final);
    const stat = (label, v, cls) => h('div', { class: `stat ${cls || ''}` }, h('span', { class: 'muted small' }, label), h('strong', {}, v));
    const cnt = (st) => list.filter(x => x.status === st).length;
    return h('div', {},
      h('div', { class: 'stats' },
        stat('전체', `${n.toLocaleString('ko-KR')}건`),
        stat('정상', `${cnt('ok').toLocaleString('ko-KR')}건`, 'ok'),
        stat('거절', `${cnt('reject').toLocaleString('ko-KR')}건`, 'danger'),
        stat('오류·입력 오류', `${(cnt('error') + cnt('input')).toLocaleString('ko-KR')}건`, 'warn'),
        stat('평균 한도(정상)', finals.length ? money(finals.reduce((a, b) => a + b, 0) / finals.length) : '—'),
        stat('중앙값 한도(정상)', finals.length ? money(median(finals)) : '—')),
      h('div', { class: 'dist-grid' },
        h('div', {}, h('div', { class: 'dist-title' }, '최종한도 분포(정상 건)'), finals.length ? bars(limitBuckets(list), ok.length) : h('div', { class: 'muted' }, '정상 건이 없습니다')),
        h('div', {}, h('div', { class: 'dist-title' }, '결정요인'), ok.length ? bars(countBy(ok, x => x.det || '—'), ok.length) : h('div', { class: 'muted' }, '—')),
        h('div', {}, h('div', { class: 'dist-title' }, '거절 사유'), cnt('reject') ? bars(countBy(list.filter(x => x.status === 'reject'), x => x.det), cnt('reject')) : h('div', { class: 'muted' }, '거절 없음'))));
  }

  // ── 이 건 보기 ──────────────────────────────────────────────────────────
  function view(index, backTab) {
    const cs = cols();
    const go = (i) => {
      const row = data.rows[i];
      const { inputs, warnings, errors } = E.rowInputs(S.strategy, cs, currentMapping(), row);
      S.setView({
        label: data.fileName, index: i, count: data.rows.length, id: rowId(row, i),
        inputs, warnings: errors.length ? [...errors, '입력 오류가 있어 기본값으로 계산했습니다'] : warnings,
        nav: (d) => go(Math.min(Math.max(i + d, 0), data.rows.length - 1)), back: backTab,
      });
    };
    go(index);
    root.App.showTab('process');
  }

  // ── 결과 표·내려받기 ────────────────────────────────────────────────────
  function resultTable(list, onRow) {
    const shown = list.slice(0, SHOW_MAX);
    return h('div', {},
      h('div', { class: 'table-scroll bulk-table' }, h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ['#', '건 ID', '상태', '최종한도', '결정요인·거절 사유', '알림'].map(x => h('th', {}, x)))),
        h('tbody', {}, shown.map((x) => h('tr', { class: 'clickable', title: '눌러서 이 건의 단계별 계산 보기', onclick: () => onRow(list.indexOf(x)) },
          h('td', { class: 'muted' }, list.indexOf(x) + 1), h('td', {}, x.id),
          h('td', {}, h('span', { class: `badge badge-${statusBadge[x.status]}` }, statusText[x.status])),
          h('td', { class: 'num' }, x.final === null ? '—' : money(x.final)),
          h('td', {}, x.det || '—'),
          h('td', { class: 'small muted' }, [...x.errors, ...x.warnings].slice(0, 2).join(' · ') + ([...x.errors, ...x.warnings].length > 2 ? ' …' : ''))))))),
      list.length > SHOW_MAX ? h('div', { class: 'hint' }, `처음 ${SHOW_MAX}건만 보여 줍니다. 전체는 결과 내려받기로 확인하세요.`) : null);
  }

  function downloadBulk() {
    const s = S.strategy;
    const { order } = E.order(s);
    const nodes = order.map(id => s.nodes.find(n => n.id === id));
    const head = [...data.headers, '상태', '최종한도', '결정요인·거절 사유', '오류·알림', ...nodes.map(n => `[단계] ${n.name}`)];
    const rows = data.rows.map((row, i) => {
      const x = bulk.rows[i];
      return [...data.headers.map((_, j) => row[j] ?? null), statusText[x.status], x.final, x.det, [...x.errors, ...x.warnings].join(' / '),
        ...nodes.map(n => (x.values && n.id in x.values ? x.values[n.id] : null))];
    });
    const wb = XLSX().utils.book_new();
    const ws = XLSX().utils.aoa_to_sheet([head, ...rows]);
    ws['!cols'] = head.map(x => ({ wch: Math.min(28, Math.max(10, String(x).length * 2)) }));
    XLSX().utils.book_append_sheet(wb, ws, '결과');
    XLSX().writeFile(wb, `${safe(s.meta.name)}_대량결과.xlsx`);
  }

  // ── 대량 시뮬레이션 탭 ──────────────────────────────────────────────────
  function renderBulk() {
    if (!bulkHost) return;
    clear(bulkHost);
    const cs = cols();
    bulkHost.appendChild(h('div', { class: 'stage-note' }, h('strong', {}, '가상 데이터 전용'), ' — 고객 개인신용정보를 올리지 마세요. 올린 파일은 이 브라우저 안에서만 계산하고 서버·임시저장에 남기지 않습니다(새로고침하면 사라짐).'));

    bulkHost.appendChild(section('1. 양식',
      h('div', { class: 'hint' }, `지금 전략의 입력 열 ${cs.length}개(고객 입력값 ${cs.filter(c => !c.debt).length}개 + 부채표 잔액 ${cs.filter(c => c.debt).length}개)와 "건 ID" 열로 된 엑셀입니다. "설명" 시트에 열마다 형태를 적어 두었습니다.`),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => downloadTemplate(false) }, '빈 양식 내려받기'),
        h('button', { class: 'btn', type: 'button', onclick: () => downloadTemplate(true) }, S.strategy.samples && S.strategy.samples.length ? `예시 케이스 ${S.strategy.samples.length}건 채운 양식` : '테스트 입력값 1건 채운 양식'))));

    const up = section('2. 데이터 올리기',
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: pickFile }, data ? '다른 파일 올리기' : '엑셀·CSV 올리기'),
        data ? h('span', { class: 'muted' }, `${data.fileName} · ${data.rows.length.toLocaleString('ko-KR')}건 · 열 ${data.headers.length}개`) : null));
    bulkHost.appendChild(up);
    if (!data) return;

    const map = currentMapping();
    const missing = cs.filter(c => map[c.key] < 0);
    const mapTable = h('table', { class: 'grid map-table' },
      h('thead', {}, h('tr', {}, ['전략 입력', '형태', '엑셀 열'].map(x => h('th', {}, x)))),
      h('tbody', {}, cs.map(c => {
        const sel = h('select', {}, h('option', { value: '-1' }, c.debt ? '(없음 — 잔액 0)' : '(없음 — 기본값)'), data.headers.map((x, i) => h('option', { value: String(i) }, x || `(제목 없음 ${i + 1})`)));
        sel.value = String(map[c.key]);
        sel.addEventListener('change', () => { mapping[c.key] = Number(sel.value); bulk = null; cmp = null; renderBulk(); renderCompare(); });
        return h('tr', { class: map[c.key] < 0 ? 'unmapped' : '' }, h('td', {}, c.label), h('td', { class: 'muted small' }, E.VAR_TYPES[c.type] || c.type), h('td', {}, sel));
      })));
    up.appendChild(h('details', { class: 'map-box', open: missing.length > 0 && missing.length < cs.length },
      h('summary', {}, missing.length ? `열 맞춤 — ${missing.length}개 열이 엑셀에 없습니다(비어 있는 것으로 계산)` : '열 맞춤 — 모든 입력 열을 찾았습니다'),
      h('div', { class: 'table-scroll' }, mapTable)));

    const runBox = section('3. 일괄 계산',
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', disabled: busy, onclick: runBulk }, bulk ? '다시 계산' : '일괄 계산'),
        bulk ? h('button', { class: 'btn', type: 'button', onclick: downloadBulk }, '결과 내려받기(엑셀)') : null,
        h('span', { class: 'bulk-progress muted' }, bulk && bulk.stamp !== S.strategy.meta.updated ? '전략이 바뀌었습니다 — 다시 계산하세요' : '')));
    bulkHost.appendChild(runBox);
    if (!bulk) return;
    runBox.append(summary(bulk.rows), h('div', { class: 'dist-title' }, '건별 결과 — 누르면 프로세스 탭에서 그 건을 봅니다'), resultTable(bulk.rows, (i) => view(i, 'bulk')));
  }

  // ── 전략 비교 탭 ────────────────────────────────────────────────────────
  function fixBase() {
    base = { strategy: S.clone(S.strategy), label: S.strategy.meta.name, at: new Date() };
    cmp = null;
    root.App.flash(`[${base.label}]을(를) 비교 기준으로 고정했습니다. 이제 전략을 고친 뒤 비교하세요.`, 'ok');
    renderCompare();
  }

  function loadBase() { fileInput('cmp-file', '.json,application/json', onBaseFile).click(); }

  // 서버에 저장된 전략(내 전략·팀 전략의 아무 버전)을 비교 기준으로
  async function pickServerBase() {
    const got = await root.Cloud.pickStrategy('비교 기준(A)으로 쓸 서버 전략 고르기');
    if (!got) return;
    E.migrate(got.strategy);
    base = { strategy: got.strategy, label: got.label, at: new Date() };
    cmp = null;
    renderCompare();
  }

  async function onBaseFile(f) {
    try {
      const st = JSON.parse(await f.text());
      if (!st || !Array.isArray(st.nodes) || !Array.isArray(st.variables)) throw new Error('한도 시뮬레이터 전략 파일이 아닙니다');
      E.migrate(st);
      base = { strategy: st, label: `${st.meta && st.meta.name || f.name} (${f.name})`, at: new Date() };
      cmp = null;
    } catch (e) { root.App.flash(`비교 기준을 읽지 못했습니다: ${e.message}`, 'danger'); }
    renderCompare();
  }

  // 비교 기준(A)의 열 맞춤: 지금 전략에서 고른 열 맞춤을 같은 이름의 열에 그대로 쓰고, 나머지는 이름으로 자동
  function baseMapping() {
    const cur = currentMapping();
    const byLabel = new Map(cols().map(c => [c.label, cur[c.key]]));
    const bc = E.inputColumns(base.strategy);
    const auto = E.autoMap(bc, data.headers);
    return Object.fromEntries(bc.map(c => [c.key, byLabel.has(c.label) ? byLabel.get(c.label) : auto[c.key]]));
  }

  async function runCompare() {
    if (busy || !data || !base) return;
    busy = true;
    const prog = cmpHost.querySelector('.bulk-progress');
    try {
      const total = data.rows.length;
      const a = await runAll(base.strategy, baseMapping(), false, (n) => { if (prog) prog.textContent = `기준(A) 계산 중… ${n.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')}건`; });
      const b = await runAll(S.strategy, currentMapping(), false, (n) => { if (prog) prog.textContent = `지금 전략(B) 계산 중… ${n.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')}건`; });
      cmp = { stamp: S.strategy.meta.updated, rows: a.map((x, i) => ({ id: x.id, index: i, a: x, b: b[i], diff: (b[i].final ?? 0) - (x.final ?? 0) })) };
    } finally { busy = false; }
    renderCompare();
  }

  function cmpSummary(rows) {
    const n = rows.length;
    const okA = rows.filter(r => r.a.status === 'ok'), okB = rows.filter(r => r.b.status === 'ok');
    const sum = (xs, k) => xs.reduce((s, r) => s + (r[k].final || 0), 0);
    const stat = (label, v, cls) => h('div', { class: `stat ${cls || ''}` }, h('span', { class: 'muted small' }, label), h('strong', {}, v));
    const up = rows.filter(r => r.diff > 0).length, down = rows.filter(r => r.diff < 0).length;
    const toReject = rows.filter(r => r.a.status !== 'reject' && r.b.status === 'reject').length;
    const fromReject = rows.filter(r => r.a.status === 'reject' && r.b.status !== 'reject').length;
    // 결정요인 변화 표(A → B). 거절은 "거절"로 묶는다
    const key = (x) => (x.status === 'reject' ? '거절' : x.status === 'ok' ? (x.det || '—') : statusText[x.status]);
    const aKeys = countBy(rows, r => key(r.a)).slice(0, 8).map(x => x[0]);
    const bKeys = countBy(rows, r => key(r.b)).slice(0, 8).map(x => x[0]);
    const cell = (ka, kb) => rows.filter(r => key(r.a) === ka && key(r.b) === kb).length;
    return h('div', {},
      h('div', { class: 'stats' },
        stat('전체', `${n.toLocaleString('ko-KR')}건`),
        stat('한도 증가', `${up.toLocaleString('ko-KR')}건`, 'ok'),
        stat('한도 감소', `${down.toLocaleString('ko-KR')}건`, 'danger'),
        stat('변화 없음', `${(n - up - down).toLocaleString('ko-KR')}건`),
        stat('평균 한도 A → B(정상)', `${okA.length ? man(sum(okA, 'a') / okA.length) : '—'} → ${okB.length ? man(sum(okB, 'b') / okB.length) : '—'}`),
        stat('한도 합계 A → B', `${man(sum(rows, 'a'))} → ${man(sum(rows, 'b'))}`),
        stat('새로 거절 / 거절 해제', `${toReject.toLocaleString('ko-KR')} / ${fromReject.toLocaleString('ko-KR')}건`, 'warn')),
      h('div', { class: 'dist-title' }, '결정요인 변화 (줄 = 기준 A, 칸 = 지금 전략 B, 칸 안 = 건수)'),
      h('div', { class: 'table-scroll' }, h('table', { class: 'grid matrix-count' },
        h('thead', {}, h('tr', {}, h('th', {}, 'A \\ B'), bKeys.map(k => h('th', {}, k)))),
        h('tbody', {}, aKeys.map(ka => h('tr', {}, h('th', {}, ka), bKeys.map(kb => {
          const c = cell(ka, kb);
          return h('td', { class: `num${ka === kb ? ' same' : ''}${c ? '' : ' muted'}` }, c ? c.toLocaleString('ko-KR') : '·');
        })))))));
  }

  function downloadCompare() {
    const head = ['건 ID', 'A 상태', 'A 최종한도', 'A 결정요인·사유', 'B 상태', 'B 최종한도', 'B 결정요인·사유', '차이(B − A)'];
    const rows = cmp.rows.map(r => [r.id, statusText[r.a.status], r.a.final, r.a.det, statusText[r.b.status], r.b.final, r.b.det, r.diff]);
    const wb = XLSX().utils.book_new();
    const ws = XLSX().utils.aoa_to_sheet([
      [`기준 A: ${base.label}`], [`지금 전략 B: ${S.strategy.meta.name}`], [`데이터: ${data.fileName}`], [], head, ...rows]);
    ws['!cols'] = head.map(() => ({ wch: 18 }));
    XLSX().utils.book_append_sheet(wb, ws, '비교');
    XLSX().writeFile(wb, `${safe(S.strategy.meta.name)}_전략비교.xlsx`);
  }

  function renderCompare() {
    if (!cmpHost) return;
    clear(cmpHost);
    cmpHost.appendChild(h('div', { class: 'stage-note' }, '같은 가상 데이터에 ', h('strong', {}, '비교 기준(A)'), '과 ', h('strong', {}, '지금 전략(B)'), '을 돌려 건별 한도 차이와 결정요인 변화를 봅니다. 데이터는 대량 시뮬레이션 탭에 올린 것을 씁니다.'));

    cmpHost.appendChild(section('비교할 두 전략',
      h('div', { class: 'cmp-pair' },
        h('div', { class: 'cmp-side' }, h('div', { class: 'muted small' }, '비교 기준 (A)'),
          h('div', { class: 'cmp-name' }, base ? base.label : '아직 없음'),
          base ? h('div', { class: 'muted small' }, `${String(base.at.getHours()).padStart(2, '0')}:${String(base.at.getMinutes()).padStart(2, '0')} 고정 · 이 브라우저를 닫으면 사라집니다`) : null,
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn btn-small', type: 'button', onclick: fixBase }, '지금 전략을 기준으로 고정'),
            h('button', { class: 'btn btn-small', type: 'button', onclick: pickServerBase }, '서버 전략에서 고르기'),
            h('button', { class: 'btn btn-small', type: 'button', onclick: loadBase }, '파일에서 불러오기'))),
        h('div', { class: 'cmp-arrow' }, '→'),
        h('div', { class: 'cmp-side' }, h('div', { class: 'muted small' }, '지금 전략 (B)'), h('div', { class: 'cmp-name' }, S.strategy.meta.name)))));

    if (!data) { cmpHost.appendChild(h('div', { class: 'empty' }, '대량 시뮬레이션 탭에서 가상 데이터를 먼저 올리세요.')); return; }
    if (!base) { cmpHost.appendChild(h('div', { class: 'empty' }, '비교 기준(A)을 정하세요 — 지금 전략을 고정(파라미터를 바꾼 뒤 비교), 서버에 저장된 전략, 또는 파일')); return; }

    const box = section('비교 계산',
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-primary', type: 'button', disabled: busy, onclick: runCompare }, cmp ? '다시 비교' : `비교 계산 (${data.fileName} · ${data.rows.length.toLocaleString('ko-KR')}건)`),
        cmp ? h('button', { class: 'btn', type: 'button', onclick: downloadCompare }, '비교 결과 내려받기(엑셀)') : null,
        h('span', { class: 'bulk-progress muted' }, cmp && cmp.stamp !== S.strategy.meta.updated ? '지금 전략이 바뀌었습니다 — 다시 비교하세요' : '')));
    cmpHost.appendChild(box);
    if (!cmp) return;
    const sorted = [...cmp.rows].sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
    box.append(cmpSummary(cmp.rows),
      h('div', { class: 'dist-title' }, '건별 차이(차이가 큰 순) — 누르면 지금 전략(B)으로 그 건을 봅니다'),
      h('div', { class: 'table-scroll bulk-table' }, h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ['건 ID', 'A 최종한도', 'A 결정요인', 'B 최종한도', 'B 결정요인', '차이'].map(x => h('th', {}, x)))),
        h('tbody', {}, sorted.slice(0, SHOW_MAX).map(r => h('tr', { class: 'clickable', onclick: () => view(r.index, 'compare') },
          h('td', {}, r.id),
          h('td', { class: 'num' }, r.a.final === null ? statusText[r.a.status] : money(r.a.final)), h('td', {}, r.a.det || '—'),
          h('td', { class: 'num' }, r.b.final === null ? statusText[r.b.status] : money(r.b.final)), h('td', {}, r.b.det || '—'),
          h('td', { class: `num ${r.diff > 0 ? 'ok-text' : r.diff < 0 ? 'err' : 'muted'}` }, r.diff ? `${r.diff > 0 ? '+' : ''}${money(r.diff)}` : '0')))))),
      cmp.rows.length > SHOW_MAX ? h('div', { class: 'hint' }, `처음 ${SHOW_MAX}건만 보여 줍니다. 전체는 비교 결과 내려받기로 확인하세요.`) : null);
  }

  // openDataFile·openBaseFile: 파일 선택 창 없이 File을 넘기는 입구(끌어다 놓기·자동 점검용)
  root.Bulk = { mount, openDataFile: onDataFile, openBaseFile: onBaseFile, get data() { return data; } };
})(typeof self !== 'undefined' ? self : this);
