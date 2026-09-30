/* ============================================================================
   변수·표 탭 — 변수 목록(위) + 선택한 변수 편집기(아래)
   목록은 수정할 때마다 다시 그리고, 편집기는 선택이 바뀌거나 다른 곳에서 값이
   바뀌었을 때만 다시 그린다(입력 중인 칸의 커서가 튀지 않게).
   ========================================================================== */
(function (root) {
  'use strict';
  const E = root.LimitEngine, S = root.Store, { h, clear, numberField } = root.UI;

  let host, listEl, editorEl, pop;
  let selectedId = null;
  let pendingDelete = null;

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
    listEl = h('div', { class: 'var-list' });
    editorEl = h('div', { class: 'var-editor' });
    host.append(h('div', { class: 'vars-scroll' }, toolbar, listEl), editorEl);
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
    if (reason === 'saved' || reason === 'exported') return;
    if (reason === 'vars-edit') { renderList(); return; }
    if (reason === 'load' || reason === 'new' || reason === 'example' || reason === 'import') { selectedId = null; pendingDelete = null; }
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
  function selected() { return vars().find(v => v.id === selectedId) || null; }

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
          onclick: () => { selectedId = v.id; pendingDelete = null; renderAll(); },
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
    selectedId = id; renderAll();
    focusName();
  }

  function addTable() {
    const id = E.newId('t');
    S.update(s => s.variables.push({
      id, name: S.uniqueName('새 표'), kind: 'param', type: 'table', desc: '',
      rows: { mode: 'band', keys: [0, 10] }, cols: null, cells: [[0], [0]],
    }), 'vars-add');
    selectedId = id; renderAll();
    focusName();
  }

  function addDebt() {
    const id = E.newId('d');
    S.update(s => s.variables.push({
      id, name: S.uniqueName('보유부채'), kind: 'input', type: 'debt', desc: '업권 × 대출구분별 잔액. 기간·금리는 전략값',
      rows: DEBT_DEFAULT.map(([sector, kind, months, rate]) => ({ sector, kind, months, rate, balance: 0 })),
    }), 'vars-add');
    selectedId = id; renderAll();
    focusName();
  }

  function focusName() {
    const el = editorEl.querySelector('.name-field');
    if (el) { el.focus(); el.select(); }
  }

  // 편집기에서의 수정 — 목록만 다시 그린다
  function edit(fn) { S.update(s => fn(s.variables.find(v => v.id === selectedId)), 'vars-edit'); }

  // ── 편집기 ──────────────────────────────────────────────────────────────
  function renderEditor() {
    const v = selected();
    // 닫을 때는 내용을 지우지 않는다 — 내려가는 동안 빈 상자가 보이지 않게
    if (!v) { pop.close(); return; }
    clear(editorEl);
    editorEl.appendChild(h('div', { class: 'editor-head' },
      h('div', { class: 'panel-title' }, v.type === 'table' ? '표 편집' : v.type === 'debt' ? '부채표 편집' : '변수 편집'),
      h('button', { class: 'btn-round', type: 'button', title: '닫기 (Esc)', 'aria-label': '편집 창 닫기', onclick: close }, '✕')));
    editorEl.appendChild(commonFields(v));
    editorEl.appendChild(v.type === 'table' ? tableEditor(v) : v.type === 'debt' ? debtEditor(v) : valueFields(v));
    editorEl.appendChild(deleteArea(v));
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
      const old = v.name;
      S.update(s => { s.variables.find(x => x.id === v.id).name = newName; E.renameInFormulas(s, old, newName); }, 'vars-edit');
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
          h('button', { class: 'btn btn-danger', onclick: () => { S.update(s => { s.variables = s.variables.filter(x => x.id !== v.id); }, 'vars-delete'); selectedId = null; pendingDelete = null; renderAll(); } }, '삭제'),
          h('button', { class: 'btn', onclick: () => { pendingDelete = null; renderEditor(); } }, '취소'))));
    } else {
      area.appendChild(h('button', { class: 'btn btn-ghost-danger', onclick: () => { pendingDelete = v.id; renderEditor(); } }, v.type === 'table' ? '표 삭제' : v.type === 'debt' ? '부채표 삭제' : '변수 삭제'));
    }
    return area;
  }

  function close() { selectedId = null; pendingDelete = null; renderAll(); }

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

  root.VarsTab = { mount, select: (id) => { selectedId = id; pendingDelete = null; renderAll(); } };
})(typeof self !== 'undefined' ? self : this);
