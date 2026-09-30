/* ============================================================================
   변수·표 탭 — 변수 목록(위) + 선택한 변수 편집기(아래)
   편집은 변수 사본(draft)에 하고 [저장]을 눌러야 전략(목록·계산결과)에 반영된다. 저장하지 않고
   다른 변수를 누르거나 창을 닫으면 버린다(단계 설정 창과 같은 방식).
   엑셀 양식 내려받기·올리기: 변수·표·부채표를 엑셀 한 파일로 한꺼번에 올린다(이름으로 맞춰 덮어쓰기).
   ========================================================================== */
(function (root) {
  'use strict';
  const E = root.LimitEngine, S = root.Store, { h, clear, numberField } = root.UI;

  let host, listEl, editorEl, pop;
  let selectedId = null;
  let pendingDelete = null;
  let draft = null;            // 편집 중인 변수 사본
  let saveBtn, dirtyBadge;

  const SCALAR_TYPES = ['money', 'number', 'percent', 'choice', 'bool'];
  const isTableLike = (v) => v.type === 'table' || v.type === 'debt';

  // 새 부채표는 빈 줄 하나로 시작한다 — 업권별 기간·금리는 엑셀에서 붙여넣거나 서버의 전략에서 가져온다
  // (전략마다 다른 값이라 화면 코드에 기본값을 두지 않는다)
  const DEBT_DEFAULT = [['업권', '부동산 외', 12, 0]];
  const DEBT_KINDS = ['부동산', '부동산 외'];
  const KIND_LABEL = { input: '고객 입력값', param: '전략 파라미터' };

  // 목록은 뒤에서 스크롤되고, 편집 창은 아래에서 올라오는 팝업으로 항상 보인다
  function mount(el) {
    host = el;
    clear(host);
    const toolbar = h('div', { class: 'tab-toolbar' },
      h('button', { class: 'btn btn-primary', onclick: () => addVar('input') }, '+ 고객 입력값'),
      h('button', { class: 'btn', onclick: () => addVar('param') }, '+ 전략 파라미터'),
      h('button', { class: 'btn', onclick: addTable }, '+ 표'),
      h('button', { class: 'btn', onclick: addDebt }, '+ 부채표'),
      h('span', { class: 'toolbar-hint' }, '고객 입력값은 건마다 바뀌는 값, 전략 파라미터는 전략마다 고정된 값입니다'));
    const xlsxBar = h('div', { class: 'tab-toolbar' },
      h('button', { class: 'btn', type: 'button', onclick: () => downloadTemplate(false) }, '빈 양식 내려받기'),
      h('button', { class: 'btn', type: 'button', onclick: () => downloadTemplate(true) }, '지금 변수로 채운 양식'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: pickFile }, '엑셀 올리기'),
      h('span', { class: 'toolbar-hint' }, '엑셀 한 파일로 변수·표·부채표를 한꺼번에 올립니다. 같은 이름은 덮어쓰고 없는 이름은 추가합니다'));
    listEl = h('div', { class: 'var-list' });
    editorEl = h('div', { class: 'var-editor' });
    host.append(h('div', { class: 'vars-scroll' }, toolbar, xlsxBar, listEl), editorEl);
    pop = root.UI.slidePopup(editorEl, host);
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || !selectedId || host.hidden) return;
      if (ev.target.closest && ev.target.closest('input, textarea, select')) return;
      close();
    });
    S.subscribe(onChange);
    renderAll();
  }

  function onChange(reason) {
    if (reason === 'saved' || reason === 'exported' || reason === 'vars-save') return;
    if (reason === 'load' || reason === 'new' || reason === 'example' || reason === 'import') { selectedId = null; pendingDelete = null; draft = null; }
    if (selectedId && !stored()) { selectedId = null; draft = null; }
    // 편집 중이면 사본을 지키고 목록만 다시 그린다. 편집 전이면 바뀐 전략을 다시 받는다
    if (isDirty()) { renderList(); return; }
    draft = stored() ? S.clone(stored()) : null;
    renderAll();
  }

  function renderAll() {
    renderList();
    renderEditor();
    // 고른 줄이 편집 창에 가려지면 보이는 곳으로 올린다(scroll-padding으로 창 높이만큼 비켜 줌)
    const row = listEl.querySelector('tr.selected');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function vars() { return S.strategy.variables; }
  const stored = () => vars().find(v => v.id === selectedId) || null;
  const isDirty = () => !!draft && !!stored() && JSON.stringify(draft) !== JSON.stringify(stored());
  function selected() { return draft; }   // 편집기는 사본을 그린다

  // 변수를 열거나(id) 닫는다(null). 저장하지 않은 편집은 버린다 — quiet가 아니면 알린다
  function open(id, quiet) {
    if (isDirty() && !quiet) root.App.flash(`[${stored().name}]의 저장하지 않은 변경은 반영하지 않았습니다`, 'info');
    selectedId = id; pendingDelete = null;
    draft = stored() ? S.clone(stored()) : null;
    renderAll();
  }

  function save() {
    if (!isDirty()) return;
    const problem = S.nameProblem(draft.name, draft.id);
    if (problem) { root.App.flash(`저장하지 못했습니다 — ${problem}`, 'danger'); return; }
    const d = S.clone(draft);
    S.update(st => {
      const i = st.variables.findIndex(v => v.id === d.id);
      if (st.variables[i].name !== d.name) E.renameInFormulas(st, st.variables[i].name, d.name);
      st.variables[i] = d;
    }, 'vars-save');
    renderList();
    refreshState();
    root.App.flash(`[${d.name}]을(를) 저장했습니다`, 'ok');
  }

  function refreshState() {
    if (!saveBtn) return;
    const dirty = isDirty();
    saveBtn.disabled = !dirty;
    dirtyBadge.hidden = !dirty;
  }

  // ── 목록 ────────────────────────────────────────────────────────────────
  function summary(v) {
    if (v.type === 'table') {
      const r = v.rows.keys.length, c = v.cols ? v.cols.keys.length : 1;
      return v.cols ? `매트릭스 ${r}×${c}` : `${v.rows.mode === 'band' ? '구간표' : '목록표'} ${r}행`;
    }
    if (v.type === 'debt') {
      const with_ = v.rows.filter(r => r.balance).length;
      return `${v.rows.length}행 (업권 × 대출구분)${with_ ? ` · 테스트 잔액 ${with_}행` : ''}`;
    }
    if (v.type === 'bool') return v.value ? '예' : '아니오';
    if (v.type === 'choice') return `${v.value || '—'}  (${(v.options || []).join(' / ')})`;
    return E.fmtValue(v.value, v.type);
  }

  function renderList() {
    clear(listEl);
    const s = S.strategy;
    const groups = [
      ['고객 입력값', vars().filter(v => !isTableLike(v) && v.kind === 'input')],
      ['전략 파라미터', vars().filter(v => !isTableLike(v) && v.kind !== 'input')],
      ['표', vars().filter(v => v.type === 'table')],
      ['부채표', vars().filter(v => v.type === 'debt')],
    ];
    if (!vars().length) {
      listEl.appendChild(h('div', { class: 'empty' }, '아직 변수가 없습니다. 위 버튼으로 고객 입력값·전략 파라미터·표를 만드세요.'));
      return;
    }
    for (const [title, items] of groups) {
      if (!items.length) continue;
      const tbody = h('tbody');
      for (const v of items) {
        const refs = E.findReferences(s, v.id).length;
        tbody.appendChild(h('tr', {
          class: v.id === selectedId ? 'selected' : '',
          onclick: () => { if (v.id !== selectedId) open(v.id); },
        },
          h('td', { class: 'var-name' }, v.name),
          h('td', { class: 'var-type' }, E.VAR_TYPES[v.type]),
          h('td', { class: 'var-summary' }, summary(v)),
          h('td', { class: 'var-refs' }, refs ? `${refs}곳에서 사용` : h('span', { class: 'muted' }, '미사용'))));
      }
      listEl.appendChild(h('div', { class: 'var-group' },
        h('div', { class: 'var-group-title' }, title, h('span', { class: 'count' }, `${items.length}개`)),
        h('table', { class: 'grid var-table' }, tbody)));
    }
  }

  // ── 추가 ────────────────────────────────────────────────────────────────
  function addVar(kind) {
    const id = E.newId('v');
    S.update(s => s.variables.push({ id, name: S.uniqueName(kind === 'input' ? '새 입력값' : '새 파라미터'), kind, type: 'number', value: 0, desc: '' }), 'vars-add');
    open(id);
    focusName();
  }

  function addTable() {
    const id = E.newId('t');
    S.update(s => s.variables.push({
      id, name: S.uniqueName('새 표'), kind: 'param', type: 'table', desc: '',
      rows: { mode: 'band', keys: [0, 10] }, cols: null, cells: [[0], [0]],
    }), 'vars-add');
    open(id);
    focusName();
  }

  function addDebt() {
    const id = E.newId('d');
    S.update(s => s.variables.push({
      id, name: S.uniqueName('보유부채'), kind: 'input', type: 'debt', desc: '업권 × 대출구분별 잔액. 기간·금리는 전략값',
      rows: DEBT_DEFAULT.map(([sector, kind, months, rate]) => ({ sector, kind, months, rate, balance: 0 })),
    }), 'vars-add');
    open(id);
    focusName();
  }

  function focusName() {
    const el = editorEl.querySelector('.name-field');
    if (el) { el.focus(); el.select(); }
  }

  // 편집기에서의 수정 — 사본에만 한다([저장]해야 전략에 반영)
  function edit(fn) { fn(draft); refreshState(); }

  // ── 편집기 ──────────────────────────────────────────────────────────────
  function renderEditor() {
    const v = selected();
    // 닫을 때는 내용을 지우지 않는다 — 내려가는 동안 빈 상자가 보이지 않게
    if (!v) { pop.close(); return; }
    clear(editorEl);
    editorEl.appendChild(h('div', { class: 'editor-head' },
      h('div', { class: 'panel-title' }, v.type === 'table' ? '표 편집' : v.type === 'debt' ? '부채표 편집' : '변수 편집'),
      h('span', { class: 'spacer' }),
      dirtyBadge = h('span', { class: 'badge badge-warn' }, '저장 안 됨'),
      saveBtn = h('button', { class: 'btn btn-primary btn-small', type: 'button', title: '저장해야 전략에 반영됩니다. 저장하지 않고 닫거나 다른 변수를 누르면 버립니다', onclick: save }, '저장'),
      h('button', { class: 'btn-round', type: 'button', title: '닫기 (Esc) — 저장하지 않은 변경은 버립니다', 'aria-label': '편집 창 닫기', onclick: () => close() }, '✕')));
    editorEl.appendChild(commonFields(v));
    editorEl.appendChild(v.type === 'table' ? tableEditor(v) : v.type === 'debt' ? debtEditor(v) : valueFields(v));
    editorEl.appendChild(deleteArea(v));
    refreshState();
    pop.open();   // 내용을 채운 뒤 열어야 높이(--pop-h)가 맞게 잡힌다
  }

  function commonFields(v) {
    const nameErr = h('div', { class: 'field-error' });
    const nameInput = h('input', { type: 'text', class: 'name-field', value: v.name });
    nameInput.addEventListener('input', () => {
      const p = S.nameProblem(nameInput.value, v.id);
      nameErr.textContent = p || '';
      nameInput.classList.toggle('invalid', !!p);
    });
    nameInput.addEventListener('change', () => {
      const newName = nameInput.value.trim();
      if (S.nameProblem(newName, v.id) || newName === v.name) return;
      edit(x => { x.name = newName; });   // 수식 안의 이름은 저장할 때 함께 바꾼다
    });

    const rows = [
      field('이름', h('div', {}, nameInput, nameErr)),
    ];
    if (!isTableLike(v)) {
      rows.push(field('구분', select(Object.entries(KIND_LABEL), v.kind, (k) => edit(x => { x.kind = k; }))));
      rows.push(field('형태', select(SCALAR_TYPES.map(t => [t, E.VAR_TYPES[t]]), v.type, (t) => {
        edit(x => convertType(x, t));
        renderEditor();
      })));
    }
    const desc = h('input', { type: 'text', value: v.desc || '', placeholder: '설명(선택) — 원천, 단위, 확인 방법 등' });
    desc.addEventListener('input', () => edit(x => { x.desc = desc.value; }));
    rows.push(field('설명', desc));
    return h('div', { class: 'form-grid' }, rows);
  }

  function convertType(x, t) {
    const prev = x.type;
    x.type = t;
    if (t === 'choice') {
      x.options = x.options && x.options.length ? x.options : ['항목1', '항목2'];
      x.value = x.options.includes(String(x.value)) ? String(x.value) : x.options[0];
    } else if (t === 'bool') {
      x.value = !!E.toNum(x.value);
    } else if (prev === 'choice' || prev === 'bool') {
      x.value = E.toNum(x.value) ?? 0;
    }
    if (t !== 'choice') delete x.options;
  }

  function valueFields(v) {
    const label = v.kind === 'input' ? '기본값' : '값';
    if (v.type === 'bool') {
      const cb = h('input', { type: 'checkbox', checked: !!v.value });
      cb.addEventListener('change', () => edit(x => { x.value = cb.checked; }));
      return h('div', { class: 'form-grid' }, field(label, h('label', { class: 'check' }, cb, ' 예')));
    }
    if (v.type === 'choice') return choiceEditor(v, label);
    return h('div', { class: 'form-grid' }, field(label, numberField(v.value, v.type, (n) => edit(x => { x.value = n ?? 0; }))));
  }

  function choiceEditor(v, label) {
    const wrap = h('div', { class: 'form-grid' });
    const list = h('div', { class: 'option-list' });
    const draw = () => {
      clear(list);
      (v.options || []).forEach((opt, i) => {
        const inp = h('input', { type: 'text', value: opt });
        inp.addEventListener('change', () => {
          const t = inp.value.trim();
          if (!t || v.options.some((o, j) => j !== i && o === t)) { inp.value = opt; return; }
          edit(x => { if (x.value === x.options[i]) x.value = t; x.options[i] = t; });
          redrawDefault();
        });
        list.appendChild(h('div', { class: 'option-row' }, inp,
          h('button', {
            class: 'btn-icon', title: '선택지 삭제', 'aria-label': '선택지 삭제',
            onclick: () => {
              if (v.options.length <= 1) return;
              edit(x => { const [gone] = x.options.splice(i, 1); if (x.value === gone) x.value = x.options[0]; });
              draw(); redrawDefault();
            },
          }, '✕')));
      });
      list.appendChild(h('button', {
        class: 'btn btn-small', onclick: () => {
          edit(x => { let n = x.options.length + 1; while (x.options.includes(`항목${n}`)) n++; x.options.push(`항목${n}`); });
          draw(); redrawDefault();
        },
      }, '+ 선택지'));
    };
    const defHost = h('div');
    const redrawDefault = () => {
      clear(defHost).appendChild(select(v.options.map(o => [o, o]), v.value, (o) => edit(x => { x.value = o; })));
    };
    draw(); redrawDefault();
    wrap.append(field('선택지', list), field(label, defHost));
    return wrap;
  }

  // ── 표 편집기 ───────────────────────────────────────────────────────────
  const AXIS_MODES = [['list', '목록 — 같은 값을 찾음 (INDEX·MATCH)'], ['band', '구간 — 시작값 이상인 구간을 찾음 (VLOOKUP 근사)']];

  function tableEditor(v) {
    const wrap = h('div', { class: 'table-editor' });
    const gridHost = h('div', { class: 'table-grid-host' });

    const rowMode = select(AXIS_MODES, v.rows.mode, (m) => { edit(x => setAxisMode(x.rows, m)); drawGrid(); });
    const colMode = select([['none', '없음 — 1차원 표'], ...AXIS_MODES], v.cols ? v.cols.mode : 'none', (m) => {
      edit(x => {
        if (m === 'none') { x.cols = null; x.cells = x.cells.map(r => [r[0]]); }
        else if (!x.cols) { x.cols = { mode: m, keys: m === 'band' ? [0, 10] : ['열1', '열2'] }; x.cells = x.cells.map(r => [r[0], 0]); }
        else setAxisMode(x.cols, m);
      });
      drawGrid();
    });
    wrap.appendChild(h('div', { class: 'form-grid' }, field('행 기준', rowMode), field('열 기준', colMode)));
    wrap.appendChild(h('div', { class: 'hint' }, '구간은 "시작값 이상 ~ 다음 시작값 미만"입니다. 엑셀에서 복사한 칸을 표 안에 붙여넣을 수 있습니다.'));
    wrap.appendChild(gridHost);

    function drawGrid() {
      const keep = keepScroll(gridHost);
      clear(gridHost);
      const t = selected();
      const hasCols = !!t.cols;
      const nCols = hasCols ? t.cols.keys.length : 1;
      const numericCells = t.cells.flat().map(E.toNum).filter(n => n !== null);
      const lo = Math.min(...numericCells), hi = Math.max(...numericCells);

      const head = h('tr', {}, h('th', { class: 'corner' }, hasCols ? '행 \\ 열' : '행'));
      for (let c = 0; c < nCols; c++) {
        head.appendChild(h('th', {}, hasCols
          ? h('div', { class: 'axis-cell' },
            keyInput(t.cols, c, drawGrid),
            t.cols.mode === 'band' ? h('div', { class: 'axis-range' }, E.axisKeyLabel(t.cols, c)) : null,
            h('button', { class: 'btn-icon', title: '열 삭제', 'aria-label': '열 삭제', onclick: () => { if (nCols > 1) { edit(x => { x.cols.keys.splice(c, 1); x.cells.forEach(r => r.splice(c, 1)); }); drawGrid(); } } }, '✕'))
          : '값'));
      }
      head.appendChild(h('th', {}, ''));
      const tbody = h('tbody');
      t.rows.keys.forEach((_, r) => {
        const tr = h('tr', {}, h('th', {}, h('div', { class: 'axis-cell' },
          keyInput(t.rows, r, drawGrid),
          t.rows.mode === 'band' ? h('div', { class: 'axis-range' }, E.axisKeyLabel(t.rows, r)) : null)));
        for (let c = 0; c < nCols; c++) {
          const val = (t.cells[r] || [])[c];
          const td = h('td', { class: 'cell' });
          const n = E.toNum(val);
          if (hasCols && n !== null && hi > lo) td.style.background = `color-mix(in srgb, var(--accent) ${Math.round(((n - lo) / (hi - lo)) * 30)}%, var(--surface))`;
          const inp = h('input', { type: 'text', value: val === null || val === undefined ? '' : String(val) });
          inp.addEventListener('change', () => { edit(x => { x.cells[r][c] = parseCell(inp.value); }); drawGrid(); });
          inp.addEventListener('paste', (ev) => pasteBlock(ev, r, c));
          td.appendChild(inp);
          tr.appendChild(td);
        }
        tr.appendChild(h('td', { class: 'row-tools' }, h('button', {
          class: 'btn-icon', title: '행 삭제', 'aria-label': '행 삭제',
          onclick: () => { if (t.rows.keys.length > 1) { edit(x => { x.rows.keys.splice(r, 1); x.cells.splice(r, 1); }); drawGrid(); } },
        }, '✕')));
        tbody.appendChild(tr);
      });
      gridHost.appendChild(h('div', { class: 'table-scroll' }, h('table', { class: 'grid matrix' }, h('thead', {}, head), tbody)));
      gridHost.appendChild(h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-small', onclick: () => { edit(x => { x.rows.keys.push(nextKey(x.rows, '항목')); x.cells.push(new Array(nCols).fill(0)); }); drawGrid(); } }, '+ 행 추가'),
        hasCols ? h('button', { class: 'btn btn-small', onclick: () => { edit(x => { x.cols.keys.push(nextKey(x.cols, '열')); x.cells.forEach(row => row.push(0)); }); drawGrid(); } }, '+ 열 추가') : null));
      const issues = E.validate({ variables: [t], nodes: [], edges: [] }).filter(m => m.includes(t.name));
      if (issues.length) gridHost.appendChild(h('div', { class: 'field-error' }, issues.join(' / ')));
      keep();
    }

    // 엑셀에서 복사한 여러 칸(탭·줄바꿈 구분)을 붙여넣은 칸부터 채운다. 모자라면 행·열을 늘린다
    function pasteBlock(ev, r0, c0) {
      const text = (ev.clipboardData || window.clipboardData).getData('text');
      if (!/[\t\n]/.test(text.trim())) return;
      ev.preventDefault();
      const block = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(line => line.split('\t'));
      edit(x => {
        for (let i = 0; i < block.length; i++) {
          const r = r0 + i;
          while (x.rows.keys.length <= r) { x.rows.keys.push(nextKey(x.rows, '항목')); x.cells.push(new Array(x.cols ? x.cols.keys.length : 1).fill(0)); }
          for (let j = 0; j < block[i].length; j++) {
            const c = c0 + j;
            if (!x.cols && c > 0) break;
            while (x.cols && x.cols.keys.length <= c) { x.cols.keys.push(nextKey(x.cols, '열')); x.cells.forEach(row => row.push(0)); }
            x.cells[r][c] = parseCell(block[i][j]);
          }
        }
      });
      drawGrid();
    }

    drawGrid();
    return wrap;
  }

  function keyInput(axis, i, redraw) {
    const inp = h('input', { type: 'text', class: 'key-input', value: axis.mode === 'band' ? UI.toDisplay(axis.keys[i], 'number') : String(axis.keys[i]) });
    inp.addEventListener('change', () => {
      const which = axis === selected().rows ? 'rows' : 'cols';
      edit(x => { x[which].keys[i] = x[which].mode === 'band' ? (UI.fromDisplay(inp.value, 'number') ?? 0) : parseCell(inp.value); });
      redraw();
    });
    return inp;
  }

  // 표를 다시 그리면 내용이 잠깐 비어 편집 창이 맨 위로 올라간다 — 그리기 전 위치로 돌리고,
  // 행이 늘었으면 늘어난 만큼 내려 "행 추가" 버튼이 제자리에 있게 한다
  function keepScroll(gridHost) {
    const top = editorEl.scrollTop, before = gridHost.offsetHeight;
    return () => { editorEl.scrollTop = top + Math.max(0, gridHost.offsetHeight - before); };
  }

  function setAxisMode(axis, m) {
    if (axis.mode === m) return;
    axis.mode = m;
    if (m === 'band') {
      // 목록 → 구간: 숫자로 읽히지 않는 항목은 순번으로 바꾼다
      axis.keys = axis.keys.map((k, i) => E.toNum(k) ?? i);
      for (let i = 1; i < axis.keys.length; i++) if (axis.keys[i] <= axis.keys[i - 1]) axis.keys[i] = axis.keys[i - 1] + 1;
    }
  }

  function nextKey(axis, prefix) {
    const ks = axis.keys;
    if (axis.mode === 'band') {
      const last = E.toNum(ks[ks.length - 1]) ?? 0;
      const step = ks.length > 1 ? last - (E.toNum(ks[ks.length - 2]) ?? 0) : 1;
      return last + (step > 0 ? step : 1);
    }
    let n = ks.length + 1;
    while (ks.map(String).includes(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  function parseCell(text) {
    const t = String(text).trim().replace(/,/g, '');
    if (t === '') return null;
    return isNaN(Number(t)) ? String(text).trim() : Number(t);
  }

  // ── 부채표 편집기 ───────────────────────────────────────────────────────
  // 행 = 업권 × 대출구분. 대출기간·금리는 전략값, 잔액은 고객 입력값의 테스트 기본값(오른쪽 단일 시뮬레이션에서도 바꾼다)
  function debtEditor(v) {
    const wrap = h('div', { class: 'table-editor' });
    const gridHost = h('div');
    wrap.append(
      h('div', { class: 'hint' }, '엑셀에서 "업권 · 대출구분 · 기간 · 금리 (· 고금리여부) (· 잔액)" 칸을 복사해 업권 칸에 붙여넣으면 그 줄부터 채웁니다. 고금리 여부는 부채 집계 단계의 고금리 기준으로 자동 판정하므로 따로 적지 않습니다.'),
      gridHost);

    function drawGrid() {
      const keep = keepScroll(gridHost);
      clear(gridHost);
      const t = selected();
      const tbody = h('tbody');
      t.rows.forEach((row, i) => {
        const sector = h('input', { type: 'text', class: 'sector-input', value: row.sector });
        sector.addEventListener('change', () => { edit(x => { x.rows[i].sector = sector.value.trim(); }); });
        sector.addEventListener('paste', (ev) => pasteRows(ev, i));
        const kind = select(DEBT_KINDS.map(k => [k, k]), row.kind, (k) => edit(x => { x.rows[i].kind = k; }));
        tbody.appendChild(h('tr', {},
          h('td', {}, sector),
          h('td', {}, kind),
          h('td', {}, numberField(row.months, 'number', (n) => edit(x => { x.rows[i].months = n ?? 0; }))),
          h('td', {}, numberField(row.rate, 'percent', (n) => edit(x => { x.rows[i].rate = n ?? 0; }))),
          h('td', { class: 'bal' }, numberField(row.balance || 0, 'money', (n) => edit(x => { x.rows[i].balance = n ?? 0; }))),
          h('td', { class: 'row-tools' }, h('button', {
            class: 'btn-icon', title: '행 삭제', 'aria-label': '행 삭제',
            onclick: () => { if (t.rows.length > 1) { edit(x => { x.rows.splice(i, 1); }); drawGrid(); } },
          }, '✕'))));
      });
      gridHost.appendChild(h('div', { class: 'table-scroll' }, h('table', { class: 'grid debt-grid' },
        h('thead', {}, h('tr', {}, ['업권', '대출구분', '대출기간(개월)', '대출금리', '테스트 잔액', ''].map(x => h('th', {}, x)))),
        tbody)));
      gridHost.appendChild(h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-small', onclick: () => { edit(x => { x.rows.push({ sector: '새 업권', kind: '부동산 외', months: 36, rate: 0.1, balance: 0 }); }); drawGrid(); } }, '+ 행 추가')));
      const issues = E.validate({ variables: [t], nodes: [], edges: [] });
      if (issues.length) gridHost.appendChild(h('div', { class: 'field-error' }, issues.join(' / ')));
      keep();
    }

    // 엑셀 붙여넣기: 탭·줄바꿈으로 나뉜 줄마다 업권·대출구분·기간·금리, 그 뒤 Y/N은 건너뛰고 숫자가 있으면 잔액
    function pasteRows(ev, r0) {
      const text = (ev.clipboardData || window.clipboardData).getData('text');
      if (!/[\t\n]/.test(text.trim())) return;
      ev.preventDefault();
      const toNum = (x) => { const n = Number(String(x).replace(/[,\s원%]/g, '')); return String(x).trim() === '' || isNaN(n) ? null : n; };
      const toRate = (x) => { const n = toNum(x); if (n === null) return null; return String(x).includes('%') || n > 1 ? n / 100 : n; };
      const rows = text.replace(/\r/g, '').split('\n').map(l => l.split('\t').map(c => c.trim())).filter(c => c.length >= 4)
        .map(c => ({ sector: c[0], kind: c[1].replace(/\s+/g, '') === '부동산외' ? '부동산 외' : c[1], months: toNum(c[2]), rate: toRate(c[3]), rest: c.slice(4) }))
        .filter(x => x.sector && x.months !== null && x.rate !== null)   // 제목 줄은 건너뛴다
        .map(x => ({ sector: x.sector, kind: DEBT_KINDS.includes(x.kind) ? x.kind : '부동산 외', months: x.months, rate: x.rate,
          balance: x.rest.map(toNum).find(n => n !== null) || 0 }));
      if (!rows.length) { root.App.flash('붙여넣은 내용에서 "업권 · 대출구분 · 기간 · 금리" 줄을 찾지 못했습니다', 'danger'); return; }
      edit(x => { rows.forEach((row, j) => { x.rows[r0 + j] = row; }); });
      drawGrid();
      root.App.flash(`부채표에 ${rows.length}줄을 붙여넣었습니다`, 'ok');
    }

    drawGrid();
    return wrap;
  }

  // ── 엑셀 양식·올리기 ────────────────────────────────────────────────────
  // 파일 구성: "변수" 시트(값 하나짜리 변수 목록) + 표마다 시트 하나 + 부채표마다 시트 하나 + "설명" 시트.
  // 시트 이름은 자유이고, 첫 칸(A1)이 "이름"·"표 이름"·"부채표 이름"인 시트만 읽는다 — 표가 여러 개면 시트를 복사해 늘린다
  const XLSX = () => root.XLSX;
  const EXAMPLE = '(예시)';   // 이 글자로 시작하는 이름은 올릴 때 건너뛴다(빈 양식의 작성 예)
  const MODE_LABEL = { list: '목록', band: '구간' };
  const VAR_HEAD = ['이름', '구분', '형태', '값', '선택지', '설명'];
  const DEBT_HEAD = ['업권', '대출구분', '대출기간(개월)', '대출금리', '테스트 잔액'];
  const norm = (x) => String(x === null || x === undefined ? '' : x).replace(/\s+/g, '');
  const text = (x) => (x === null || x === undefined ? '' : String(x).trim());
  const TYPE_BY_LABEL = Object.assign(
    Object.fromEntries(SCALAR_TYPES.map(t => [norm(E.VAR_TYPES[t]), t])),
    { 금액: 'money', 숫자: 'number', 비율: 'percent', '%': 'percent', 선택: 'choice', '예·아니오': 'bool', '예/아니오': 'bool', 예아니오: 'bool', 'Y/N': 'bool' });
  const safe = (x) => String(x || '전략').replace(/[\\/:*?"<>|]/g, '_');

  // 빈 양식에 넣는 작성 예 — 값은 설명용 가상 숫자다
  const EXAMPLE_VARS = [
    { name: `${EXAMPLE} 금액 변수`, kind: 'input', type: 'money', value: 10000000, desc: '금액 — 원 단위 숫자' },
    { name: `${EXAMPLE} 숫자 변수`, kind: 'input', type: 'number', value: 12, desc: '숫자' },
    { name: `${EXAMPLE} 비율 변수`, kind: 'param', type: 'percent', value: 0.5, desc: '비율 — 0.5 또는 50%' },
    { name: `${EXAMPLE} 선택 변수`, kind: 'input', type: 'choice', value: 'B', options: ['A', 'B', 'C'], desc: '선택 — 선택지 칸에 / 로 나눠 적고, 값은 그중 하나' },
    { name: `${EXAMPLE} 예아니오 변수`, kind: 'input', type: 'bool', value: false, desc: '예·아니오 — Y 또는 N' },
    { name: `${EXAMPLE} 목록표`, kind: 'param', type: 'table', desc: '행 기준 목록 · 열 없음 — 같은 항목을 찾는 1차원 표',
      rows: { mode: 'list', keys: ['A', 'B', 'C'] }, cols: null, cells: [[300], [200], [100]] },
    { name: `${EXAMPLE} 구간표`, kind: 'param', type: 'table', desc: '행 기준 구간 — 시작값 이상 ~ 다음 시작값 미만. 시작값은 작은 것부터',
      rows: { mode: 'band', keys: [0, 10, 20] }, cols: null, cells: [[0.5], [0.8], [1]] },
    { name: `${EXAMPLE} 매트릭스`, kind: 'param', type: 'table', desc: '행 구간 × 열 목록 — 2차원 표. 열을 오른쪽으로, 행을 아래로 늘린다',
      rows: { mode: 'band', keys: [0, 100, 200] }, cols: { mode: 'list', keys: ['A', 'B', 'C'] }, cells: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] },
    { name: `${EXAMPLE} 부채표`, kind: 'input', type: 'debt', desc: '업권 × 대출구분마다 한 줄',
      rows: [{ sector: '업권1', kind: '부동산', months: 120, rate: 0.05, balance: 0 }, { sector: '업권1', kind: '부동산 외', months: 36, rate: 0.1, balance: 1000000 }] },
  ];

  const GUIDE_ROWS = [
    ['변수·표 엑셀 양식 — 작성법'],
    ['가상 데이터 전용입니다. 고객 개인신용정보를 넣지 마세요. 여기 값은 예시 파라미터이며 실적용 전 실데이터로 교체해야 합니다.'],
    [],
    ['읽는 규칙', '시트 이름은 자유입니다. 시트의 첫 칸(A1)이 "이름"이면 변수 목록, "표 이름"이면 표, "부채표 이름"이면 부채표로 읽고, 그 밖의 시트(이 설명 시트 등)는 읽지 않습니다.'],
    ['반영 규칙', '같은 이름이 이미 있으면 값을 덮어쓰고(그 변수를 쓰는 단계는 그대로 이어짐), 없는 이름은 새로 추가합니다. 엑셀에 없는 기존 변수는 그대로 둡니다.'],
    ['작성 예', `이름이 "${EXAMPLE}"로 시작하는 줄·시트는 작성 예이며 올릴 때 건너뜁니다. 이름을 바꿔 쓰거나 지우고 쓰세요.`],
    ['이름', '[ ] › 는 쓸 수 없고, 다른 변수·단계 이름과 겹칠 수 없습니다.'],
    [],
    ['■ 변수 시트 (값 하나짜리 변수 — 한 줄에 하나, 줄을 아래로 늘려 여러 개)'],
    ['열', '적는 법'],
    ['이름', '변수 이름'],
    ['구분', '고객 입력값(건마다 바뀌는 값) 또는 전략 파라미터(전략마다 고정된 값)'],
    ['형태', `${SCALAR_TYPES.map(t => E.VAR_TYPES[t]).join(' · ')} 중 하나`],
    ['값', '금액·숫자 = 숫자(쉼표 가능) / 비율 = 0.5 또는 50% / 선택 = 선택지 중 하나 / 예·아니오 = Y 또는 N. 고객 입력값이면 기본값이 됩니다.'],
    ['선택지', '형태가 선택일 때만. "A / B / C"처럼 / 로 나눠 적습니다.'],
    ['설명', '원천·단위·확인 방법 등(선택)'],
    [],
    ['■ 표 시트 (표 하나에 시트 하나 — 표를 여러 개 올리려면 표 시트를 복사해 시트를 늘립니다)'],
    ['표 이름', 'B1 칸에 표 이름'],
    ['행 기준', '목록(같은 값을 찾음) 또는 구간(시작값 이상 ~ 다음 시작값 미만, 시작값은 숫자·작은 것부터)'],
    ['열 기준', '없음(1차원 표) · 목록 · 구간'],
    ['설명', '선택'],
    ['표 본문', '위 네 줄 아래 한 줄을 띄우고 제목 줄을 둡니다. 제목 줄의 첫 칸은 "행" 자리이고 그 오른쪽에 열 항목(열 기준이 없음이면 "값" 한 칸)을 적습니다. 그 아래로 한 줄에 "행 항목, 값…"을 적습니다. 행·열 수는 자유롭게 늘립니다.'],
    [],
    ['■ 부채표 시트 (부채표 하나에 시트 하나)'],
    ['부채표 이름', 'B1 칸에 부채표 이름'],
    ['본문', `제목 줄(${DEBT_HEAD.join(' · ')}) 아래로 업권 × 대출구분마다 한 줄. 대출구분은 부동산 또는 부동산 외, 금리는 0.05 또는 5%, 테스트 잔액은 비워도 됩니다(0).`],
  ];

  // 변수 목록 → 시트들 [[시트 이름, 줄들, 열 너비]]
  function bookSheets(list) {
    const used = new Set();
    const sheetName = (base) => {
      const b = String(base).replace(/[\\/?*\[\]:]/g, '_').slice(0, 28) || '시트';
      let name = b, i = 2;
      while (used.has(name)) name = `${b}_${i++}`;
      used.add(name);
      return name;
    };
    const out = [[sheetName('변수'), [VAR_HEAD, ...list.filter(v => !isTableLike(v)).map(v => [
      v.name, KIND_LABEL[v.kind === 'input' ? 'input' : 'param'], E.VAR_TYPES[v.type],
      v.type === 'bool' ? (v.value ? 'Y' : 'N') : v.value, v.type === 'choice' ? (v.options || []).join(' / ') : null, v.desc || null])],
    [24, 14, 12, 16, 24, 50]]];
    for (const v of list.filter(x => x.type === 'table')) {
      const nCols = v.cols ? v.cols.keys.length : 1;
      out.push([sheetName(`표_${v.name}`), [
        ['표 이름', v.name], ['행 기준', MODE_LABEL[v.rows.mode]], ['열 기준', v.cols ? MODE_LABEL[v.cols.mode] : '없음'], ['설명', v.desc || null], [],
        [v.cols ? '행 \\ 열' : '행', ...(v.cols ? v.cols.keys : ['값'])],
        ...v.rows.keys.map((k, r) => [k, ...Array.from({ length: nCols }, (_, c) => (v.cells[r] || [])[c] ?? null)])],
      [16, ...new Array(nCols).fill(14)]]);
    }
    for (const v of list.filter(x => x.type === 'debt')) {
      out.push([sheetName(`부채표_${v.name}`), [
        ['부채표 이름', v.name], ['설명', v.desc || null], [], DEBT_HEAD,
        ...v.rows.map(r => [r.sector, r.kind, r.months, r.rate, r.balance || 0])],
      [16, 14, 16, 12, 16]]);
    }
    out.push([sheetName('설명'), GUIDE_ROWS, [16, 110]]);
    return out;
  }

  function templateBook(filled) {
    const list = filled && vars().length ? vars() : EXAMPLE_VARS;
    const wb = XLSX().utils.book_new();
    for (const [name, rows, widths] of bookSheets(list)) {
      const ws = XLSX().utils.aoa_to_sheet(rows);
      ws['!cols'] = widths.map(wch => ({ wch }));
      XLSX().utils.book_append_sheet(wb, ws, name);
    }
    return wb;
  }

  function downloadTemplate(filled) {
    if (filled && !vars().length) root.App.flash('아직 변수가 없어 작성 예가 든 빈 양식을 내려받습니다', 'info');
    XLSX().writeFile(templateBook(filled), filled && vars().length ? `${safe(S.strategy.meta.name)}_변수표.xlsx` : '변수표_빈양식.xlsx');
  }

  // 셀 읽기: 숫자(쉼표·원 허용), 비율(% 가 붙으면 100으로 나눔)
  function cellNum(x) {
    if (typeof x === 'number') return x;
    const t = text(x).replace(/[,\s원]/g, '');
    if (t === '') return null;
    const n = Number(t);
    return isNaN(n) ? undefined : n;   // undefined = 숫자가 아님
  }
  function cellRate(x) {
    if (typeof x === 'string' && x.includes('%')) { const n = cellNum(x.replace(/%/g, '')); return typeof n === 'number' ? n / 100 : n; }
    return cellNum(x);
  }

  // 엑셀 파일 → {items: 변수(id 없음)들, skipped: [[이름, 이유]]}
  function parseBook(wb) {
    const items = [], skipped = [];
    const bad = (name, why) => skipped.push([name, why]);
    for (const sn of wb.SheetNames) {
      const aoa = XLSX().utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null, blankrows: false });
      const a1 = aoa.length ? norm(aoa[0][0]) : '';
      if (a1 === '이름') {
        for (const r of aoa.slice(1)) {
          const name = text(r[0]);
          if (!name || name.startsWith(EXAMPLE)) continue;
          const kind = /파라미터/.test(text(r[1])) ? 'param' : /입력/.test(text(r[1])) ? 'input' : null;
          const type = TYPE_BY_LABEL[norm(r[2])];
          if (!kind) { bad(name, '구분은 "고객 입력값" 또는 "전략 파라미터"여야 합니다'); continue; }
          if (!type) { bad(name, `형태 "${text(r[2])}"을(를) 알 수 없습니다`); continue; }
          const v = { name, kind, type, value: 0, desc: text(r[5]) };
          if (type === 'bool') v.value = /^(y|yes|예|true|1|o)$/i.test(text(r[3]));
          else if (type === 'choice') {
            v.options = [...new Set(text(r[4]).split('/').map(x => x.trim()).filter(Boolean))];
            if (!v.options.length) { bad(name, '형태가 선택이면 선택지 칸에 "A / B / C"처럼 적어야 합니다'); continue; }
            if (!v.options.includes(text(r[3]))) { bad(name, `값 "${text(r[3])}"이(가) 선택지에 없습니다`); continue; }
            v.value = text(r[3]);
          } else {
            const n = type === 'percent' ? cellRate(r[3]) : cellNum(r[3]);
            if (n === undefined) { bad(name, `값 "${text(r[3])}"은(는) 숫자가 아닙니다`); continue; }
            v.value = n ?? 0;
          }
          items.push(v);
        }
      } else if (a1 === '표이름') {
        const name = text(aoa[0][1]) || `(시트 ${sn})`;
        if (name.startsWith(EXAMPLE)) continue;
        const META = ['표이름', '행기준', '열기준', '설명'];
        const meta = Object.fromEntries(aoa.filter(r => META.includes(norm(r[0]))).map(r => [norm(r[0]), text(r[1])]));
        const body = aoa.filter(r => !META.includes(norm(r[0])));
        const mode = (x) => (/구간/.test(x) ? 'band' : 'list');
        const colMode = !meta['열기준'] || /없음/.test(meta['열기준']) ? null : mode(meta['열기준']);
        const key = (m, x) => (m === 'band' ? cellNum(x) : parseCell(x === null || x === undefined ? '' : x));
        if (body.length < 2) { bad(name, '제목 줄과 그 아래 값 줄이 있어야 합니다'); continue; }
        let head = body[0].slice(1);
        while (head.length && (head[head.length - 1] === null || text(head[head.length - 1]) === '')) head.pop();
        const v = { name, kind: 'param', type: 'table', desc: meta['설명'] || '',
          rows: { mode: mode(meta['행기준'] || ''), keys: body.slice(1).map(r => key(mode(meta['행기준'] || ''), r[0])) },
          cols: colMode ? { mode: colMode, keys: head.map(x => key(colMode, x)) } : null };
        const nCols = v.cols ? v.cols.keys.length : 1;
        v.cells = body.slice(1).map(r => Array.from({ length: nCols }, (_, c) => parseCell(r[c + 1] === null || r[c + 1] === undefined ? '' : r[c + 1])));
        const keys = [...v.rows.keys, ...(v.cols ? v.cols.keys : [])];
        if (v.cols && !nCols) { bad(name, '열 기준이 있으면 제목 줄에 열 항목을 적어야 합니다'); continue; }
        if (keys.some(k => k === null || k === undefined)) { bad(name, '행·열 항목에 빈 칸이 있거나, 구간의 시작값이 숫자가 아닙니다'); continue; }
        items.push(v);
      } else if (a1 === '부채표이름') {
        const name = text(aoa[0][1]) || `(시트 ${sn})`;
        if (name.startsWith(EXAMPLE)) continue;
        const at = aoa.findIndex(r => norm(r[0]) === '업권');
        const descRow = aoa.find(r => norm(r[0]) === '설명');
        const rows = [];
        let wrong = at < 0 ? '제목 줄(업권 · 대출구분 · …)을 찾지 못했습니다' : null;
        for (const r of at < 0 ? [] : aoa.slice(at + 1)) {
          if (!text(r[0])) continue;
          const months = cellNum(r[2]), rate = cellRate(r[3]), balance = cellNum(r[4]);
          const kind = norm(r[1]) === '부동산외' ? '부동산 외' : text(r[1]);
          if (!DEBT_KINDS.includes(kind)) wrong = `[${text(r[0])}] 대출구분은 "부동산" 또는 "부동산 외"여야 합니다`;
          else if (typeof months !== 'number' || typeof rate !== 'number' || balance === undefined) wrong = `[${text(r[0])}] 기간·금리·잔액은 숫자여야 합니다`;
          else rows.push({ sector: text(r[0]), kind, months, rate, balance: balance || 0 });
        }
        if (!wrong && !rows.length) wrong = '행이 없습니다';
        if (wrong) { bad(name, wrong); continue; }
        items.push({ name, kind: 'input', type: 'debt', desc: descRow ? text(descRow[1]) : '', rows });
      }
    }
    return { items, skipped };
  }

  // 지금 변수와 이름으로 맞춰 바뀜·추가·그대로·건너뜀으로 나눈다
  function planImport(parsed) {
    const plan = { update: [], add: [], same: [], skipped: [...parsed.skipped] };
    const seen = new Set();
    const bare = (v) => JSON.stringify(Object.assign({}, v, { id: undefined }));
    for (const p of parsed.items) {
      if (seen.has(p.name)) { plan.skipped.push([p.name, '파일 안에 같은 이름이 두 번 있습니다(처음 것만 씀)']); continue; }
      seen.add(p.name);
      const issues = E.validate({ variables: [p], nodes: [], edges: [] });
      if (issues.length) { plan.skipped.push([p.name, issues.join(' / ')]); continue; }
      const old = vars().find(v => v.name === p.name);
      if (!old) {
        const problem = S.nameProblem(p.name);
        if (problem) plan.skipped.push([p.name, problem === '같은 이름이 이미 있습니다' ? '같은 이름의 단계가 있습니다' : problem]);
        else plan.add.push(p);
      } else if ((isTableLike(old) || isTableLike(p)) && old.type !== p.type) {
        plan.skipped.push([p.name, `같은 이름의 ${E.VAR_TYPES[old.type]}이(가) 있어 ${E.VAR_TYPES[p.type]}(으)로 바꾸지 않았습니다`]);
      } else if (bare(Object.assign({}, old, p)) === bare(old)) plan.same.push(p);
      else plan.update.push(p);
    }
    return plan;
  }

  function applyImport(plan) {
    S.update(s => {
      for (const p of plan.update) {
        const old = s.variables.find(v => v.name === p.name);
        if (p.type !== 'choice') delete old.options;
        Object.assign(old, p);
      }
      for (const p of plan.add) s.variables.push(Object.assign({ id: E.newId(p.type === 'table' ? 't' : p.type === 'debt' ? 'd' : 'v') }, p));
    }, 'vars-import');
    root.App.flash(`엑셀에서 변수 ${plan.update.length}개를 바꾸고 ${plan.add.length}개를 추가했습니다`, 'ok');
  }

  // 반영 전 확인 창 — 무엇이 바뀌는지 보여 주고 [반영]을 눌러야 적용한다
  function confirmImport(fileName, plan) {
    const n = plan.update.length + plan.add.length;
    const rows = [
      ...plan.update.map(p => ['ok', '바뀜', p.name, E.VAR_TYPES[p.type]]),
      ...plan.add.map(p => ['ok', '추가', p.name, E.VAR_TYPES[p.type]]),
      ...plan.skipped.map(([name, why]) => ['warn', '건너뜀', name, why]),
      ...plan.same.map(p => ['', '그대로', p.name, '지금 값과 같음'])];
    let m;
    const body = h('div', {},
      h('div', { class: 'hint' }, `${fileName} — 바뀜 ${plan.update.length}개 · 추가 ${plan.add.length}개 · 건너뜀 ${plan.skipped.length}개 · 그대로 ${plan.same.length}개. 엑셀에 없는 기존 변수는 그대로 둡니다.`),
      rows.length
        ? h('div', { class: 'table-scroll' }, h('table', { class: 'grid' },
          h('thead', {}, h('tr', {}, ['처리', '이름', '형태·사유'].map(x => h('th', {}, x)))),
          h('tbody', {}, rows.map(([cls, act, name, note]) => h('tr', {},
            h('td', {}, cls ? h('span', { class: `badge badge-${cls}` }, act) : h('span', { class: 'muted' }, act)),
            h('td', {}, name), h('td', { class: 'small muted' }, note))))))
        : h('div', { class: 'empty' }, '읽을 변수·표를 찾지 못했습니다. 첫 칸(A1)이 "이름"·"표 이름"·"부채표 이름"인 시트가 있어야 합니다.'),
      h('div', { class: 'row-actions' },
        n ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { m.close(); applyImport(plan); } }, `${n}개 반영`) : null,
        h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, n ? '취소' : '닫기')));
    m = root.UI.modal('엑셀 올리기 — 반영 전 확인', body, true);
  }

  // importFile: 파일 선택 창 없이 File을 넘기는 입구(자동 점검용)
  async function importFile(f) {
    try {
      confirmImport(f.name, planImport(parseBook(XLSX().read(await f.arrayBuffer(), { type: 'array' }))));
    } catch (e) {
      root.App.flash(`파일을 읽지 못했습니다: ${e.message}`, 'danger');
    }
  }

  // 파일 선택 칸은 한 번만 만든다(hidden)
  function pickFile() {
    let input = document.querySelector('input.vars-file');
    if (!input) {
      input = h('input', { type: 'file', class: 'vars-file', accept: '.xlsx,.xls', hidden: true });
      input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; if (f) importFile(f); });
      document.body.appendChild(input);
    }
    input.click();
  }

  // ── 삭제 ────────────────────────────────────────────────────────────────
  function deleteArea(v) {
    const refs = E.findReferences(S.strategy, v.id);
    const area = h('div', { class: 'delete-area' });
    if (pendingDelete === v.id) {
      area.appendChild(h('div', { class: 'warn-box' },
        refs.length
          ? [h('strong', {}, `[${v.name}]을(를) 쓰는 단계가 ${refs.length}곳 있습니다. `), `삭제하면 이 단계들이 오류가 됩니다: ${refs.map(n => n.name).join(', ')}`]
          : `[${v.name}]을(를) 삭제합니다.`,
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-danger', onclick: () => { draft = null; S.update(s => { s.variables = s.variables.filter(x => x.id !== v.id); }, 'vars-delete'); } }, '삭제'),
          h('button', { class: 'btn', onclick: () => { pendingDelete = null; renderEditor(); } }, '취소'))));
    } else {
      area.appendChild(h('button', { class: 'btn btn-ghost-danger', onclick: () => { pendingDelete = v.id; renderEditor(); } }, v.type === 'table' ? '표 삭제' : v.type === 'debt' ? '부채표 삭제' : '변수 삭제'));
    }
    return area;
  }

  function close(quiet) { if (selectedId) open(null, quiet === true); }

  // ── 공용 ────────────────────────────────────────────────────────────────
  function field(label, control) {
    // label로 감싸면 칸 안의 버튼을 눌러도 첫 입력칸이 선택되므로 div로 둔다
    return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), control);
  }

  function select(pairs, value, onChange) {
    const sel = h('select', {}, pairs.map(([k, t]) => h('option', { value: k }, t)));
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  root.VarsTab = { mount, select: (id) => open(id), close, importFile, templateBook, get dirty() { return isDirty(); } };
})(typeof self !== 'undefined' ? self : this);
