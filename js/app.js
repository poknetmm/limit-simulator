/* ============================================================================
   화면 뼈대 — 상단 막대, 왼쪽 패널(단계 팔레트·전략 파일), 탭, 오른쪽 단계별 계산결과, 하단 상태 막대
   프로세스 탭은 canvas.js(도형 캔버스) + panel.js(설정 패널)가 맡는다.
   ========================================================================== */
(function (root) {
  'use strict';
  const E = root.LimitEngine, S = root.Store, D = root.Describe, { h, clear, numberField } = root.UI;
  const $ = (sel) => document.querySelector(sel);

  const TAB_KEY = 'limitsim.tab';
  const PANEL_KEY = { menu: 'limitsim.panel.menu', results: 'limitsim.panel.results' };

  // ── 계산 ────────────────────────────────────────────────────────────────
  function compute() {
    try { return E.evaluate(S.strategy, S.evalInputs()); }
    catch (e) { return { status: 'error', final: null, steps: {}, errors: [`계산 중 예상하지 못한 오류: ${e.message}`] }; }
  }

  // ── 상단 막대 ───────────────────────────────────────────────────────────
  function renderTopbar() {
    const title = $('#strategyTitle');
    title.textContent = S.strategy.meta.name;
    title.title = `${S.strategy.meta.name} — 눌러서 전략 목록 열기. 이름은 저장할 때 정합니다`;
    // 상태 막대: 저장하지 않은 변경이 있을 때만 알린다. 브라우저 임시저장이 막혔으면 그것도 알린다
    const dirty = S.hasUnexported() || S.state.saveFailed;
    const dot = $('#dirtyDot');
    dot.hidden = !dirty;
    dot.textContent = S.state.saveFailed ? '브라우저 임시저장 막힘' : '저장하지 않은 변경 있음';
    dot.title = S.state.saveFailed ? '브라우저 임시저장이 막혀 있습니다(브라우저 설정) — 서버나 파일로 저장하세요' : '저장하지 않은 변경이 있습니다 — 서버에 저장하거나 로컬 PC에 저장하세요';
    if (root.Cloud) root.Cloud.renderBadge($('#cloudState'));
    // 점: 서버에 저장되어 있고 바뀐 것이 없으면 초록, 아니면 주황
    $('#led').classList.toggle('ok', !!S.state.cloud && !dirty);
  }

  // ── 새로 만들기·열기 전 확인 ─────────────────────────────────────────────
  function guard(action, label) {
    if (!S.hasUnexported()) { action(); return; }
    const bar = $('#confirmBar');
    const canCloud = root.Cloud && root.Cloud.canSave();
    clear(bar).append(
      h('span', {}, `지금 전략에 저장하지 않은 변경이 있습니다. "${label}"을(를) 진행하면 브라우저 임시저장본이 바뀌어 지금 내용은 사라집니다.`),
      canCloud ? h('button', { class: 'btn btn-primary', onclick: async () => { bar.hidden = true; if (await root.Cloud.save()) action(); } }, '서버에 저장한 뒤 계속') : null,
      h('button', { class: 'btn', onclick: () => { bar.hidden = true; exportDialog(action); } }, '로컬 PC에 저장한 뒤 계속'),
      h('button', { class: 'btn btn-danger', onclick: () => { bar.hidden = true; action(); } }, '저장하지 않고 계속'),
      h('button', { class: 'btn', onclick: () => { bar.hidden = true; } }, '취소'));
    bar.hidden = false;
  }

  // 로컬 PC에 저장(내보내기): 창에서 정한 이름으로 .json을 내려받는다. 열린 전략의 이름은 바꾸지 않는다
  function exportDialog(after) {
    const name = h('input', { type: 'text', class: 'login-input', value: S.strategy.meta.name, maxlength: '80', 'aria-label': '파일 이름' });
    const err = h('div', { class: 'field-error' });
    const form = h('form', { class: 'login-form' },
      h('div', {}, '파일 이름을 정하세요. 다운로드 폴더에 .json으로 저장됩니다.'), name, err,
      h('button', { class: 'btn btn-primary', type: 'submit' }, '로컬 PC에 저장'));
    const m = root.UI.modal('로컬 PC에 저장(내보내기)', form);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const v = name.value.trim();
      if (!v) { err.textContent = '이름을 입력하세요'; return; }
      S.exportJson(v);
      m.close();
      flash(`"${v}.json"으로 내보냈습니다 (다운로드 폴더)`, 'ok');
      if (after) after();
    });
    name.select();
  }

  function pickFile() {
    const input = $('#importFile');
    input.value = '';
    input.onchange = () => {
      const f = input.files[0];
      if (!f) return;
      f.text().then(text => {
        const err = S.importJson(text);
        if (err) flash(err, 'danger');
        else flash(`[${S.strategy.meta.name}] 전략을 불러왔습니다${migratedNote()}`, 'ok');
      });
    };
    input.click();
  }

  function migratedNote() {
    const n = S.state.migrated;
    return n ? ` — 옛 형식 단계 ${n}개를 바꿨습니다(같은 결과가 나오게 — 부채 집계 → 부채표 합계 바로 고르기, 현가계수 → 사칙연산, 기초한도 → 줄 단위 식 등)` : '';
  }

  // 알림: 상태 막대 위 가운데에 캐릭터 얼굴과 함께 4초 띄운다(성공 = 기쁨, 실패 = 걱정)
  let flashTimer;
  function flash(msg, kind) {
    const el = $('#flash');
    const mood = kind === 'ok' ? 'happy' : kind === 'danger' ? 'worry' : '';
    clear(el).append(root.Fx.face(mood), h('span', {}, msg));
    el.className = `flash flash-${kind || 'info'}`;
    el.hidden = false;
    root.Fx.replay(el, 'flash-in');
    if (kind === 'ok') root.Fx.mood('happy', 1400);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  // ── 탭 ──────────────────────────────────────────────────────────────────
  // 다른 탭으로 옮기면 열어 둔 편집 창(단계 설정·변수 편집)을 닫아, 돌아왔을 때 아무것도 누르지 않은 화면이 나온다.
  // 저장하지 않은 편집이 있으면 먼저 묻는다(예 = 버리고 이동, 아니오 = 남기). after는 이동이 확정된 뒤에 부른다
  let currentTab = null;
  function showTab(name, after) {
    const moving = currentTab !== null && currentTab !== name;
    const go = () => {
      if (moving) { root.Panel.discard(); root.Canvas.select(null); root.VarsTab.close(true); }
      currentTab = name;
      document.querySelectorAll('.tab').forEach(b => {
        const on = b.dataset.tab === name;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on);
      });
      document.querySelectorAll('.tabpanel').forEach(p => { p.hidden = p.id !== `tab-${name}`; });
      try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* 저장 못 해도 동작에는 지장 없음 */ }
      if (after) after();
    };
    if (!(moving && (root.Panel.dirty || root.VarsTab.dirty))) { go(); return; }
    let m;
    const no = h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, '아니오');
    m = root.UI.modal('저장하지 않은 변경', h('div', {},
      h('div', {}, '편집 창에 저장하지 않은 변경이 있습니다. 저장하지 않고 이동할까요?'),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-danger', type: 'button', onclick: () => { m.close(); go(); } }, '예'), no)));
    no.focus();
  }

  // ── 오른쪽: 테스트 입력값 + 단계별 계산결과 ─────────────────────────────
  // 이 건 보기 중에는 그 건의 입력값을 읽기 전용으로 보여 준다(테스트 입력값은 그대로 보존)
  function renderViewInputs(host, view) {
    const s = S.strategy;
    const inputs = view.inputs;
    host.appendChild(h('div', { class: 'muted small' }, '보고 있는 건의 입력값입니다(읽기 전용). "끝내기"를 누르면 테스트 입력값으로 돌아갑니다.'));
    for (const v of s.variables.filter(x => x.kind === 'input' && x.type !== 'table' && x.type !== 'debt')) {
      const has = Object.prototype.hasOwnProperty.call(inputs, v.id);
      const val = has ? inputs[v.id] : v.value;
      const text = v.type === 'bool' ? (val ? '예' : '아니오') : v.type === 'choice' ? String(val) : E.fmtValue(E.toNum(val) ?? val, v.type);
      host.appendChild(h('div', { class: 'input-row' }, h('span', { class: 'input-label' }, v.name),
        h('span', { class: `view-val${has ? '' : ' muted'}`, title: has ? '' : '엑셀에 없어 기본값을 썼습니다' }, has ? text : `${text} (기본값)`)));
    }
    for (const v of s.variables.filter(x => x.type === 'debt')) {
      const bal = inputs[v.id] || v.rows.map(() => 0);
      const used = v.rows.map((r, i) => [r, bal[i]]).filter(([, b]) => b);
      host.appendChild(h('div', { class: 'debt-inputs' }, h('div', { class: 'debt-inputs-title' }, `${v.name} — 잔액이 있는 행`),
        used.length ? h('table', {}, h('tbody', {}, used.map(([r, b]) => h('tr', {}, h('th', {}, `${r.sector} · ${r.kind}`), h('td', { class: 'view-val' }, E.fmtValue(b, 'money'))))))
          : h('div', { class: 'muted small' }, '없음')));
    }
    if (view.warnings && view.warnings.length) host.appendChild(h('div', { class: 'muted small' }, view.warnings.join(' · ')));
  }

  function renderViewBar() {
    const bar = $('#viewBar');
    const v = S.state.view;
    bar.hidden = !v;
    if (!v) return;
    clear(bar).append(
      h('span', { class: 'view-title' }, h('strong', {}, v.label), ` — ${v.index + 1} / ${v.count}번째 건`, v.id ? h('span', { class: 'badge badge-neutral' }, v.id) : null, ' 보는 중'),
      h('button', { class: 'btn btn-small', type: 'button', disabled: v.index <= 0, onclick: () => v.nav(-1) }, '◀ 이전'),
      h('button', { class: 'btn btn-small', type: 'button', disabled: v.index >= v.count - 1, onclick: () => v.nav(1) }, '다음 ▶'),
      h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => { const back = v.back; S.setView(null); if (back) showTab(back); } }, '끝내기'));
  }

  function renderInputs() {
    const host = clear($('#testInputs'));
    if (S.state.view) { renderViewInputs(host, S.state.view); return; }
    const inputs = S.strategy.variables.filter(v => v.kind === 'input' && v.type !== 'table' && v.type !== 'debt');
    if (!inputs.length && !S.strategy.variables.some(v => v.type === 'debt')) { host.appendChild(h('div', { class: 'muted small' }, '고객 입력값이 없습니다. 변수·표 탭에서 만드세요.')); return; }
    const set = (id, val) => S.update(s => { s.variables.find(v => v.id === id).value = val; }, 'test-input');
    for (const v of inputs) {
      let control;
      if (v.type === 'bool') {
        const cb = h('input', { type: 'checkbox', checked: !!v.value, id: `ti_${v.id}` });
        cb.addEventListener('change', () => set(v.id, cb.checked));
        control = h('label', { class: 'check', for: `ti_${v.id}` }, cb, ' 예');
      } else if (v.type === 'choice') {
        control = h('select', {}, (v.options || []).map(o => h('option', { value: o }, o)));
        control.value = v.value;
        control.addEventListener('change', () => set(v.id, control.value));
      } else {
        control = numberField(v.value, v.type, (n) => set(v.id, n ?? 0));
      }
      host.appendChild(h('div', { class: 'input-row', title: v.desc || '' }, h('span', { class: 'input-label' }, v.name), control));
    }
    // 부채표: 잔액 입력칸을 업권(줄) × 대출구분(칸) 격자로
    for (const v of S.strategy.variables.filter(x => x.type === 'debt')) {
      const sectors = [...new Set(v.rows.map(r => r.sector))], kinds = [...new Set(v.rows.map(r => r.kind))];
      const cell = (sector, kind) => {
        const i = v.rows.findIndex(r => r.sector === sector && r.kind === kind);
        if (i < 0) return h('td', { class: 'muted small' }, '—');
        return h('td', {}, numberField(v.rows[i].balance || 0, 'money', (n) => S.update(s => { s.variables.find(x => x.id === v.id).rows[i].balance = n ?? 0; }, 'test-input'),
          { 'aria-label': `${sector} ${kind} 잔액`, title: `${sector} · ${kind} 잔액(원)` }));
      };
      host.appendChild(h('div', { class: 'debt-inputs', title: v.desc || '' },
        h('div', { class: 'debt-inputs-title' }, `${v.name} — 잔액(원)`),
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, ''), kinds.map(k => h('th', {}, k)))),
          h('tbody', {}, sectors.map(sec => h('tr', {}, h('th', {}, sec), kinds.map(k => cell(sec, k))))))));
    }
  }

  // 최종한도가 바뀌면 숫자를 굴리고(카운트업), 상태가 바뀌면 배지가 한 번 튀고 캐릭터가 반응한다
  let lastFinal = null, lastStatus = null;
  function renderResults() {
    const r = compute();
    const s = S.strategy;
    const card = clear($('#finalCard'));
    const fid = r.finalNodeId && s.nodes.find(n => n.id === r.finalNodeId);
    const fmt = (v) => E.fmtValue(v, fid ? fid.format : 'money');
    const statusBadge = r.status === 'ok' ? ['정상 산출', 'ok'] : r.status === 'reject' ? ['대출 거절', 'danger'] : ['확인 필요', 'warn'];
    const badge = h('span', { class: `badge badge-${statusBadge[1]}` }, statusBadge[0]);
    const value = h('div', { class: 'final-value' }, r.final === null ? '—' : fmt(r.final));
    card.append(
      h('div', { class: 'final-label' }, fid ? fid.name : '최종한도', ' ', badge),
      value,
      h('div', { class: 'final-det' }, h('span', { class: 'muted' }, r.status === 'reject' ? '거절 사유 ' : '결정요인 '), r.determinant || '—'));
    if (lastStatus !== null) {
      if (r.final !== null && lastFinal !== null && r.final !== lastFinal) root.Fx.countTo(value, lastFinal, r.final, fmt);
      if (r.status !== lastStatus) {
        root.Fx.replay(badge, 'pop');
        root.Fx.mood(r.status === 'ok' ? 'happy' : r.status === 'reject' ? 'worry' : 'think', r.status === 'ok' ? 1400 : 0);
      } else if (r.status === 'ok' && r.final !== lastFinal) root.Fx.mood('happy', 1400);
    }
    lastFinal = r.final; lastStatus = r.status;
    root.Fx.say(r.status === 'ok' ? `한도가 나왔어요! 결정요인은 ${r.determinant || '—'}이에요`
      : r.status === 'reject' ? `대출 거절이에요 — ${r.determinant || '사유를 확인하세요'}`
      : '확인이 필요한 단계가 있어요. 빨간 도형을 눌러 보세요');

    const issues = clear($('#issues'));
    const all = [...new Set([...E.validate(s), ...r.errors])];
    if (all.length) issues.appendChild(h('ul', { class: 'issue-list' }, all.map(m => h('li', {}, m))));

    // 상태 막대: 단계 수 · 오류 수 · 최종한도
    $('#stCount').textContent = s.nodes.length;
    $('#stErr').textContent = all.length;
    $('#stErrWrap').classList.toggle('err', all.length > 0);
    $('#stFinal').textContent = r.status === 'reject' ? '대출 거절' : r.final === null ? '—' : fmt(r.final);

    const list = clear($('#stepList'));
    const { order } = E.order(s);
    const byId = new Map(s.nodes.map(n => [n.id, n]));
    for (const id of order) {
      const n = byId.get(id);
      const st = r.steps[id] || {};
      const cls = ['step', st.active ? '' : 'inactive', st.error ? 'error' : '', id === r.finalNodeId ? 'final' : '', (st.triggered || st.chosen) ? 'mark' : ''].join(' ');
      // 누르면 프로세스 탭에서 그 도형을 고른다
      list.appendChild(h('li', { class: cls, title: D.describe(n), onclick: () => showTab('process', () => root.Canvas.select(id)) },
        h('span', { class: 'step-n' }, n.name),
        h('span', { class: 'step-v' }, D.stepValueText(n, st)),
        st.chosen ? h('div', { class: 'step-sub' }, `선택: ${st.chosen}`) : null,
        st.from ? h('div', { class: 'step-sub' }, `경로: ${st.from}`) : null,
        st.error ? h('div', { class: 'step-sub err' }, st.error) : null));
    }
    if (!order.length) list.appendChild(h('li', { class: 'muted small' }, '계산 단계가 없습니다.'));
  }

  // ── 좌우 패널 여닫기 — 처음엔 화면이 넓으면(1280px 이상) 열고, 사용자가 여닫은 상태는 기억한다 ──
  // 바뀌었으면 true(첫 방문 안내가 패널이 열리기를 기다린다)
  function setPanel(side, open, remember) {
    const cls = `${side}-open`, layout = $('#layout');
    if (remember) { try { localStorage.setItem(PANEL_KEY[side], open ? '1' : '0'); } catch (e) { /* 저장 못 해도 동작에는 지장 없음 */ } }
    if (layout.classList.contains(cls) === open) return false;
    layout.classList.toggle(cls, open);
    $(side === 'menu' ? '#toggleMenu' : '#toggleResults').setAttribute('aria-expanded', open);
    return true;
  }
  function bindToggle(side) {
    let saved = null;
    try { saved = localStorage.getItem(PANEL_KEY[side]); } catch (e) { /* 기본값 */ }
    setPanel(side, saved === null ? root.innerWidth >= 1280 : saved === '1');
    $(side === 'menu' ? '#toggleMenu' : '#toggleResults').addEventListener('click', () =>
      setPanel(side, !$('#layout').classList.contains(`${side}-open`), true));
  }

  // ── 되돌리기: 설정 패널에서 편집 중이면 그 편집부터, 아니면 전략의 마지막 수정을 취소한다 ──
  function undo() {
    if (root.Panel.undo()) return;
    if (S.undo()) flash('마지막 변경을 되돌렸습니다', 'info');
    else flash('되돌릴 변경이 없습니다', 'info');
  }

  function onUndoKey(ev) {
    if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey || ev.key.toLowerCase() !== 'z') return;
    // 글자 입력칸 안에서는 브라우저 기본 되돌리기(입력 중인 글자)를 쓴다
    if (ev.target.closest && ev.target.closest('input[type=text], textarea')) return;
    ev.preventDefault();
    undo();
  }

  // ── 시작 ────────────────────────────────────────────────────────────────
  function init() {
    document.addEventListener('keydown', onUndoKey);
    bindToggle('menu');
    bindToggle('results');
    // 왼쪽 패널 아이콘 탭: 단계 팔레트 / 전략 파일
    document.querySelectorAll('.side-tab').forEach(b => b.addEventListener('click', () => sideTab(b.dataset.side)));
    document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('#menuNew').addEventListener('click', () => guard(() => { S.newStrategy(); flash('새 전략을 만들었습니다', 'info'); }, '새로 만들기'));
    // 게시본에는 예시 전략 파일이 없다(예시는 서버의 전략으로 공유) — 그때는 메뉴를 숨긴다
    const hasExample = !!(root.LIMIT_EXAMPLES && root.LIMIT_EXAMPLES.length);
    $('#menuExample').hidden = !hasExample;
    $('#menuExample').addEventListener('click', () => guard(() => { S.openExample(0); flash('예시 전략 사본을 열었습니다', 'info'); }, '예시 전략 열기'));
    $('#menuImport').addEventListener('click', () => guard(pickFile, '파일 가져오기'));
    $('#menuExport').addEventListener('click', () => exportDialog());
    $('#topExport').addEventListener('click', () => exportDialog());
    $('#topSave').addEventListener('click', () => { if (root.Cloud.user) root.Cloud.save(); else flash('로그인한 뒤 서버에 저장할 수 있습니다', 'info'); });

    const draft = S.restoreDraft();
    if (draft) S.load(draft.strategy, 'load', draft.exportedAt, draft.cloud);
    else if (hasExample) S.openExample(0);
    else S.newStrategy();
    if (S.state.migrated) setTimeout(() => flash(`임시저장본을 열었습니다${migratedNote()}`, 'info'), 0);

    root.VarsTab.mount($('#tab-vars'));
    root.Canvas.mount($('#tab-process'));
    root.Bulk.mount($('#tab-bulk'), $('#tab-compare'));
    root.Cloud.mount(guard);
    S.subscribe((reason) => {
      renderTopbar();
      if (reason === 'saved' || reason === 'exported' || reason === 'canvas-move') return;
      if (reason === 'view') renderViewBar();
      if (reason !== 'test-input') renderInputs();
      renderResults();
    });
    renderTopbar();
    renderInputs();
    renderResults();

    let tab = 'process';
    try { tab = localStorage.getItem(TAB_KEY) || 'process'; } catch (e) { /* 기본 탭 */ }
    showTab(document.getElementById(`tab-${tab}`) ? tab : 'process');
  }

  // 왼쪽 패널의 탭을 보여 준다. open이면 패널도 연다(캔버스의 "단계 추가" 버튼이 팔레트를 연다)
  function sideTab(name, open) {
    document.querySelectorAll('.side-tab').forEach(b => {
      const on = b.dataset.side === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on);
    });
    $('#sidePalette').hidden = name !== 'palette';
    $('#sideFile').hidden = name !== 'file';
    if (open) setPanel('menu', true, true);
  }

  root.App = { flash, showTab, undo, guard, setPanel, sideTab };
  document.addEventListener('DOMContentLoaded', init);
})(typeof self !== 'undefined' ? self : this);
