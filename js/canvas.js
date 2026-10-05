/* ============================================================================
   프로세스 탭 — 도형 캔버스
   ----------------------------------------------------------------------------
   · 도형(단계)은 HTML 카드, 화살표는 그 아래 SVG 한 장에 그린다
   · 도형 가장자리 아무 곳에서 끌어 다른 도형에 놓으면 연결. 화살표는 끌기 시작한 자리에서 나가
     놓은 자리(가장 가까운 면의 그 위치)로 들어간다. 분기 도형은 아래 경로 포트에서 끌거나, 가장자리에서 끌어
     놓은 뒤 어느 경로인지 고른다(가장자리에서 나가는 분기 화살표에는 경로 이름을 적는다)
   · 이어 둔 화살표를 끌면 끝점을 다른 도형·다른 자리로 옮긴다(빈 곳에 놓으면 취소). 선택하면 양 끝 손잡이가 나온다
   · 끄는 동안 도형 근처(SNAP)에 가면 그 도형을 강조하고 화살표 끝을 붙을 자리에 붙인다
   · 도형을 끌어 옮기고, 클릭하면 아래 설정 패널(panel.js)이 열린다. 고른 도형은 Delete 키로 지운다(예/아니오 확인)
   · 위치가 없는 단계(예시 전략·가져온 파일)는 자동 배치한다
   · 단계 추가는 왼쪽 패널의 단계 팔레트(유형 타일)에서 한다. 도형 안쪽은 머리줄(아이콘·이름) / 구분선 / 유형·값
   · 테스트 입력값을 바꾸면 지나간 화살표를 따라 빛이 한 번 흐르고, 값이 바뀐 도형은 반짝인다(애니메이션 줄이기면 끔)
   화살표는 "흐름(어느 경로를 탔는가)"이고, 계산에 쓰는 값은 설정 패널의 참조가 정한다.
   ========================================================================== */
(function (root) {
  'use strict';
  const E = root.LimitEngine, S = root.Store, D = root.Describe, { h, clear } = root.UI;

  const W = 232, H = 88, GX = 44, GY = 48, PAD = 40, GRID = 8, SNAP = 48;
  const ZOOM_KEY = 'limitsim.zoom';
  const SVGNS = 'http://www.w3.org/2000/svg';

  let host, scrollEl, sizer, stage, svg, zoomLabel, drawer, dot;
  let selectedNode = null, selectedEdge = null;
  let zoom = 1;
  let result = null;
  let drag = null;       // {kind:'move'|'connect', ...}
  let connecting = false; // 화살표를 끄는 중(가장자리 위 점 표시를 멈춘다)
  let lastVals = null;    // 도형별 지난 표시값 — 바뀐 도형만 반짝이게
  let lastHit = new Set();// 지난번에 걸린 컷오프
  let born = null;        // 방금 넣은 도형(등장 애니메이션)
  let pendingReason = null;

  // 단계 팔레트 묶음 — 타일 색은 묶음별(계산 = 강조, 조회 = 초록, 흐름 = 파랑, 컷오프 = 빨강)
  const PALETTE = [['계산', ['pva', 'arith', 'formula']], ['조회', ['lookup', 'progressive']], ['흐름 제어', ['cond', 'branch', 'minmax', 'cutoff']]];
  const CAT = { pva: 'calc', arith: 'calc', formula: 'calc', lookup: 'look', progressive: 'look', cond: 'flow', branch: 'flow', minmax: 'flow', cutoff: 'cut' };
  function icon(id, cls) {
    const el = document.createElementNS(SVGNS, 'svg');
    el.setAttribute('class', `ico${cls ? ` ${cls}` : ''}`);
    el.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(SVGNS, 'use');
    u.setAttribute('href', `#${id}`);
    el.appendChild(u);
    return el;
  }
  const chip = (type) => h('span', { class: `chip-ico c-${CAT[type] || 'calc'}` }, icon(`t-${type}`));

  // ── 기본 설정값(유형을 새로 고를 때) ─────────────────────────────────────
  const emptyGroup = () => ({ logic: 'and', items: [] });
  function defaultConfig(type) {
    switch (type) {
      // 기초한도: 기본형 4줄. 요소 이름과 같은 이름의 변수가 있으면 미리 넣어 둔다(예: 월소득, 월 생계비, 한계 DSR).
      // 기존 월상환액은 같은 이름 변수가 없으면 첫 부채표의 월 원리금 합계
      case 'pva': {
        const vars = S.strategy.variables;
        const pick = (k) => {
          const label = E.PVA_SLOTS.find(x => x[0] === k)[1];
          const v = vars.find(x => x.name === label && x.type !== 'table' && x.type !== 'debt');
          if (v) return { k: 'var', id: v.id };
          const d = k === 'pay' && vars.find(x => x.type === 'debt');
          return d ? { k: 'part', id: d.id, part: 'pay' } : null;
        };
        const tok = (k) => { const r = pick(k); return { t: 'ref', ref: r }; };
        return { lines: E.pvaDefaultLines(tok), rate: pick('rate'), months: pick('months') };
      }
      case 'arith': return { tokens: [] };
      case 'formula': return { text: '' };
      case 'lookup': return { table: null, row: null, col: null };
      case 'progressive': return { table: null, base: null };
      case 'minmax': return { mode: 'min', items: [] };
      case 'cond': return { when: emptyGroup(), then: null, else: null };
      case 'cutoff': return { when: emptyGroup(), action: 'reject', reason: '', input: null };
      case 'branch': return { cases: [{ label: '경로1', when: emptyGroup() }], elseLabel: '그 외' };
    }
    return {};
  }

  // 분기 도형의 출구 이름들(경로 + 그 외)
  function ports(n) {
    if (n.type !== 'branch') return [null];
    return [...(n.config.cases || []).map(c => c.label), n.config.elseLabel || '그 외'];
  }

  // ── 자동 배치 ────────────────────────────────────────────────────────────
  // 세로 흐름: 깊이(앞 단계 수) = 줄, 가지 = 좌우 차선. 분기 경로는 좌우로 벌리고 합류에서 가운데로 모은다
  function layout(s, onlyMissing) {
    const byId = new Map(s.nodes.map(n => [n.id, n]));
    if (onlyMissing) {
      const placed = s.nodes.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y));
      let y = placed.length ? Math.max(...placed.map(n => n.y)) + H + GY : PAD;
      for (const n of s.nodes) if (!(Number.isFinite(n.x) && Number.isFinite(n.y))) { n.x = PAD; n.y = y; y += H + GY; }
      return;
    }
    const { order, deps } = E.order(s);
    const ids = [...order, ...s.nodes.map(n => n.id).filter(id => !order.includes(id))];
    const inE = new Map(ids.map(id => [id, []])), outE = new Map(ids.map(id => [id, []]));
    for (const e of s.edges) if (byId.has(e.from) && byId.has(e.to)) { outE.get(e.from).push(e); inE.get(e.to).push(e); }

    const depth = {};
    for (const id of ids) {
      let d = 0;
      for (const p of (deps.get(id) || [])) if (depth[p] !== undefined) d = Math.max(d, depth[p] + 1);
      depth[id] = d;
    }
    const lane = {};
    let rootLane = 0;
    for (const id of ids) {
      const ins = inE.get(id).filter(e => lane[e.from] !== undefined);
      if (!ins.length) { lane[id] = rootLane; rootLane += 1.1; continue; }
      if (ins.length > 1) { lane[id] = ins.reduce((a, e) => a + lane[e.from], 0) / ins.length; continue; }
      const e = ins[0], p = byId.get(e.from);
      const slots = p.type === 'branch'
        ? ports(p).filter(l => outE.get(p.id).some(x => x.label === l))
        : outE.get(p.id).map(x => x.to);
      const i = slots.indexOf(p.type === 'branch' ? e.label : id);
      lane[id] = lane[p.id] + (slots.length > 1 ? (i - (slots.length - 1) / 2) * 1.1 : 0);
    }
    // 같은 줄에서 겹치면 오른쪽으로 민다
    const rows = new Map();
    for (const id of ids) { const d = depth[id]; if (!rows.has(d)) rows.set(d, []); rows.get(d).push(id); }
    for (const row of rows.values()) {
      row.sort((a, b) => lane[a] - lane[b]);
      for (let i = 1; i < row.length; i++) if (lane[row[i]] < lane[row[i - 1]] + 1) lane[row[i]] = lane[row[i - 1]] + 1;
    }
    const minLane = Math.min(...ids.map(id => lane[id]));
    for (const id of ids) {
      const n = byId.get(id);
      n.x = Math.round(PAD + (lane[id] - minLane) * (W + GX));
      n.y = Math.round(PAD + depth[id] * (H + GY));
    }
  }

  // ── 좌표 ────────────────────────────────────────────────────────────────
  function portPoint(n, label) {
    const ps = ports(n);
    const i = Math.max(0, ps.indexOf(label === undefined ? null : label));
    return { x: n.x + (W * (i + 1)) / (ps.length + 1), y: n.y + H };
  }
  // 붙는 자리 {s: 면(t 위·r 오른쪽·b 아래·l 왼쪽), t: 그 면에서의 위치 0~1(왼→오, 위→아래)}.
  // 화살표의 fa(출발)·ta(도착)에 둔다. 없으면 예전처럼 출발 = 아래 점, 도착 = 위 가운데
  const NORMAL = { t: [0, -1], r: [1, 0], b: [0, 1], l: [-1, 0] };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // 붙는 자리의 좌표와 나가는 방향(nx, ny). 도형 모양(깔때기·육각형·팔각형)의 윤곽선에 맞춘다
  function anchorPoint(n, a) {
    const horiz = a.s === 't' || a.s === 'b', len = horiz ? W : H;
    const hex = n.type === 'cond' || n.type === 'branch';
    const m = n.type === 'minmax' ? (a.s === 'b' ? SLANT + 4 : 8)
      : hex ? (horiz ? TIP + 4 : 8)
      : n.type === 'cutoff' ? CUT + 2 : R;
    const pos = clamp(Math.round(a.t * len), m, len - m);
    const inset = horiz ? 0 : n.type === 'minmax' ? (SLANT * pos) / H : hex ? TIP * Math.abs(1 - (2 * pos) / H) : 0;
    const [nx, ny] = NORMAL[a.s];
    if (a.s === 't') return { x: n.x + pos, y: n.y, nx, ny };
    if (a.s === 'b') return { x: n.x + pos, y: n.y + H, nx, ny };
    if (a.s === 'l') return { x: n.x + inset, y: n.y + pos, nx, ny };
    return { x: n.x + W - inset, y: n.y + pos, nx, ny };
  }
  // 포인터에서 가장 가까운 면과 그 면의 위치. 격자에 맞추고, 가운데 근처면 가운데에 붙인다
  function anchorAt(n, p) {
    const cx = clamp(p.x, n.x, n.x + W), cy = clamp(p.y, n.y, n.y + H);
    const d = { t: cy - n.y, b: n.y + H - cy, l: cx - n.x, r: n.x + W - cx };
    const s = Object.keys(d).reduce((a, k) => (d[k] < d[a] ? k : a));
    const horiz = s === 't' || s === 'b', len = horiz ? W : H;
    let pos = Math.round((horiz ? cx - n.x : cy - n.y) / GRID) * GRID;
    if (Math.abs(pos - len / 2) <= 10) pos = len / 2;
    return { s, t: Math.round((pos / len) * 1000) / 1000 };
  }
  function fromPoint(n, e) {
    if (e.fa) return anchorPoint(n, e.fa);
    return Object.assign(portPoint(n, e.label), { nx: 0, ny: 1 });
  }
  const toPoint = (n, e) => (e.ta ? anchorPoint(n, e.ta) : { x: n.x + W / 2, y: n.y, nx: 0, ny: -1 });
  // 양 끝에서 면에 수직으로 나가고 들어오는 곡선. 끄는 중인 끝(b에 방향 없음)은 출발 방향을 마주 본다
  function curve(a, b) {
    const bx = b.nx === undefined ? -a.nx : b.nx, by = b.ny === undefined ? -a.ny : b.ny;
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    const da = Math.max(28, (Math.abs(a.nx) * dx + Math.abs(a.ny) * dy) / 2);
    const db = Math.max(28, (Math.abs(bx) * dx + Math.abs(by) * dy) / 2);
    return `M${a.x},${a.y} C${a.x + a.nx * da},${a.y + a.ny * da} ${b.x + bx * db},${b.y + by * db} ${b.x},${b.y}`;
  }
  function showDot(p) { dot.hidden = false; dot.style.left = `${p.x}px`; dot.style.top = `${p.y}px`; }
  function hideDot() { dot.hidden = true; }
  function toStage(ev) {
    const r = stage.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / zoom, y: (ev.clientY - r.top) / zoom };
  }
  const edgeKey = (e) => `${e.from}>${e.to}>${e.label || ''}`;

  // ── 그리기 ──────────────────────────────────────────────────────────────
  function mount(el) {
    host = el;
    try { zoom = Number(localStorage.getItem(ZOOM_KEY)) || 1; } catch (e) { zoom = 1; }

    mountPalette();
    zoomLabel = h('span', { class: 'zoom-label' });
    const tool = (ico, tip, onclick) => h('button', { class: 'icon-btn', type: 'button', 'aria-label': tip.split('|')[0], 'data-tip': tip, onclick }, icon(ico));

    // 떠 있는 도구: 왼쪽 위 = 단계 추가·되돌리기·자동 정렬·처음 안내 / 아래 가운데 = 확대·축소·폭 맞춤
    const toolbar = h('div', { class: 'float-tool float-tl' },
      tool('i-plus', '단계 추가|왼쪽 단계 팔레트를 엽니다', () => { root.App.sideTab('palette', true); const q = document.getElementById('paletteSearch'); if (q) q.focus(); }),
      tool('i-undo', '되돌리기 (Ctrl+Z)|단계 추가·삭제·연결·이동·저장을 한 번씩 되돌립니다', () => root.App.undo()),
      tool('i-layout', '자동 정렬|흐름 순서대로 도형을 다시 놓습니다', autoLayout),
      h('span', { class: 'tool-sep' }),
      tool('i-help', '처음 안내 다시 보기', () => root.Fx.startTour()));
    const zoombar = h('div', { class: 'float-tool float-bc' },
      tool('i-minus', '축소', () => setZoom(zoom - 0.1)),
      zoomLabel,
      tool('i-plus', '확대', () => setZoom(zoom + 0.1)),
      h('span', { class: 'tool-sep' }),
      tool('i-fit', '폭 맞춤|도형 전체가 가로로 들어오게 맞춥니다', fitWidth));
    const hint = h('div', { class: 'canvas-hint' }, '도형 가장자리를 끌어 다른 도형에 놓으면 연결 · 화살표를 끌면 붙는 자리를 옮깁니다');

    svg = document.createElementNS(SVGNS, 'svg');
    svg.classList.add('edges');
    stage = h('div', { class: 'canvas-stage' });
    stage.appendChild(svg);
    dot = h('div', { class: 'anchor-dot', hidden: true });   // 화살표가 붙을 자리 표시
    stage.appendChild(dot);
    sizer = h('div', { class: 'canvas-sizer' }, stage);
    scrollEl = h('div', { class: 'canvas-scroll' }, sizer);
    scrollEl.addEventListener('pointerdown', (ev) => {
      if (ev.target === scrollEl || ev.target === sizer || ev.target === stage || ev.target === svg) select(null);
    });

    drawer = h('div', { class: 'drawer' });
    host.append(scrollEl, toolbar, zoombar, hint, drawer);
    root.Panel.mount(drawer, { onClose: () => select(null) });

    document.addEventListener('keydown', onKey);
    S.subscribe(onChange);
    render();
  }

  // ── 단계 팔레트(왼쪽 패널) ──────────────────────────────────────────────
  function mountPalette() {
    const box = document.getElementById('palette');
    if (!box) return;
    const G = (root.Guide && root.Guide.GUIDE) || {};
    for (const [title, types] of PALETTE) {
      const tiles = h('div', { class: 'tiles' }, types.map(t => h('button', {
        class: 'tile', type: 'button', 'data-type': t,
        'data-tip': `${E.NODE_TYPES[t]}|${(G[t] && G[t].summary) || ''}`,
        onclick: () => root.App.showTab('process', () => addNode(t)),
      }, chip(t), h('span', {}, E.NODE_TYPES[t]))));
      const group = h('div', { class: 'tile-group' });
      const head = h('button', { class: 'group-head', type: 'button', 'aria-expanded': 'true',
        onclick: () => { const closed = group.classList.toggle('closed'); head.setAttribute('aria-expanded', !closed); } }, title, icon('i-chev'));
      group.append(head, tiles);
      box.appendChild(group);
    }
    const q = document.getElementById('paletteSearch');
    if (q) q.addEventListener('input', () => {
      const v = q.value.trim();
      box.querySelectorAll('.tile').forEach(t => { t.hidden = !!v && !t.textContent.includes(v); });
    });
  }

  function onChange(reason) {
    if (reason === 'saved' || reason === 'exported' || reason === 'canvas-move') return;
    pendingReason = reason;
    if (['load', 'new', 'example', 'import'].includes(reason)) { selectedNode = null; selectedEdge = null; root.Panel.show(null); lastVals = null; }
    if (selectedNode && !S.strategy.nodes.some(n => n.id === selectedNode)) { selectedNode = null; root.Panel.show(null); }
    render();
  }

  function render() {
    const s = S.strategy;
    const missing = s.nodes.filter(n => !(Number.isFinite(n.x) && Number.isFinite(n.y)));
    if (missing.length) {
      // 위치 없는 단계 배치 — 전부 없으면 전체 자동 배치, 일부만 없으면 아래쪽에 쌓는다
      S.update(st => layout(st, missing.length !== st.nodes.length), 'canvas-layout', true);
      return;   // update가 다시 render를 부른다
    }
    try { result = E.evaluate(s, S.evalInputs()); } catch (e) { result = { steps: {}, finalNodeId: null }; }

    const maxX = Math.max(600, ...s.nodes.map(n => n.x + W)) + PAD * 2;
    const maxY = Math.max(400, ...s.nodes.map(n => n.y + H)) + PAD * 3;
    stage.style.width = `${maxX}px`;
    stage.style.height = `${maxY}px`;
    stage.style.transform = `scale(${zoom})`;
    sizer.style.width = `${maxX * zoom}px`;
    sizer.style.height = `${maxY * zoom}px`;
    svg.setAttribute('width', maxX);
    svg.setAttribute('height', maxY);
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;

    for (const el of [...stage.querySelectorAll('.node, .edge-del, .node-empty, .path-menu')]) el.remove();
    if (!s.nodes.length) {
      stage.appendChild(h('div', { class: 'node-empty' }, '왼쪽 단계 팔레트에서 유형을 눌러 첫 단계를 만드세요. 왼쪽 패널 "전략 파일"의 "예시 전략 열기"로 완성된 예를 볼 수 있습니다.'));
    }
    for (const n of s.nodes) stage.appendChild(nodeEl(n));
    drawEdges();
    playEffects();
  }

  // ── 움직임: 값이 바뀐 도형 반짝임 · 계산 흐름 빛 · 컷오프 흔들림 · 새 도형 등장 ──
  // 테스트 입력값·설정 저장처럼 계산이 바뀐 경우에만(처음 그릴 때·전략을 새로 열 때는 조용히)
  function playEffects() {
    const s = S.strategy, reason = pendingReason;
    pendingReason = null;
    const vals = new Map(s.nodes.map(n => [n.id, stage.querySelector(`.node[data-id="${n.id}"] .node-value`).textContent]));
    const hits = new Set(s.nodes.filter(n => n.type === 'cutoff' && (result.steps[n.id] || {}).triggered).map(n => n.id));
    const prev = lastVals, prevHits = lastHit;
    lastVals = vals; lastHit = hits;
    if (born) { root.Fx.replay(stage.querySelector(`.node[data-id="${born}"]`), 'born'); born = null; }
    if (!prev || root.Fx.REDUCED || !['test-input', 'node-save', 'update', 'undo', 'view', 'canvas-edge'].includes(reason)) return;
    const { order } = E.order(s);
    const rank = new Map(order.map((id, i) => [id, i]));
    const STEP = 90;
    for (const n of s.nodes) {
      if (prev.has(n.id) && prev.get(n.id) !== vals.get(n.id)) root.Fx.replay(stage.querySelector(`.node[data-id="${n.id}"]`), 'ping', (rank.get(n.id) || 0) * STEP);
      if (hits.has(n.id) && !prevHits.has(n.id)) root.Fx.replay(stage.querySelector(`.node[data-id="${n.id}"]`), 'hit', (rank.get(n.id) || 0) * STEP);
    }
    // 지나간 화살표 위로 짧은 빛이 출발 단계 순서대로 훑고 지나간다
    for (const path of svg.querySelectorAll('path.edge.on')) {
      const len = path.getTotalLength();
      const glow = document.createElementNS(SVGNS, 'path');
      glow.setAttribute('d', path.getAttribute('d'));
      glow.setAttribute('class', 'edge-flow');
      glow.style.strokeDasharray = `14 ${len + 20}`;
      glow.style.setProperty('--len', `${len + 14}`);
      glow.style.animationDelay = `${(rank.get(path.dataset.from) || 0) * STEP}ms`;
      glow.addEventListener('animationend', () => glow.remove());
      svg.appendChild(glow);
    }
  }

  // ── 유형별 도형 모양 ───────────────────────────────────────────────────
  // 윤곽선은 SVG로 그린다(clip-path로 자르면 테두리가 잘리기 때문). 상태(선택·최종·오류 등)는 CSS가 윤곽선 색으로 표시한다
  //   기초한도 = 이중 테두리 / 사칙연산 = 둥근 사각 / 고급 수식 = 점선 / 표 조회·누진 = 왼쪽 표 띠
  //   최소·최대 = 아래가 좁은 깔때기 / 조건·분기 = 양옆이 뾰족한 육각형 / 컷오프 = 모서리 잘린 팔각형
  const SLANT = 18, TIP = 16, CUT = 14, R = 14, DIV_Y = 42;

  function roundRect(x, y, w, hh, r) {
    return `M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + hh - r} Q${x + w},${y + hh} ${x + w - r},${y + hh} H${x + r} Q${x},${y + hh} ${x},${y + hh - r} V${y + r} Q${x},${y} ${x + r},${y} Z`;
  }
  const poly = (pts) => `M${pts.map(p => p.join(',')).join(' L')} Z`;

  function shapeSvg(n) {
    const a = 1, w = W - 2, hh = H - 2;   // 선 두께만큼 안쪽으로
    const paths = [];                     // [d, class]
    switch (n.type) {
      case 'minmax': paths.push([poly([[a, a], [a + w, a], [a + w - SLANT, a + hh], [a + SLANT, a + hh]]), 'sh']); break;
      case 'cond': case 'branch': paths.push([poly([[a + TIP, a], [a + w - TIP, a], [a + w, a + hh / 2], [a + w - TIP, a + hh], [a + TIP, a + hh], [a, a + hh / 2]]), 'sh']); break;
      case 'cutoff': paths.push([poly([[a + CUT, a], [a + w - CUT, a], [a + w, a + CUT], [a + w, a + hh - CUT], [a + w - CUT, a + hh], [a + CUT, a + hh], [a, a + hh - CUT], [a, a + CUT]]), 'sh']); break;
      case 'lookup': case 'progressive':
        paths.push([roundRect(a, a, w, hh, R), 'sh']);
        paths.push([`M${a + 26},${a} V${a + hh}`, 'sh-line']);
        for (const y of [30, 46, 62]) paths.push([`M${a + 7},${y} H${a + 20}`, 'sh-line']);
        break;
      case 'pva':
        paths.push([roundRect(a, a, w, hh, R), 'sh']);
        paths.push([roundRect(a + 4, a + 4, w - 8, hh - 8, R - 4), 'sh-inner']);
        break;
      default: paths.push([roundRect(a, a, w, hh, R), n.type === 'formula' ? 'sh sh-dash' : 'sh']);
    }
    // 머리줄 아래 구분선 — 모양마다 윤곽선 안쪽에 들어오게 양 끝을 맞춘다
    const div = { cond: [TIP, W - TIP], branch: [TIP, W - TIP], cutoff: [6, W - 6], minmax: [10, W - 14], lookup: [27, W - 12], progressive: [27, W - 12], pva: [8, W - 8] }[n.type] || [10, W - 10];
    paths.push([`M${div[0]},${DIV_Y} H${div[1]}`, 'sh-div']);
    const svgEl = document.createElementNS(SVGNS, 'svg');
    svgEl.setAttribute('class', 'node-shape');
    svgEl.setAttribute('width', W);
    svgEl.setAttribute('height', H);
    svgEl.setAttribute('aria-hidden', 'true');
    for (const [d, cls] of paths) {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('class', cls);
      svgEl.appendChild(p);
    }
    return svgEl;
  }

  function nodeEl(n) {
    const st = result.steps[n.id] || {};
    const isFinal = n.id === result.finalNodeId;
    const cls = ['node', `node-${n.type}`,
      n.id === selectedNode ? 'selected' : '',
      st.skipped ? 'skipped' : !st.active ? 'inactive' : '',
      st.error ? 'error' : '', isFinal ? 'final' : '',
      (st.triggered || st.chosen) ? 'marked' : ''].join(' ');
    const el = h('div', { class: cls, 'data-id': n.id, style: `left:${n.x}px;top:${n.y}px;width:${W}px;height:${H}px`, title: D.describe(n) },
      h('div', { class: 'node-head' },
        chip(n.type),
        h('span', { class: 'node-name' }, n.name),
        isFinal ? h('span', { class: 'final-chip' }, '최종') : null),
      h('div', { class: 'node-body' },
        h('span', { class: 'node-type' },
          n.type === 'minmax' ? (n.config.mode === 'max' ? '최대' : '최소') : (E.NODE_TYPES[n.type] || n.type),
          n.type === 'formula' && n.config.lang ? ` · ${E.LANGS[n.config.lang]}` : ''),
        h('span', { class: 'node-value' }, st.error ? h('span', { class: 'err' }, '오류') : D.stepValueText(n, st))));
    el.prepend(shapeSvg(n));
    // 아래 점은 분기의 경로 이름표만 둔다 — 다른 도형은 가장자리에서 끌어 시작한다
    if (n.type === 'branch') ports(n).forEach((label) => {
      const p = portPoint(n, label);
      const port = h('div', {
        class: `port port-label${st.active && st.value === label ? ' taken' : ''}`,
        style: `left:${p.x - n.x}px;top:${H}px`, title: `"${label}" 경로 연결`,
      }, label);
      port.addEventListener('pointerdown', (ev) => startConnect(ev, n, label));
      el.appendChild(port);
    });
    // 가장자리 띠: 어느 자리에서든 끌어 연결을 시작한다(분기는 놓은 뒤 경로를 고른다)
    for (const side of ['t', 'r', 'b', 'l']) {
      const zone = h('div', { class: `edge-zone edge-zone-${side}` });
      zone.addEventListener('pointerdown', (ev) => startConnect(ev, n, n.type === 'branch' ? undefined : null, anchorAt(n, toStage(ev))));
      zone.addEventListener('pointermove', (ev) => { if (!connecting) showDot(anchorPoint(n, anchorAt(n, toStage(ev)))); });
      zone.addEventListener('pointerleave', () => { if (!connecting) hideDot(); });
      el.appendChild(zone);
    }
    el.addEventListener('pointerdown', (ev) => startMove(ev, n, el));
    return el;
  }

  function drawEdges(temp) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const defs = document.createElementNS(SVGNS, 'defs');
    defs.innerHTML = '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow-head"/></marker>'
      + '<marker id="arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow-head on"/></marker>';
    svg.appendChild(defs);
    const s = S.strategy;
    const byId = new Map(s.nodes.map(n => [n.id, n]));
    for (const e of s.edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      if (temp && temp.skip === edgeKey(e)) continue;   // 옮기는 중인 화살표는 임시 화살표로 그린다
      const sa = result.steps[a.id] || {}, sb = result.steps[b.id] || {};
      const taken = sa.active && sb.active && (a.type !== 'branch' || sa.value === e.label);
      const d = curve(fromPoint(a, e), toPoint(b, e));
      const key = edgeKey(e);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', `edge${taken ? ' on' : ''}${key === selectedEdge ? ' sel' : ''}`);
      path.setAttribute('marker-end', taken ? 'url(#arrow-on)' : 'url(#arrow)');
      path.dataset.from = a.id;
      const hit = document.createElementNS(SVGNS, 'path');
      hit.setAttribute('d', d);
      hit.setAttribute('class', 'edge-hit');
      hit.addEventListener('pointerdown', (ev) => startEdgeDrag(ev, e, false));
      svg.append(path, hit);
      // 가장자리에서 나가는 분기 화살표는 어느 경로인지 시작점 옆에 적는다
      if (a.type === 'branch' && e.fa) {
        const from = fromPoint(a, e);
        const t = document.createElementNS(SVGNS, 'text');
        t.setAttribute('x', from.x + from.nx * 18);
        t.setAttribute('y', from.y + from.ny * 18);
        t.setAttribute('class', `edge-label${taken ? ' on' : ''}`);
        t.textContent = e.label;
        svg.appendChild(t);
      }
    }
    if (temp) {
      const t = document.createElementNS(SVGNS, 'path');
      t.setAttribute('d', curve(temp.from, temp.to));
      t.setAttribute('class', `edge temp${temp.snapped ? ' snapped' : ''}`);
      t.setAttribute('marker-end', 'url(#arrow-on)');
      svg.appendChild(t);
    }
    // 선택한 화살표: 삭제 버튼(곡선 가운데) + 양 끝 손잡이(끝 = 다른 도형·자리로 옮기기, 시작 = 같은 도형 안에서 자리 옮기기)
    stage.querySelectorAll('.edge-del, .edge-end').forEach(x => x.remove());
    if (selectedEdge && !temp) {
      const e = s.edges.find(x => edgeKey(x) === selectedEdge);
      if (e && byId.get(e.from) && byId.get(e.to)) {
        const a = fromPoint(byId.get(e.from), e), b = toPoint(byId.get(e.to), e);
        stage.appendChild(h('button', {
          class: 'edge-del', type: 'button', title: '연결 삭제 (Delete 키)', 'aria-label': '연결 삭제',
          style: `left:${(a.x + b.x) / 2 - 14}px;top:${(a.y + b.y) / 2 - 14}px`,
          onclick: deleteSelectedEdge,
        }, '✕'));
        const end = h('div', { class: 'edge-end', title: '끌어서 다른 단계·다른 자리로 옮기기', style: `left:${b.x}px;top:${b.y - 10}px` });
        end.addEventListener('pointerdown', (ev) => startEdgeDrag(ev, e, true));
        stage.appendChild(end);
        {
          const start = h('div', { class: 'edge-end', title: '끌어서 나가는 자리 옮기기', style: `left:${a.x}px;top:${a.y - 10}px` });
          start.addEventListener('pointerdown', (ev) => startFromDrag(ev, e));
          stage.appendChild(start);
        }
      }
    }
  }

  // ── 조작 ────────────────────────────────────────────────────────────────
  // 포인터 캡처: 끄는 중 커서가 도형 밖으로 나가도 이벤트를 계속 받는다. 일부 입력 장치에서 실패해도 끌기는 계속되게 한다
  function capture(el, ev) {
    try { el.setPointerCapture(ev.pointerId); } catch (e) { /* 캡처 없이 진행 */ }
  }

  function startMove(ev, n, el) {
    if (ev.button !== 0 || ev.target.closest('.port, .edge-zone')) return;
    ev.preventDefault();
    const p = toStage(ev);
    drag = { kind: 'move', id: n.id, dx: p.x - n.x, dy: p.y - n.y, moved: false, el, x: n.x, y: n.y, ox: n.x, oy: n.y };
    capture(el, ev);
    el.onpointermove = (e2) => {
      const q = toStage(e2);
      const nx = Math.max(0, Math.round((q.x - drag.dx) / GRID) * GRID);
      const ny = Math.max(0, Math.round((q.y - drag.dy) / GRID) * GRID);
      if (!drag.moved && Math.abs(nx - n.x) < 4 && Math.abs(ny - n.y) < 4) return;
      drag.moved = true;
      drag.x = nx; drag.y = ny;
      el.style.left = `${nx}px`; el.style.top = `${ny}px`;
      n.x = nx; n.y = ny;          // 화살표를 따라 그리기 위해 임시 반영(놓을 때 저장)
      drawEdges();
    };
    el.onpointerup = () => {
      el.onpointermove = el.onpointerup = null;
      const d = drag; drag = null;
      if (d.moved) {
        // 끄는 동안 임시로 옮긴 위치를 원래대로 돌린 뒤 저장해야 되돌리기 기록에 이동 전 위치가 남는다
        n.x = d.ox; n.y = d.oy;
        S.update(st => { const m = st.nodes.find(x => x.id === d.id); m.x = d.x; m.y = d.y; }, 'canvas-move');
      }
      else select(n.id);
    };
  }

  // 포인터에서 SNAP 안에 있는 가장 가까운 도형(도형 안이면 거리 0). 시작 도형은 뺀다
  function nearestNode(p, excludeId) {
    let best = null, bestD = SNAP;
    for (const n of S.strategy.nodes) {
      if (n.id === excludeId) continue;
      const dx = Math.max(n.x - p.x, 0, p.x - (n.x + W));
      const dy = Math.max(n.y - p.y, 0, p.y - (n.y + H));
      const d = Math.hypot(dx, dy);
      if (d <= bestD) { best = n; bestD = d; }
    }
    return best;
  }

  // 화살표 끌기(새 연결·끝점 옮기기 공용): 가까운 도형을 강조하고 끝을 포인터에서 가장 가까운 자리에 붙인다.
  // 놓을 때 붙은 도형이 있으면 onDrop(도형 id, 붙는 자리), 없으면 아무것도 하지 않는다
  function dragArrow(ev, el, fromNode, label, fa, skip, onDrop) {
    const from = fromPoint(fromNode, { label, fa });
    let target = null, ta = null;
    connecting = true;
    const mark = (n) => {
      if (target === n) return;
      if (target) { const x = stage.querySelector(`.node[data-id="${target.id}"]`); if (x) x.classList.remove('drop-target'); }
      target = n;
      if (n) { const x = stage.querySelector(`.node[data-id="${n.id}"]`); if (x) x.classList.add('drop-target'); }
    };
    const move = (e2) => {
      const p = toStage(e2);
      const n = nearestNode(p, fromNode.id);
      mark(n);
      ta = n ? anchorAt(n, p) : null;
      const to = n ? anchorPoint(n, ta) : p;
      if (n) showDot(to); else hideDot();
      drawEdges({ from, to, skip, snapped: !!n });
    };
    const end = (drop) => {
      el.onpointermove = el.onpointerup = el.onpointercancel = null;
      const t = target;
      mark(null);
      connecting = false; hideDot();
      drawEdges();
      if (drop && t) onDrop(t.id, ta);
    };
    capture(el, ev);
    el.onpointermove = move;
    el.onpointerup = (e2) => { move(e2); end(true); };   // 놓은 자리로 한 번 더 판정(빠르게 끌어도 맞게)
    el.onpointercancel = () => end(false);
    move(ev);
  }

  function startConnect(ev, n, label, fa) {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    dragArrow(ev, ev.currentTarget, n, label, fa, null, (to, ta) => {
      if (n.type === 'branch' && label === undefined) choosePath(n, to, fa, ta);
      else connect(n.id, to, label, fa, ta);
    });
  }

  // 분기 도형의 가장자리에서 끌어 온 화살표: 놓은 자리에 경로 고르기 창을 띄운다(빈 곳을 누르거나 Esc면 취소)
  function choosePath(n, to, fa, ta) {
    stage.querySelectorAll('.path-menu').forEach(x => x.remove());
    const p = anchorPoint(S.strategy.nodes.find(x => x.id === to), ta);
    const used = new Set(S.strategy.edges.filter(e => e.from === n.id).map(e => e.label));
    const menu = h('div', { class: 'path-menu', style: `left:${p.x}px;top:${p.y}px` },
      h('div', { class: 'path-menu-title' }, '어느 경로로 이을까요?'),
      ports(n).map(l => h('button', {
        class: 'btn btn-small', type: 'button',
        onclick: () => { menu.remove(); connect(n.id, to, l, fa, ta); },
      }, l, used.has(l) ? h('span', { class: 'muted' }, ' · 이미 이은 경로') : null)));
    menu.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    stage.appendChild(menu);
  }

  // 선택한 화살표의 시작 손잡이: 같은 도형 안에서 나가는 자리만 옮긴다
  function startFromDrag(ev, e) {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const key = edgeKey(e);
    const a = S.strategy.nodes.find(n => n.id === e.from), b = S.strategy.nodes.find(n => n.id === e.to);
    const to = toPoint(b, e);
    let fa = null;
    connecting = true;
    capture(stage, ev);
    const end = (save) => {
      stage.onpointermove = stage.onpointerup = stage.onpointercancel = null;
      connecting = false; hideDot();
      if (save && fa) S.update(st => { st.edges.find(x => edgeKey(x) === key).fa = fa; }, 'canvas-edge');
      else drawEdges();
    };
    stage.onpointermove = (e2) => {
      fa = anchorAt(a, toStage(e2));
      const from = anchorPoint(a, fa);
      showDot(from);
      drawEdges({ from, to, skip: key, snapped: true });
    };
    stage.onpointerup = () => end(true);
    stage.onpointercancel = () => end(false);
  }

  // 이어 둔 화살표 누르기: 그대로 떼면 선택, 끌면 끝점을 다른 도형으로 옮긴다(손잡이는 바로 끌기)
  function startEdgeDrag(ev, e, immediate) {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const key = edgeKey(e);
    const fromNode = S.strategy.nodes.find(n => n.id === e.from);
    const begin = (e2) => dragArrow(e2, stage, fromNode, e.label, e.fa, key, (to, ta) => reconnect(key, to, ta));
    if (immediate) { begin(ev); return; }
    // 화살표 요소는 다시 그릴 때 바뀌므로 캡처는 늘 있는 stage에 건다
    const x0 = ev.clientX, y0 = ev.clientY;
    capture(stage, ev);
    stage.onpointermove = (e2) => {
      if (Math.hypot(e2.clientX - x0, e2.clientY - y0) < 5) return;
      stage.onpointermove = stage.onpointerup = null;
      begin(e2);
    };
    stage.onpointerup = () => { stage.onpointermove = stage.onpointerup = null; selectEdge(key); };
  }

  function reconnect(key, to, ta) {
    const s = S.strategy;
    const old = s.edges.find(x => edgeKey(x) === key);
    if (!old) return;
    const e = Object.assign({}, old, { to, ta });
    if (old.to !== to) {   // 같은 도형 안에서 자리만 옮길 때는 중복·고리 검사가 필요 없다
      if (s.edges.some(x => edgeKey(x) === edgeKey(e))) { root.App.flash('이미 같은 연결이 있습니다', 'info'); return; }
      const edges = s.edges.map(x => (edgeKey(x) === key ? e : x));
      if (E.order(Object.assign({}, s, { edges })).cycle.length) {
        root.App.flash('이 연결은 순서가 고리처럼 돌아가게 만들어 옮기지 않았습니다', 'danger');
        return;
      }
    }
    if (selectedEdge === key) selectedEdge = edgeKey(e);
    S.update(st => { const i = st.edges.findIndex(x => edgeKey(x) === key); st.edges[i] = e; }, 'canvas-edge');
  }

  function connect(from, to, label, fa, ta) {
    const s = S.strategy;
    const e = label === null || label === undefined ? { from, to } : { from, to, label };
    if (fa) e.fa = fa;
    if (ta) e.ta = ta;
    // 이미 이어진 두 도형을 다시 이으면 붙는 자리만 바꾼다
    if (s.edges.some(x => edgeKey(x) === edgeKey(e))) {
      S.update(st => { const i = st.edges.findIndex(x => edgeKey(x) === edgeKey(e)); st.edges[i] = e; }, 'canvas-edge');
      return;
    }
    if (E.order(Object.assign({}, s, { edges: [...s.edges, e] })).cycle.length) {
      root.App.flash('이 연결은 순서가 고리처럼 돌아가게 만들어 연결하지 않았습니다', 'danger');
      return;
    }
    S.update(st => st.edges.push(e), 'canvas-edge');
  }

  function selectEdge(key) {
    selectedEdge = key;
    if (selectedNode) { selectedNode = null; root.Panel.show(null); render(); } else drawEdges();
  }

  function deleteSelectedEdge() {
    const key = selectedEdge;
    selectedEdge = null;
    S.update(st => { st.edges = st.edges.filter(e => edgeKey(e) !== key); }, 'canvas-edge');
  }

  function onKey(ev) {
    if (host.hidden || host.closest('[hidden]')) return;
    if (ev.target.closest && ev.target.closest('input, textarea, select, [contenteditable]')) return;
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedEdge) { ev.preventDefault(); deleteSelectedEdge(); }
    // 설정 패널 안(사칙연산 조각 지우기 등)이나 확인 창이 떠 있을 때의 Delete는 단계 삭제가 아니다
    else if (ev.key === 'Delete' && selectedNode && !ev.defaultPrevented && !(ev.target.closest && ev.target.closest('.popup')) && !document.querySelector('.modal-back')) {
      ev.preventDefault();
      confirmDeleteNode(selectedNode);
    }
    if (ev.key === 'Escape') select(null);
  }

  // 단계 삭제 확인 창: 예 = 단계와 연결된 화살표 삭제(되돌리기 가능), 아니오 = 닫기
  function confirmDeleteNode(id) {
    const n = S.strategy.nodes.find(x => x.id === id);
    if (!n) return;
    const refs = E.findReferences(S.strategy, id);
    let m;
    const yes = h('button', { class: 'btn btn-danger', type: 'button', onclick: () => {
      m.close();
      S.update(st => {
        st.nodes = st.nodes.filter(x => x.id !== id);
        st.edges = st.edges.filter(e => e.from !== id && e.to !== id);
        if (st.finalNodeId === id) st.finalNodeId = null;
      }, 'node-delete');
      select(null);
    } }, '예');
    const no = h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, '아니오');
    m = root.UI.modal('단계 삭제', h('div', { class: 'confirm-body' },
      h('p', {}, `[${n.name}] 단계를 삭제하시겠습니까?`),
      refs.length ? h('div', { class: 'warn-box' }, `이 단계의 값을 쓰는 단계가 ${refs.length}곳 있습니다: ${refs.map(x => x.name).join(', ')}. 삭제하면 이 단계들이 오류가 됩니다.`) : null,
      h('div', { class: 'row-actions' }, yes, no)));
    yes.focus();
  }

  function select(id) {
    selectedEdge = null;
    selectedNode = id;
    root.Panel.show(id);
    render();
    if (id) {
      const el = stage.querySelector(`.node[data-id="${id}"]`);
      // 가운데로 — 설정 패널이 캔버스 아래쪽을 덮으므로 패널 위로 보이는 영역 기준으로 맞춘다
      // (offsetHeight는 올라오는 중인 애니메이션과 무관하게 최종 높이를 준다)
      if (el) {
        const r = el.getBoundingClientRect(), v0 = scrollEl.getBoundingClientRect();
        const covered = drawer.classList.contains('open') ? drawer.offsetHeight : 0;
        const v = { top: v0.top, bottom: v0.bottom - covered, left: v0.left, right: v0.right, height: v0.height - covered, width: v0.width };
        if (r.top < v.top || r.bottom + 24 > v.bottom || r.left < v.left || r.right > v.right) {
          scrollEl.scrollTop += (r.top + r.height / 2) - (v.top + v.height / 2);
          scrollEl.scrollLeft += (r.left + r.width / 2) - (v.left + v.width / 2);
        }
      }
    }
  }

  function addNode(type) {
    const s = S.strategy;
    const id = E.newId('n');
    const sel = s.nodes.find(n => n.id === selectedNode);
    let x, y;
    if (sel) { x = sel.x; y = sel.y + H + GY; }
    else {
      x = Math.round((scrollEl.scrollLeft / zoom + PAD) / GRID) * GRID;
      y = Math.round((scrollEl.scrollTop / zoom + PAD) / GRID) * GRID;
    }
    // 겹치면 아래로 내린다
    while (s.nodes.some(n => Math.abs(n.x - x) < W && Math.abs(n.y - y) < H)) y += H + GY;
    S.update(st => {
      st.nodes.push({ id, name: S.uniqueName(E.NODE_TYPES[type]), type, config: defaultConfig(type), format: type === 'pva' ? 'money' : 'number', x, y });
      if (sel) {
        const used = new Set(st.edges.filter(e => e.from === sel.id).map(e => e.label));
        const label = sel.type === 'branch' ? (ports(sel).find(l => !used.has(l)) || ports(sel)[0]) : null;
        st.edges.push(label === null ? { from: sel.id, to: id } : { from: sel.id, to: id, label });
      }
    }, 'canvas-add');
    born = id;
    select(id);
  }

  function autoLayout() { S.update(st => layout(st, false), 'canvas-layout'); render(); }

  function setZoom(z) {
    zoom = Math.min(1.4, Math.max(0.5, Math.round(z * 10) / 10));
    try { localStorage.setItem(ZOOM_KEY, zoom); } catch (e) { /* 저장 못 해도 동작에는 지장 없음 */ }
    render();
  }

  function fitWidth() {
    const s = S.strategy;
    if (!s.nodes.length) return;
    const w = Math.max(...s.nodes.map(n => n.x + W)) + PAD * 2;
    setZoom(Math.floor((scrollEl.clientWidth / w) * 10) / 10);
  }

  root.Canvas = { mount, select, addNode, defaultConfig, ports, get selected() { return selectedNode; } };
})(typeof self !== 'undefined' ? self : this);
