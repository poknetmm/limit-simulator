/* ============================================================================
   도형 설정 패널 — 캔버스 아래에서 열린다(캔버스·오른쪽 계산결과는 계속 보임)
   계산 유형을 고르면 유형별 입력 양식이 나온다. 식은 코드 없이 드롭다운으로 조립한다.
   편집은 전략 사본(draft)에 하고 [저장]을 눌러야 전략에 반영된다. 저장하지 않고 다른
   단계를 누르거나 패널을 닫으면 버린다. [되돌리기]는 사본의 편집을 한 번씩 취소한다.
   패널은 구조가 바뀔 때(행 추가·삭제 등)만 다시 그린다.
   ========================================================================== */
(function (root) {
  'use strict';
  const E = root.LimitEngine, S = root.Store, D = root.Describe, { h, clear, numberField } = root.UI;

  let drawer, opts, nodeId = null, bodyEl, resultEl, saveBtn, undoBtn, dirtyBadge, pendingDelete = false;
  let draft = null, original = null;      // 편집 중인 전략 사본 / 패널을 열(저장한) 시점의 사본
  let hist = [], lastPush = 0;            // 사본 편집 되돌리기
  let resultHook = null;                  // 유형별 편집기가 미리보기 결과를 받아 그리는 곳(기초한도 계산 과정)

  const FORMATS = [['money', '금액(원)'], ['percent', '비율(%)'], ['number', '숫자']];
  const OP_LABEL = { '>=': '≥ 이상', '>': '> 초과', '<=': '≤ 이하', '<': '< 미만', '=': '= 같음', '<>': '≠ 다름' };

  let pop;
  function mount(el, o) { drawer = el; opts = o || {}; pop = root.UI.slidePopup(el, el.parentElement); S.subscribe(onChange); }
  const node = () => draft && draft.nodes.find(n => n.id === nodeId);
  const edgeKey = (e) => `${e.from}>${e.to}>${e.label || ''}`;

  // 이 단계에 관한 설정만 뽑아 비교한다(위치는 캔버스가 따로 저장하므로 뺀다)
  function signature(st) {
    const n = st.nodes.find(x => x.id === nodeId);
    if (!n) return '';
    const { x, y, ...rest } = n;
    return JSON.stringify([rest, st.finalNodeId === nodeId, st.edges.filter(e => e.from === nodeId).map(edgeKey), st.variables.map(v => v.value)]);
  }
  const isDirty = () => !!draft && signature(draft) !== signature(original);

  function resync() { draft = S.clone(S.strategy); original = S.clone(S.strategy); hist = []; lastPush = 0; }

  function show(id) {
    if (id === nodeId) return;
    if (isDirty() && S.strategy.nodes.some(n => n.id === nodeId)) {
      root.App.flash(`[${original.nodes.find(n => n.id === nodeId).name}] 단계의 저장하지 않은 변경은 반영하지 않았습니다`, 'info');
    }
    nodeId = id;
    pendingDelete = false;
    if (id) resync(); else { draft = original = null; hist = []; }
    render();
  }

  function onChange(reason) {
    if (!nodeId || ['saved', 'exported', 'canvas-move', 'canvas-layout', 'node-save'].includes(reason)) return;
    if (!S.strategy.nodes.some(n => n.id === nodeId)) { nodeId = null; draft = original = null; hist = []; render(); return; }
    // 편집 중이면 사본을 지키고 미리보기만 갱신한다. 편집 전이면 바뀐 전략을 다시 받는다
    if (isDirty()) { refreshState(); return; }
    resync();
    if (reason === 'test-input') refreshState(); else render();
  }

  // 이 단계 설정 수정(사본에): fn(단계, 사본 전략). restructure면 본문을 다시 그린다
  // 글자 입력처럼 잇따르는 수정은 되돌리기 한 번으로 묶는다
  function commit(fn, restructure) {
    const now = Date.now();
    if (restructure || !hist.length || now - lastPush > 700) {
      hist.push(S.clone(draft));
      if (hist.length > 100) hist.shift();
    }
    lastPush = now;
    fn(node(), draft);
    refreshState();
    if (restructure) renderBody();
  }

  function undo() {
    if (!nodeId || !hist.length) return false;
    draft = hist.pop();
    lastPush = 0;
    render();
    return true;
  }

  // 사본의 이 단계 설정을 전략 st에 옮긴다(저장·미리보기 공용).
  // 패널을 연 뒤 캔버스에서 바뀐 다른 부분(위치·다른 단계·테스트 입력값)은 그대로 둔다
  function applyDraft(st) {
    const d = node(), o = original.nodes.find(n => n.id === nodeId);
    const i = st.nodes.findIndex(n => n.id === nodeId);
    if (!d || i < 0) return;
    const cur = st.nodes[i];
    st.nodes[i] = Object.assign(S.clone(d), { x: cur.x, y: cur.y });
    if (o.name !== d.name) E.renameInFormulas(st, o.name, d.name);
    // 이 창에서 고친 전략 파라미터 값(기초한도 요소 조정) — 저장하면 변수에도 반영된다
    for (const dv of draft.variables) {
      const ov = original.variables.find(v => v.id === dv.id), sv = st.variables.find(v => v.id === dv.id);
      if (ov && sv && JSON.stringify(ov.value) !== JSON.stringify(dv.value)) sv.value = S.clone(dv.value);
    }
    if (draft.finalNodeId === nodeId) st.finalNodeId = nodeId;
    else if (st.finalNodeId === nodeId) st.finalNodeId = null;
    // 나가는 화살표: 사본의 것 + 패널을 연 뒤 캔버스에서 새로 이은 것(경로 이름은 사본에 맞춘다)
    const origKeys = new Set(original.edges.filter(e => e.from === nodeId).map(edgeKey));
    const ports = root.Canvas.ports(d);
    const added = st.edges.filter(e => e.from === nodeId && !origKeys.has(edgeKey(e))).map(e => {
      const x = { from: e.from, to: e.to };
      if (d.type === 'branch') x.label = ports.includes(e.label) ? e.label : ports[0];
      return x;
    });
    const ids = new Set(st.nodes.map(n => n.id));
    const nowKeys = new Set(st.edges.map(edgeKey));
    // 패널에서 손대지 않은 화살표는 지금 캔버스에 남아 있을 때만 둔다(캔버스에서 지우거나 옮긴 것을 되살리지 않게)
    const kept = draft.edges.filter(e => e.from === nodeId && ids.has(e.to) && (nowKeys.has(edgeKey(e)) || !origKeys.has(edgeKey(e))));
    const seen = new Set();
    st.edges = [...st.edges.filter(e => e.from !== nodeId), ...kept.map(e => S.clone(e)), ...added]
      .filter(e => { const k = edgeKey(e); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  function save() {
    if (!isDirty()) return;
    const name = node().name;
    S.update(st => applyDraft(st), 'node-save');
    resync();
    render();
    root.App.flash(`[${name}] 단계를 저장했습니다`, 'ok');
  }

  function refreshState() {
    if (!saveBtn) return;
    const dirty = isDirty();
    saveBtn.disabled = !dirty;
    undoBtn.disabled = !hist.length;
    dirtyBadge.hidden = !dirty;
    updateResult();
  }

  // ── 틀 ──────────────────────────────────────────────────────────────────
  function render() {
    resultHook = null;   // 앞 단계 편집기의 계산 과정 그리기가 다른 단계 결과로 불리지 않게(renderBody가 다시 건다)
    // 닫을 때는 내용을 지우지 않는다 — 내려가는 동안 빈 상자가 보이지 않게
    if (!nodeId) { pop.close(); resultEl = saveBtn = null; return; }
    clear(drawer);
    const n = node();
    const s = draft;

    const nameErr = h('span', { class: 'field-error' });
    const nameIn = h('input', { type: 'text', class: 'node-name-input', value: n.name, 'aria-label': '단계 이름' });
    nameIn.addEventListener('input', () => { const p = S.nameProblem(nameIn.value, n.id); nameErr.textContent = p || ''; nameIn.classList.toggle('invalid', !!p); });
    nameIn.addEventListener('change', () => {
      const v = nameIn.value.trim();
      if (S.nameProblem(v, n.id) || v === n.name) { nameIn.value = n.name; nameErr.textContent = ''; nameIn.classList.remove('invalid'); return; }
      const old = n.name;
      commit((m, st) => { m.name = v; E.renameInFormulas(st, old, v); });
    });

    const typeSel = select(Object.entries(E.NODE_TYPES), n.type, (t) => {
      commit((m, st) => {
        m.type = t;
        m.config = root.Canvas.defaultConfig(t);
        const first = root.Canvas.ports(m)[0];
        for (const e of st.edges) if (e.from === m.id) { if (t === 'branch') e.label = first; else delete e.label; }
      });
      render();
    });
    typeSel.setAttribute('aria-label', '계산 유형');
    typeSel.title = '유형을 바꾸면 이 단계의 설정이 초기화됩니다';

    const fmtSel = select(FORMATS, n.format || 'number', (f) => commit(m => { m.format = f; }));
    fmtSel.setAttribute('aria-label', '결과 표시 형식');

    const finalCb = h('input', { type: 'checkbox', checked: s.finalNodeId === n.id, id: 'finalCb' });
    finalCb.addEventListener('change', () => commit((m, st) => { st.finalNodeId = finalCb.checked ? m.id : null; }));

    dirtyBadge = h('span', { class: 'badge badge-warn' }, '저장 안 됨');
    undoBtn = h('button', { class: 'btn btn-small', type: 'button', title: '이 단계 편집을 한 번 되돌립니다 (Ctrl+Z)', onclick: undo }, '↶ 되돌리기');
    saveBtn = h('button', { class: 'btn btn-primary btn-small', type: 'button', title: '저장해야 전략에 반영됩니다. 저장하지 않고 다른 단계를 누르면 버립니다', onclick: save }, '저장');

    drawer.append(
      h('div', { class: 'drawer-head' },
        h('div', { class: 'drawer-title' }, nameIn, nameErr),
        h('label', { class: 'mini-field' }, h('span', {}, '계산 유형'), typeSel),
        h('label', { class: 'mini-field' }, h('span', {}, '표시'), fmtSel),
        h('label', { class: 'check', for: 'finalCb', title: '비워 두면 흐름의 마지막 단계가 최종한도입니다' }, finalCb, ' 최종한도 단계'),
        h('span', { class: 'spacer' }),
        dirtyBadge, undoBtn, saveBtn,
        h('button', { class: 'btn-round', type: 'button', title: '패널 닫기 (Esc) — 저장하지 않은 변경은 버립니다', 'aria-label': '패널 닫기', onclick: () => opts.onClose && opts.onClose() }, '✕')),
      resultEl = h('div', { class: 'drawer-result' }),
      h('div', { class: 'drawer-main' },
        h('div', {}, bodyEl = h('div', { class: 'drawer-body' }), deleteArea(n)),
        root.Guide.render(n.type, n.config)));
    refreshState();
    renderBody();
    pop.open();   // 내용을 채운 뒤 열어야 높이(--pop-h)가 맞게 잡힌다
  }

  // 저장 전이면 사본을 반영한 미리보기로 계산한다 — 저장하기 전에 결과를 확인할 수 있게
  function updateResult() {
    if (!resultEl) return;
    const n = node();
    if (!n) return;
    const dirty = isDirty();
    let r;
    try {
      let st = S.strategy;
      if (dirty) { st = S.clone(S.strategy); applyDraft(st); }
      r = E.evaluate(st, S.evalInputs());
    } catch (e) { r = { steps: {} }; }
    const st = r.steps[n.id] || {};
    if (resultHook) resultHook(st);
    clear(resultEl);
    if (st.skipped) resultEl.append(h('span', { class: 'muted' }, '앞 단계에서 거절되어 이 단계는 계산하지 않았습니다'));
    else if (!st.active) resultEl.append(h('span', { class: 'muted' }, '지금 테스트 입력값으로는 이 단계를 지나지 않습니다(다른 경로)'));
    else if (st.error) resultEl.append(h('span', { class: 'err' }, `오류: ${st.error}`));
    else {
      resultEl.append(h('span', { class: 'muted' }, dirty ? '저장 전 미리보기 결과 ' : '지금 테스트 입력값의 결과 '), h('strong', {}, D.stepValueText(n, st)));
      if (dirty && r.final !== null && r.final !== undefined) resultEl.append(h('span', { class: 'muted' }, ` · 최종한도 ${E.fmtValue(r.final, 'money')}`));
      if (st.chosen) resultEl.append(h('span', { class: 'muted' }, ` · 선택된 항목 ${st.chosen}`));
      if (n.type === 'branch') resultEl.append(h('span', { class: 'muted' }, ' 경로로 진행'));
      if (st.factor !== undefined) resultEl.append(h('span', { class: 'muted' }, ` · 현가계수 ${E.fmtNum(st.factor, 4)}`));
    }
  }

  function renderBody() {
    clear(bodyEl);
    resultHook = null;
    const n = node();
    if (!n) return;
    const ed = EDITORS[n.type];
    bodyEl.appendChild(ed ? ed(n, n.config) : h('div', { class: 'muted' }, '알 수 없는 유형입니다'));
    if (resultHook) updateResult();
  }

  // 고급 수식에 쓸 수 있는 이름: 변수·단계 + 기초한도 중간값(예: 기초 PVA › 실질월가처분소득)
  function allNames(excludeId) {
    const s = S.strategy;
    return [...s.variables.map(v => v.name), ...s.nodes.filter(x => x.id !== excludeId).flatMap(x =>
      [x.name, ...(E.PARTS[x.type] || []).map(([, label]) => `${x.name}${E.PART_SEP}${label}`)])];
  }

  // ── 공용 입력 부품 ──────────────────────────────────────────────────────
  function select(pairs, value, onChange) {
    const sel = h('select', {}, pairs.map(([k, t]) => h('option', { value: k }, t)));
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }
  function optgroup(label, pairs) { return h('optgroup', { label }, pairs.map(([k, t]) => h('option', { value: k }, t))); }
  function field(label, control, hint) {
    return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), h('div', { class: 'field-control' }, control, hint ? h('div', { class: 'hint' }, hint) : null));
  }
  function btn(text, onclick, cls) { return h('button', { class: `btn btn-small ${cls || ''}`, type: 'button', onclick }, text); }
  function xBtn(onclick, label) { return h('button', { class: 'btn-icon', type: 'button', title: label || '삭제', 'aria-label': label || '삭제', onclick }, '✕'); }

  // 값 선택기: 고객 입력값 / 전략 파라미터 / 앞 단계 / 숫자·글자 직접 입력
  function refPicker(ref, onPick, o) {
    o = o || {};
    const s = S.strategy;
    const sel = h('select', { class: 'ref-select' });
    sel.appendChild(h('option', { value: '' }, o.optional ? '(없음)' : '— 선택 —'));
    if (o.boolOf) sel.appendChild(optgroup('예/아니오', [['bool:1', '예'], ['bool:0', '아니오']]));
    if (o.choiceOf) sel.appendChild(optgroup(`${o.choiceOf.name}의 선택지`, (o.choiceOf.options || []).map(x => [`opt:${x}`, x])));
    const direct = [];
    if (o.allowNum !== false) direct.push(['num', '숫자 직접 입력']);
    if (o.allowStr) direct.push(['str', '글자 직접 입력']);
    if (direct.length) sel.appendChild(optgroup('직접 입력', direct));
    // 화살표가 두 개 이상 들어오는 단계(자동 합류)에서만 — 이번에 지나온 쪽 앞 단계의 값
    if (s.edges.filter(e => e.to === nodeId).length >= 2 || (ref && ref.k === 'in')) sel.appendChild(optgroup('합류', [['in', E.IN_NAME]]));
    const vars = s.variables.filter(v => v.type !== 'table' && v.type !== 'debt');
    const ins = vars.filter(v => v.kind === 'input'), pars = vars.filter(v => v.kind !== 'input');
    if (ins.length) sel.appendChild(optgroup('고객 입력값', ins.map(v => [`var:${v.id}`, v.name])));
    if (pars.length) sel.appendChild(optgroup('전략 파라미터', pars.map(v => [`var:${v.id}`, `${v.name} (${E.fmtValue(v.value, v.type)})`])));
    const { order } = E.order(s);
    const byId = new Map(s.nodes.map(n => [n.id, n]));
    const nodes = [...order, ...s.nodes.map(n => n.id).filter(id => !order.includes(id))].map(id => byId.get(id)).filter(n => n.id !== o.exclude);
    // 기초한도·부채 집계 단계는 중간값(실질월가처분소득·고금리채무 등)도 고를 수 있다
    if (nodes.length) sel.appendChild(optgroup('계산 단계', nodes.flatMap(n => [[`node:${n.id}`, n.name],
      ...(E.PARTS[n.type] || []).map(([part, label]) => [`part:${n.id}:${part}`, `${n.name}${E.PART_SEP}${label}`])])));

    let cur = '';
    if (ref) {
      if (ref.k === 'var' || ref.k === 'node') cur = `${ref.k}:${ref.id}`;
      else if (ref.k === 'part') cur = `part:${ref.id}:${ref.part}`;
      else if (ref.k === 'in') cur = 'in';
      else if (ref.k === 'num') cur = o.boolOf && (ref.v === 1 || ref.v === 0) ? `bool:${ref.v}` : 'num';
      else if (ref.k === 'str') cur = o.choiceOf && (o.choiceOf.options || []).includes(ref.v) ? `opt:${ref.v}` : 'str';
    }
    sel.value = cur;
    if (sel.value !== cur) sel.value = '';   // 삭제된 대상 등

    const extra = h('span', { class: 'ref-extra' });
    let current = ref;
    const drawExtra = () => {
      clear(extra);
      if (sel.value === 'num') {
        extra.appendChild(numberField(current && current.k === 'num' ? current.v : 0, o.numFormat || 'number', (v) => { current = { k: 'num', v: v ?? 0 }; onPick(current); }));
      } else if (sel.value === 'str') {
        const t = h('input', { type: 'text', value: current && current.k === 'str' ? current.v : '', placeholder: '글자' });
        t.addEventListener('change', () => { current = { k: 'str', v: t.value }; onPick(current); });
        extra.appendChild(t);
      }
    };
    sel.addEventListener('change', () => {
      const v = sel.value;
      if (!v) current = null;
      else if (v === 'in') current = { k: 'in' };
      else if (v === 'num') current = { k: 'num', v: current && current.k === 'num' ? current.v : 0 };
      else if (v === 'str') current = { k: 'str', v: current && current.k === 'str' ? current.v : '' };
      else if (v.startsWith('bool:')) current = { k: 'num', v: Number(v.slice(5)) };
      else if (v.startsWith('opt:')) current = { k: 'str', v: v.slice(4) };
      else if (v.startsWith('part:')) { const [, id, part] = v.split(':'); current = { k: 'part', id, part }; }
      else { const [k, id] = v.split(':'); current = { k, id }; }
      drawExtra();
      onPick(current);
    });
    drawExtra();
    return h('span', { class: 'ref-picker' }, sel, extra);
  }

  function tablePicker(ref, onPick, bandOnly) {
    const tables = S.strategy.variables.filter(v => v.type === 'table' && (!bandOnly || (v.rows.mode === 'band' && !v.cols)));
    const sel = select([['', tables.length ? '— 표 선택 —' : '(쓸 수 있는 표가 없습니다 — 변수·표 탭에서 만드세요)'], ...tables.map(t => [t.id, t.name])], ref ? ref.id : '', (id) => onPick(id ? { k: 'var', id } : null));
    return sel;
  }

  // 고른 표를 읽기 전용으로 보여 준다. 고치는 곳은 변수·표 탭 하나로 둔다(두 곳에서 고치면 헷갈린다)
  function tablePreview(tv) {
    const cell = (v) => h('td', { class: 'num' }, v === null || v === undefined || v === '' ? '—' : E.fmtNum(v));
    const head = h('tr', {}, h('th', {}, tv.rows.mode === 'band' ? '구간' : '항목'),
      tv.cols ? tv.cols.keys.map((_, j) => h('th', { class: 'num' }, E.axisKeyLabel(tv.cols, j))) : h('th', { class: 'num' }, '값'));
    const body = tv.rows.keys.map((_, i) => h('tr', {}, h('th', {}, E.axisKeyLabel(tv.rows, i)),
      (tv.cols ? tv.cols.keys : [null]).map((__, j) => cell((tv.cells[i] || [])[j]))));
    const goEdit = btn('변수·표 탭에서 고치기', () => { root.App.showTab('vars'); root.VarsTab.select(tv.id); });
    return h('div', { class: 'table-preview' },
      h('div', { class: 'table-scroll' }, h('table', { class: 'grid preview-grid' }, h('thead', {}, head), h('tbody', {}, body))),
      h('div', { class: 'row-actions' }, goEdit, tv.desc ? h('span', { class: 'hint' }, tv.desc) : null));
  }

  // 조건 묶음: "모두 만족 / 하나라도 만족" + 비교 줄들 + (맨 위에서만) 묶음 1단계
  function groupEditor(g, parent, idx) {
    const nested = !!parent;
    const box = h('div', { class: nested ? 'cond-group nested' : 'cond-group' });
    box.appendChild(h('div', { class: 'cond-head' },
      h('span', { class: 'cond-title' }, nested ? '묶음' : '조건'),
      select([['and', '아래를 모두 만족 (그리고)'], ['or', '아래 중 하나라도 만족 (또는)']], g.logic || 'and', (v) => commit(() => { g.logic = v; })),
      nested ? xBtn(() => commit(() => parent.items.splice(idx, 1), true), '묶음 삭제') : null));
    (g.items || []).forEach((it, i) => box.appendChild(it.items ? groupEditor(it, g, i) : condRow(g, i)));
    if (!(g.items || []).length) box.appendChild(h('div', { class: 'muted small' }, '조건이 없습니다. 아래 버튼으로 추가하세요.'));
    box.appendChild(h('div', { class: 'row-actions' },
      btn('+ 조건', () => commit(() => { g.items = g.items || []; g.items.push({ left: null, op: '>=', right: { k: 'num', v: 0 } }); }, true)),
      nested ? null : btn('+ 묶음', () => commit(() => { g.items.push({ logic: 'or', items: [{ left: null, op: '>=', right: { k: 'num', v: 0 } }] }); }, true))));
    return box;
  }

  function condRow(g, i) {
    const it = g.items[i];
    const leftVar = it.left && it.left.k === 'var' ? S.strategy.variables.find(v => v.id === it.left.id) : null;
    const left = refPicker(it.left, (r) => commit(() => {
      it.left = r;
      const v = r && r.k === 'var' ? S.strategy.variables.find(x => x.id === r.id) : null;
      if (v && v.type === 'bool') { it.op = '='; it.right = { k: 'num', v: 1 }; }
      if (v && v.type === 'choice') { it.op = '='; it.right = { k: 'str', v: (v.options || [])[0] || '' }; }
    }, true), { allowNum: false, exclude: nodeId });
    const op = select(E.CMP_OPS.map(k => [k, OP_LABEL[k]]), it.op, (v) => commit(() => { it.op = v; }));
    const right = refPicker(it.right, (r) => commit(() => { it.right = r; }), {
      allowStr: true, exclude: nodeId,
      boolOf: leftVar && leftVar.type === 'bool', choiceOf: leftVar && leftVar.type === 'choice' ? leftVar : null,
      numFormat: leftVar && ['money', 'percent'].includes(leftVar.type) ? leftVar.type : 'number',
    });
    return h('div', { class: 'cond-row' }, left, op, right, xBtn(() => commit(() => g.items.splice(i, 1), true), '조건 삭제'));
  }

  // 사칙연산 조각 끌어 옮기기: 놓는 조각의 왼쪽 절반이면 그 앞, 오른쪽 절반이면 그 뒤에 넣는다
  function tokenDrag(row, c) {
    let from = null;
    const clearMarks = () => row.querySelectorAll('.drop-before, .drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
    const target = (ev) => {
      const el = ev.target.closest && ev.target.closest('.token');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { el, i: Number(el.dataset.i), after: ev.clientX > r.left + r.width / 2 };
    };
    row.addEventListener('dragstart', (ev) => {
      const el = ev.target.closest && ev.target.closest('.token');
      if (!el) return;
      from = Number(el.dataset.i);
      el.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', String(from));
    });
    row.addEventListener('dragover', (ev) => {
      if (from === null) return;
      ev.preventDefault();
      clearMarks();
      const t = target(ev);
      if (t) t.el.classList.add(t.after ? 'drop-after' : 'drop-before');
    });
    row.addEventListener('dragleave', (ev) => { if (!row.contains(ev.relatedTarget)) clearMarks(); });
    row.addEventListener('drop', (ev) => {
      if (from === null) return;
      ev.preventDefault();
      const t = target(ev);
      const src = from;
      from = null;
      clearMarks();
      if (!t) return;
      let to = t.i + (t.after ? 1 : 0);
      if (src < to) to -= 1;
      if (to === src) return;
      commit(() => { const [tok] = c.tokens.splice(src, 1); c.tokens.splice(to, 0, tok); }, true);
    });
    row.addEventListener('dragend', () => { from = null; clearMarks(); row.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging')); });
  }

  // ── 유형별 편집기 ───────────────────────────────────────────────────────
  const EDITORS = {
    // 부채 집계: 부채표 + 고금리 기준 → 행별 원리금과 합계(중간값 5개)
    debt(n, c) {
      const tables = S.strategy.variables.filter(v => v.type === 'debt');
      const tableSel = select([['', tables.length ? '— 부채표 선택 —' : '(부채표가 없습니다 — 변수·표 탭에서 "+ 부채표"로 만드세요)'], ...tables.map(t => [t.id, t.name])],
        c.table ? c.table.id : '', (id) => commit(() => { c.table = id ? { k: 'var', id } : null; }, true));
      const t = c.table && tables.find(v => v.id === c.table.id);
      const trace = h('div', { class: 'debt-trace' });
      const wrap = h('div', { class: 'editor' },
        field('부채표', h('div', { class: 'inline' }, tableSel,
          t ? btn('변수·표 탭에서 고치기', () => { root.App.showTab('vars'); root.VarsTab.select(t.id); }) : null),
          '행마다 대출기간·금리는 전략값, 잔액은 고객 입력값(오른쪽 단일 시뮬레이션)입니다'),
        field('고금리 기준', refPicker(c.hiRate, (r) => commit(() => { c.hiRate = r; }), { exclude: n.id, numFormat: 'percent' }),
          '금리가 이 값 이상인 행의 잔액을 고금리채무로 합산합니다'),
        field('합계 규칙', h('div', { class: 'hint' }, `대출구분이 "${E.DEBT_MORT}"인 행 → 부동산 잔액, 그 밖의 행 → 신용채무. 행별 원리금 = 원리금균등 월상환액(금리 ÷ 12, 기간, 잔액)`)),
        field('계산 과정', trace));
      resultHook = (st) => {
        clear(trace);
        if (st.skipped || !st.active) { trace.appendChild(h('span', { class: 'muted' }, '지금 테스트 입력값으로는 이 단계를 계산하지 않습니다')); return; }
        if (st.error || !st.parts) { trace.appendChild(h('span', { class: 'err' }, st.error || '계산할 수 없습니다')); return; }
        const used = st.rows.filter(x => x.balance);
        if (used.length) {
          trace.appendChild(h('div', { class: 'table-scroll' }, h('table', { class: 'grid preview-grid' },
            h('thead', {}, h('tr', {}, ['업권', '대출구분', '잔액', '금리', '기간', '월 원리금', '고금리'].map((x, i) => h('th', { class: i >= 2 ? 'num' : '' }, x)))),
            h('tbody', {}, used.map(x => h('tr', {},
              h('td', {}, x.sector), h('td', {}, x.kind),
              h('td', { class: 'num' }, E.fmtValue(x.balance, 'money')), h('td', { class: 'num' }, E.fmtValue(x.rate, 'percent')),
              h('td', { class: 'num' }, `${E.fmtNum(x.months)}개월`), h('td', { class: 'num' }, E.fmtValue(x.pay, 'money')),
              h('td', { class: 'num' }, x.high ? '고금리' : '—')))))));
        } else {
          trace.appendChild(h('div', { class: 'muted' }, '잔액이 있는 행이 없습니다 — 오른쪽 단일 시뮬레이션에서 잔액을 넣어 보세요'));
        }
        trace.appendChild(h('div', { class: 'debt-sum' }, E.DEBT_PARTS.map(([k, label]) =>
          h('div', { class: 'debt-sum-item' }, h('span', { class: 'muted small' }, label), h('strong', {}, E.fmtValue(st.parts[k], 'money'))))));
      };
      return wrap;
    },

    // 기초한도: 공식 → 요소 8개(변수 고르기 + 전략 파라미터 값 조정) → 값을 넣은 계산 과정
    pva(n, c) {
      const L = Object.fromEntries(E.PVA_INPUTS.map(([k, label]) => [k, label]));
      const wrap = h('div', { class: 'editor' });
      wrap.appendChild(field('공식', h('ol', { class: 'pva-formula' },
        h('li', {}, h('strong', {}, '불량률 조정소득'), ` = ${L.income} × (1 − ${L.bad} × ${L.annual})`),
        h('li', {}, h('strong', {}, '월가처분소득'), ` = 불량률 조정소득 − ${L.pay} − ${L.living}`),
        h('li', {}, h('strong', {}, '실질월가처분소득'), ` = 월가처분소득 × ${L.dsr}`),
        h('li', {}, h('strong', {}, '기초 PVA'), ` = 실질월가처분소득 × 현가계수   현가계수 = [1 − (1 + 금리 ÷ 12)^−기간] ÷ (금리 ÷ 12)`))));
      for (const [k, label, fmt] of E.PVA_INPUTS) {
        const valHost = h('span', { class: 'pva-val' });
        const drawVal = () => {
          clear(valHost);
          const r = c[k];
          const v = r && r.k === 'var' && draft.variables.find(x => x.id === r.id);
          if (!v) return;
          if (v.kind === 'input') { valHost.appendChild(h('span', { class: 'hint' }, '고객 입력값 — 테스트 값은 오른쪽 단일 시뮬레이션에서 바꿉니다')); return; }
          if (!['money', 'number', 'percent'].includes(v.type)) return;
          valHost.append(h('span', { class: 'muted small' }, '파라미터 값'),
            numberField(v.value, v.type, (x) => commit((m, st) => { st.variables.find(y => y.id === v.id).value = x ?? 0; })));
        };
        const picker = refPicker(c[k], (r) => { commit(() => { c[k] = r; }); drawVal(); }, { exclude: n.id, numFormat: fmt });
        drawVal();
        wrap.appendChild(field(label, h('div', { class: 'inline' }, picker, valHost)));
      }
      wrap.appendChild(h('div', { class: 'hint' }, '전략 파라미터 값을 여기서 고치면 저장할 때 변수·표 탭의 값도 바뀝니다(그 변수를 쓰는 다른 단계에도 적용)'));
      const trace = h('div', { class: 'pva-trace' });
      wrap.appendChild(field('계산 과정', trace));
      resultHook = (st) => {
        clear(trace);
        if (st.skipped || !st.active) { trace.appendChild(h('span', { class: 'muted' }, '지금 테스트 입력값으로는 이 단계를 계산하지 않습니다')); return; }
        if (st.error || !st.parts) { trace.appendChild(h('span', { class: 'err' }, st.error || '계산할 수 없습니다')); return; }
        const g = st.inputs, p = st.parts, f = (v, t) => E.fmtValue(v, t);
        const line = (no, expr, val, t) => h('div', { class: 'pva-line' }, h('span', { class: 'pva-no' }, no), h('span', {}, expr), h('strong', {}, `= ${f(val, t)}`));
        trace.append(
          line('①', `${f(g.income, 'money')} × (1 − ${f(g.bad, 'percent')} × ${E.fmtNum(g.annual)})`, p.adjinc, 'money'),
          line('②', `${f(p.adjinc, 'money')} − ${f(g.pay, 'money')} − ${f(g.living, 'money')}`, p.free, 'money'),
          line('③', `${f(p.free, 'money')} × ${f(g.dsr, 'percent')}`, p.realfree, 'money'),
          line('④', `${f(p.realfree, 'money')} × 현가계수 ${E.fmtNum(p.factor, 4)} (연 ${f(g.rate, 'percent')}, ${E.fmtNum(g.months)}개월)`, st.value, 'money'));
      };
      return wrap;
    },

    arith(n, c) {
      c.tokens = c.tokens || [];
      const wrap = h('div', { class: 'editor' });
      // 조각을 누르면 고르기만 한다(바로 지우지 않음). 지우기는 [고른 조각 삭제] 또는 Delete 키
      let picked = null;
      const row = h('div', { class: 'token-row' });
      const delPicked = btn('고른 조각 삭제', () => { if (picked !== null) commit(() => c.tokens.splice(picked, 1), true); });
      delPicked.disabled = true;
      const pick = (i) => {
        picked = picked === i ? null : i;
        row.querySelectorAll('.token').forEach(el => el.classList.toggle('picked', Number(el.dataset.i) === picked));
        delPicked.disabled = picked === null;
      };
      c.tokens.forEach((t, i) => {
        const el = h('span', { class: `token token-${t.t}`, draggable: 'true', tabindex: '0', 'data-i': i, title: '눌러서 고르기 · 끌어서 순서 바꾸기' },
          t.t === 'ref' ? D.refText(t.ref) : t.t === 'num' ? E.fmtNum(t.v) : t.t === 'lp' ? '(' : t.t === 'rp' ? ')' : (D.OP_TEXT[t.v] || t.v));
        el.addEventListener('click', () => pick(i));
        el.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(i); }
          if ((ev.key === 'Delete' || ev.key === 'Backspace') && picked === i) { ev.preventDefault(); delPicked.click(); }
        });
        row.appendChild(el);
      });
      if (!c.tokens.length) row.appendChild(h('span', { class: 'muted' }, '아래에서 값과 연산 기호를 차례로 넣으세요. 예) [월소득] × 12'));
      tokenDrag(row, c);
      let pending = null;
      const picker = refPicker(null, (r) => { pending = r; }, { exclude: n.id });
      const push = (tok) => commit(() => c.tokens.push(tok), true);
      const opBtn = (label, tok) => h('button', { class: 'btn-op', type: 'button', onclick: () => push(tok) }, label);
      let err = '';
      try { if (c.tokens.length) E.parseTokens(c.tokens); } catch (e) { err = e.message; }
      wrap.append(
        field('식', row, err ? h('span', { class: 'err' }, err) : null),
        field('넣기', h('div', { class: 'token-adder' },
          picker,
          btn('값 넣기', () => { if (!pending) return; push(pending.k === 'num' ? { t: 'num', v: pending.v } : { t: 'ref', ref: pending }); }, 'btn-accent'),
          h('span', { class: 'op-group' },
            opBtn('+', { t: 'op', v: '+' }), opBtn('−', { t: 'op', v: '-' }), opBtn('×', { t: 'op', v: '*' }), opBtn('÷', { t: 'op', v: '/' }),
            opBtn('^', { t: 'op', v: '^' }), opBtn('(', { t: 'lp' }), opBtn(')', { t: 'rp' })),
          c.tokens.length ? delPicked : null,
          c.tokens.length ? btn('마지막 조각 지우기', () => commit(() => c.tokens.pop(), true)) : null),
          '곱셈·나눗셈이 덧셈·뺄셈보다 먼저 계산됩니다. 계산 순서를 바꾸려면 괄호를 넣으세요. 조각은 끌어서 자리를 옮기고, 눌러서 고른 뒤 [고른 조각 삭제]나 Delete 키로 지웁니다.'));
      return wrap;
    },

    formula(n, c) {
      const lang = c.lang || 'excel';
      const PLACEHOLDER = {
        excel: '예) MAX([허용총액] - [신용채무], 0)',
        python: '예) [허용총액] - [신용채무] if [신용채무] < [허용총액] else 0\n\n여러 줄:\nif [등급] >= 9:\n    0\nelse:\n    [한도 후보]',
        r: '예) ifelse([신용채무] < [허용총액], [허용총액] - [신용채무], 0)\n\n또는 if ([등급] >= 9) 0 else [한도 후보]',
      };
      // 문법을 바꾸면 사용법·예시도 바뀌므로 패널을 다시 그린다. 이미 쓴 수식은 그대로 둔다(자동 번역하지 않음)
      const langSel = select(Object.entries(E.LANGS), lang, (v) => { commit(() => { c.lang = v === 'excel' ? undefined : v; }); render(); });
      const ta = h('textarea', { class: 'formula-input', rows: lang === 'excel' ? 3 : 6, spellcheck: 'false', placeholder: PLACEHOLDER[lang] });
      ta.value = c.text || '';
      // 파이썬 들여쓰기: Tab 키로 공백 4칸
      ta.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Tab' || lang === 'excel') return;
        ev.preventDefault();
        ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      });
      const msg = h('div', { class: 'hint' });
      const check = () => {
        const names = new Set(allNames().concat(E.IN_NAME));
        try {
          const unknown = E.formulaNames(ta.value, lang).filter(v => !names.has(v));
          E.parseFormula(ta.value, lang);
          msg.className = unknown.length ? 'err' : 'hint ok-text';
          msg.textContent = unknown.length ? `찾을 수 없는 이름: ${unknown.join(', ')}` : `${E.LANGS[lang]} 문법으로 올바르게 읽었습니다`;
        } catch (e) { msg.className = 'err'; msg.textContent = e.message; }
      };
      ta.addEventListener('input', () => { commit(() => { c.text = ta.value; }); check(); });
      const merged = S.strategy.edges.filter(e => e.to === n.id).length >= 2;
      const names = [...(merged ? [E.IN_NAME] : []), ...allNames(n.id)];
      const ins = select([['', '이름 넣기…'], ...names.map(x => [x, x])], '', (v) => {
        if (!v) return;
        ta.setRangeText(`[${v}]`, ta.selectionStart, ta.selectionEnd, 'end');
        ta.focus();
        ta.dispatchEvent(new Event('input'));
        ins.value = '';
      });
      check();
      return h('div', { class: 'editor' },
        field('문법', langSel, lang === 'excel' ? null : `${E.LANGS[lang]} 문법으로 쓰고 계산은 시뮬레이터가 합니다. 반복문·변수 대입·import 는 쓸 수 없습니다`),
        field('수식', h('div', { class: 'full' }, ta, msg)),
        field('도움', h('div', { class: 'formula-tools' }, ins,
          h('span', { class: 'hint' }, '이름은 [ ]로 감쌉니다 · 쓸 수 있는 함수·기호는 오른쪽 사용법의 범례를 보세요'))));
    },

    lookup(n, c) {
      const t = c.table && S.strategy.variables.find(v => v.id === c.table.id);
      const axisHint = (ax) => ax.mode === 'band' ? '구간표 — 값이 들어가는 구간을 찾습니다' : `목록 — 같은 항목을 찾습니다 (${ax.keys.join(', ')})`;
      return h('div', { class: 'editor' },
        field('표', tablePicker(c.table, (r) => commit(m => { m.config.table = r; const tv = r && S.strategy.variables.find(v => v.id === r.id); if (!tv || !tv.cols) m.config.col = null; }, true))),
        t ? field('표 내용', tablePreview(t)) : null,
        t ? field('행 기준값', refPicker(c.row, (r) => commit(() => { c.row = r; }), { exclude: n.id }), axisHint(t.rows)) : null,
        t && t.cols ? field('열 기준값', refPicker(c.col, (r) => commit(() => { c.col = r; }), { exclude: n.id }), axisHint(t.cols)) : null);
    },

    progressive(n, c) {
      const t = c.table && S.strategy.variables.find(v => v.id === c.table.id);
      return h('div', { class: 'editor' },
        field('구간표', tablePicker(c.table, (r) => commit(() => { c.table = r; }, true), true), '1차원 구간표만 고를 수 있습니다. 구간마다 (구간 안에 든 금액 × 구간 값)을 더합니다 — 누진세와 같은 방식'),
        t ? field('표 내용', tablePreview(t)) : null,
        field('기준값', refPicker(c.base, (r) => commit(() => { c.base = r; }), { exclude: n.id })));
    },

    minmax(n, c) {
      c.items = c.items || [];
      const list = h('div', { class: 'item-list' });
      c.items.forEach((r, i) => list.appendChild(h('div', { class: 'item-row' },
        refPicker(r, (x) => commit(() => { c.items[i] = x; }), { exclude: n.id }),
        xBtn(() => commit(() => c.items.splice(i, 1), true), '항목 삭제'))));
      list.appendChild(btn('+ 비교 항목', () => commit(() => c.items.push(null), true)));
      return h('div', { class: 'editor' },
        field('고르는 값', select([['min', '가장 작은 값 (MIN)'], ['max', '가장 큰 값 (MAX)']], c.mode || 'min', (v) => commit(() => { c.mode = v; }))),
        field('비교 항목', list, '선택된 항목이 결정요인으로 기록됩니다'));
    },

    cond(n, c) {
      return h('div', { class: 'editor' },
        field('만약', groupEditor(c.when)),
        field('맞으면', refPicker(c.then, (r) => commit(() => { c.then = r; }), { exclude: n.id, allowStr: true })),
        field('아니면', refPicker(c.else, (r) => commit(() => { c.else = r; }), { exclude: n.id, allowStr: true })));
    },

    cutoff(n, c) {
      const reason = h('input', { type: 'text', value: c.reason || '', placeholder: '예) 등급 컷오프' });
      reason.addEventListener('input', () => commit(() => { c.reason = reason.value; }));
      return h('div', { class: 'editor' },
        field('걸리는 조건', groupEditor(c.when)),
        field('걸리면', select([['reject', '대출 거절 — 이후 계산 중단'], ['zero', '0원 처리 — 계산은 계속']], c.action || 'reject', (v) => commit(() => { c.action = v; }))),
        field('사유', reason, '결과 패널의 거절 사유·결정요인으로 표시됩니다'),
        field('통과하면', refPicker(c.input, (r) => commit(() => { c.input = r; }), { exclude: n.id, optional: true }), '조건에 안 걸렸을 때 이 단계의 값. 비워 두면 "통과"로만 표시합니다'));
    },

    pv(n, c) {
      return h('div', { class: 'editor' },
        field('연 금리', refPicker(c.rate, (r) => commit(() => { c.rate = r; }), { exclude: n.id, numFormat: 'percent' })),
        field('기간(개월)', refPicker(c.months, (r) => commit(() => { c.months = r; }), { exclude: n.id })),
        field('월 상환액', refPicker(c.payment, (r) => commit(() => { c.payment = r; }), { exclude: n.id, optional: true }),
          '결과 = 월 상환액 × 연금현가계수, 월 금리 = 연 금리 ÷ 12. 비워 두면 계수만 계산합니다'));
    },

    branch(n, c) {
      const wrap = h('div', { class: 'editor' });
      const labels = () => [...c.cases.map(k => k.label), c.elseLabel || '그 외'];
      const labelInput = (value, apply) => {
        const inp = h('input', { type: 'text', class: 'label-input', value });
        inp.addEventListener('change', () => {
          const v = inp.value.trim();
          if (!v || (v !== value && labels().includes(v))) { inp.value = value; root.App.flash('경로 이름은 비울 수 없고 겹칠 수 없습니다', 'danger'); return; }
          commit((m, st) => { apply(v); for (const e of st.edges) if (e.from === m.id && e.label === value) e.label = v; }, true);
        });
        return inp;
      };
      c.cases.forEach((k, i) => wrap.appendChild(h('div', { class: 'case-box' },
        h('div', { class: 'case-head' }, h('span', { class: 'case-no' }, `경로 ${i + 1}`), labelInput(k.label, (v) => { k.label = v; }),
          c.cases.length > 1 ? xBtn(() => commit((m, st) => { st.edges = st.edges.filter(e => !(e.from === m.id && e.label === k.label)); c.cases.splice(i, 1); }, true), '경로 삭제') : null),
        groupEditor(k.when))));
      wrap.appendChild(h('div', { class: 'row-actions' }, btn('+ 경로', () => commit(() => {
        let j = c.cases.length + 1;
        while (labels().includes(`경로${j}`)) j++;
        c.cases.push({ label: `경로${j}`, when: { logic: 'and', items: [] } });
      }, true))));
      wrap.appendChild(h('div', { class: 'case-box else' },
        h('div', { class: 'case-head' }, h('span', { class: 'case-no' }, '그 외'), labelInput(c.elseLabel || '그 외', (v) => { c.elseLabel = v; })),
        h('div', { class: 'hint' }, '위 조건에 하나도 안 맞으면 이 경로로 갑니다. 조건은 위에서부터 차례로 확인합니다.')));
      wrap.appendChild(h('div', { class: 'hint' }, '캔버스에서 이 도형 아래의 경로 이름 점을 끌어 다음 단계에 연결하세요.'));
      return wrap;
    },

  };

  // ── 삭제 ────────────────────────────────────────────────────────────────
  function deleteArea(n) {
    const area = h('div', { class: 'drawer-foot' });
    const doDelete = () => {
      S.update(st => {
        st.nodes = st.nodes.filter(x => x.id !== n.id);
        st.edges = st.edges.filter(e => e.from !== n.id && e.to !== n.id);
        if (st.finalNodeId === n.id) st.finalNodeId = null;
      }, 'node-delete');
      opts.onClose && opts.onClose();
    };
    if (pendingDelete) {
      const refs = E.findReferences(S.strategy, n.id);
      area.appendChild(h('div', { class: 'warn-box' },
        refs.length ? `[${n.name}]의 값을 쓰는 단계가 ${refs.length}곳 있습니다: ${refs.map(x => x.name).join(', ')}. 삭제하면 이 단계들이 오류가 됩니다. ` : `[${n.name}] 단계와 연결된 화살표를 삭제합니다. `,
        h('span', { class: 'row-actions inline' },
          h('button', { class: 'btn btn-danger btn-small', type: 'button', onclick: doDelete }, '삭제'),
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => { pendingDelete = false; render(); } }, '취소'))));
    } else {
      area.appendChild(h('button', { class: 'btn btn-small btn-ghost-danger', type: 'button', onclick: () => { pendingDelete = true; render(); } }, '이 단계 삭제'));
    }
    return area;
  }

  root.Panel = { mount, show, undo };
})(typeof self !== 'undefined' ? self : this);
