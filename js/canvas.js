/* ============================================================================
   프로세스 탭 — 도형 캔버스
   ----------------------------------------------------------------------------
   · 도형(단계)은 HTML 카드, 화살표는 그 아래 SVG 한 장에 그린다
   · 도형 아래 점(포트)을 끌어 다른 도형에 놓으면 연결. 분기 도형은 경로마다 포트가 있다
   · 이어 둔 화살표를 끌면 끝점을 다른 도형으로 옮긴다(빈 곳에 놓으면 취소)
   · 끄는 동안 도형 근처(SNAP)에 가면 그 도형을 강조하고 화살표 끝을 입구에 붙인다
   · 도형을 끌어 옮기고, 클릭하면 아래 설정 패널(panel.js)이 열린다
   · 위치가 없는 단계(예시 전략·가져온 파일)는 자동 배치한다
   화살표는 "흐름(어느 경로를 탔는가)"이고, 계산에 쓰는 값은 설정 패널의 참조가 정한다.
   ========================================================================== */
(function (root) {
  'use strict';
  const E = root.LimitEngine, S = root.Store, D = root.Describe, { h, clear } = root.UI;

  const W = 232, H = 88, GX = 44, GY = 48, PAD = 40, GRID = 8, SNAP = 48;
  const ZOOM_KEY = 'limitsim.zoom';
  const SVGNS = 'http://www.w3.org/2000/svg';

  let host, scrollEl, sizer, stage, svg, zoomLabel, addSelect, drawer;
  let selectedNode = null, selectedEdge = null;
  let zoom = 1;
  let result = null;
  let drag = null;       // {kind:'move'|'connect', ...}

  // ── 기본 설정값(유형을 새로 고를 때) ─────────────────────────────────────
  const emptyGroup = () => ({ logic: 'and', items: [] });
  function defaultConfig(type) {
    switch (type) {
      // 부채 집계: 첫 부채표와 "고금리 기준" 변수(있으면)를 미리 골라 둔다
      case 'debt': {
        const t = S.strategy.variables.find(x => x.type === 'debt');
        const hi = S.strategy.variables.find(x => x.name === '고금리 기준' && x.type !== 'table' && x.type !== 'debt');
        return { table: t ? { k: 'var', id: t.id } : null, hiRate: hi ? { k: 'var', id: hi.id } : null };
      }
      // 기초한도: 요소 이름과 같은 이름의 변수가 있으면 미리 골라 둔다(예: 월소득, 월 생계비, 한계 DSR)
      case 'pva': return Object.fromEntries(E.PVA_INPUTS.map(([k, label]) => {
        const v = S.strategy.variables.find(x => x.name === label && x.type !== 'table');
        return [k, v ? { k: 'var', id: v.id } : null];
      }));
      case 'arith': return { tokens: [] };
      case 'formula': return { text: '' };
      case 'lookup': return { table: null, row: null, col: null };
      case 'progressive': return { table: null, base: null };
      case 'minmax': return { mode: 'min', items: [] };
      case 'cond': return { when: emptyGroup(), then: null, else: null };
      case 'cutoff': return { when: emptyGroup(), action: 'reject', reason: '', input: null };
      case 'pv': return { rate: null, months: null, payment: null };
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
  const inPoint = (n) => ({ x: n.x + W / 2, y: n.y });
  function curve(a, b) {
    const dy = Math.max(28, Math.abs(b.y - a.y) / 2);
    return `M${a.x},${a.y} C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`;
  }
  function toStage(ev) {
    const r = stage.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / zoom, y: (ev.clientY - r.top) / zoom };
  }
  const edgeKey = (e) => `${e.from}>${e.to}>${e.label || ''}`;

  // ── 그리기 ──────────────────────────────────────────────────────────────
  function mount(el) {
    host = el;
    try { zoom = Number(localStorage.getItem(ZOOM_KEY)) || 1; } catch (e) { zoom = 1; }

    addSelect = h('select', { class: 'add-select', 'aria-label': '단계 추가' },
      h('option', { value: '' }, '+ 단계 추가'),
      Object.entries(E.NODE_TYPES).map(([k, t]) => h('option', { value: k }, t)));
    addSelect.addEventListener('change', () => { if (addSelect.value) addNode(addSelect.value); addSelect.value = ''; });
    zoomLabel = h('span', { class: 'zoom-label' });

    const toolbar = h('div', { class: 'canvas-toolbar' },
      addSelect,
      h('button', { class: 'btn', type: 'button', title: '단계 추가·삭제·연결·이동·저장을 한 번씩 되돌립니다 (Ctrl+Z)', onclick: () => root.App.undo() }, '↶ 되돌리기'),
      h('button', { class: 'btn', type: 'button', onclick: autoLayout }, '자동 정렬'),
      h('div', { class: 'zoom-group' },
        h('button', { class: 'btn-round', type: 'button', title: '축소', 'aria-label': '축소', onclick: () => setZoom(zoom - 0.1) }, '−'),
        zoomLabel,
        h('button', { class: 'btn-round', type: 'button', title: '확대', 'aria-label': '확대', onclick: () => setZoom(zoom + 0.1) }, '+'),
        h('button', { class: 'btn btn-small', type: 'button', onclick: fitWidth }, '폭 맞춤')),
      h('span', { class: 'toolbar-hint' }, '도형 아래 점을 끌어 다른 도형에 놓으면 연결 · 화살표를 끌면 다른 도형으로 옮겨집니다'));

    svg = document.createElementNS(SVGNS, 'svg');
    svg.classList.add('edges');
    stage = h('div', { class: 'canvas-stage' });
    stage.appendChild(svg);
    sizer = h('div', { class: 'canvas-sizer' }, stage);
    scrollEl = h('div', { class: 'canvas-scroll' }, sizer);
    scrollEl.addEventListener('pointerdown', (ev) => {
      if (ev.target === scrollEl || ev.target === sizer || ev.target === stage || ev.target === svg) select(null);
    });

    drawer = h('div', { class: 'drawer' });
    host.append(toolbar, scrollEl, drawer);
    root.Panel.mount(drawer, { onClose: () => select(null) });

    document.addEventListener('keydown', onKey);
    S.subscribe(onChange);
    render();
  }

  function onChange(reason) {
    if (reason === 'saved' || reason === 'exported' || reason === 'canvas-move') return;
    if (['load', 'new', 'example', 'import'].includes(reason)) { selectedNode = null; selectedEdge = null; root.Panel.show(null); }
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

    for (const el of [...stage.querySelectorAll('.node, .edge-del, .node-empty')]) el.remove();
    if (!s.nodes.length) {
      stage.appendChild(h('div', { class: 'node-empty' }, '위 "+ 단계 추가"로 첫 단계를 만드세요. 왼쪽 메뉴의 "예시 전략 열기"로 완성된 예를 볼 수 있습니다.'));
    }
    for (const n of s.nodes) stage.appendChild(nodeEl(n));
    drawEdges();
  }

  // ── 유형별 도형 모양 ───────────────────────────────────────────────────
  // 윤곽선은 SVG로 그린다(clip-path로 자르면 테두리가 잘리기 때문). 상태(선택·최종·오류 등)는 CSS가 윤곽선 색으로 표시한다
  //   기초한도·현가계수 = 이중 테두리 / 사칙연산 = 둥근 사각 / 고급 수식 = 점선 / 표 조회·누진·부채 집계 = 왼쪽 표 띠
  //   최소·최대 = 아래가 좁은 깔때기 / 조건·분기 = 양옆이 뾰족한 육각형 / 컷오프 = 모서리 잘린 팔각형
  const SYMBOL = { debt: 'Σ', pva: 'PV', pv: 'PV', arith: '±', formula: 'fx', lookup: '▦', progressive: '▤', minmax: '↓', cond: '◇', branch: '◇', cutoff: '⊘' };
  const SLANT = 18, TIP = 16, CUT = 14, R = 14;

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
      case 'lookup': case 'progressive': case 'debt':
        paths.push([roundRect(a, a, w, hh, R), 'sh']);
        paths.push([`M${a + 26},${a} V${a + hh}`, 'sh-line']);
        for (const y of [30, 46, 62]) paths.push([`M${a + 7},${y} H${a + 20}`, 'sh-line']);
        break;
      case 'pva': case 'pv':
        paths.push([roundRect(a, a, w, hh, R), 'sh']);
        paths.push([roundRect(a + 4, a + 4, w - 8, hh - 8, R - 4), 'sh-inner']);
        break;
      default: paths.push([roundRect(a, a, w, hh, R), n.type === 'formula' ? 'sh sh-dash' : 'sh']);
    }
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
        h('span', { class: `type-chip type-${n.type}` },
          h('span', { class: 'type-sym' }, n.type === 'minmax' && n.config.mode === 'max' ? '↑' : (SYMBOL[n.type] || '')),
          E.NODE_TYPES[n.type] || n.type,
          n.type === 'formula' && n.config.lang ? ` · ${E.LANGS[n.config.lang]}` : ''),
        isFinal ? h('span', { class: 'final-chip' }, '최종') : null),
      h('div', { class: 'node-name' }, n.name),
      h('div', { class: 'node-value' }, st.error ? h('span', { class: 'err' }, '오류') : D.stepValueText(n, st)));
    el.prepend(shapeSvg(n));
    ports(n).forEach((label) => {
      const p = portPoint(n, label);
      const port = h('div', {
        class: label === null ? 'port' : `port port-label${st.active && st.value === label ? ' taken' : ''}`,
        style: `left:${p.x - n.x}px;top:${H}px`, title: label === null ? '끌어서 다음 단계에 연결' : `"${label}" 경로 연결`,
      }, label === null ? null : label);
      port.addEventListener('pointerdown', (ev) => startConnect(ev, n, label));
      el.appendChild(port);
    });
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
      const d = curve(portPoint(a, e.label), inPoint(b));
      const key = edgeKey(e);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', `edge${taken ? ' on' : ''}${key === selectedEdge ? ' sel' : ''}`);
      path.setAttribute('marker-end', taken ? 'url(#arrow-on)' : 'url(#arrow)');
      const hit = document.createElementNS(SVGNS, 'path');
      hit.setAttribute('d', d);
      hit.setAttribute('class', 'edge-hit');
      hit.addEventListener('pointerdown', (ev) => startEdgeDrag(ev, e, false));
      svg.append(path, hit);
    }
    if (temp) {
      const t = document.createElementNS(SVGNS, 'path');
      t.setAttribute('d', curve(temp.from, temp.to));
      t.setAttribute('class', `edge temp${temp.snapped ? ' snapped' : ''}`);
      t.setAttribute('marker-end', 'url(#arrow-on)');
      svg.appendChild(t);
    }
    // 선택한 화살표: 삭제 버튼(곡선 가운데) + 끝점 손잡이(끌어서 다른 도형으로 옮기기)
    stage.querySelectorAll('.edge-del, .edge-end').forEach(x => x.remove());
    if (selectedEdge && !temp) {
      const e = s.edges.find(x => edgeKey(x) === selectedEdge);
      if (e && byId.get(e.from) && byId.get(e.to)) {
        const a = portPoint(byId.get(e.from), e.label), b = inPoint(byId.get(e.to));
        stage.appendChild(h('button', {
          class: 'edge-del', type: 'button', title: '연결 삭제 (Delete 키)', 'aria-label': '연결 삭제',
          style: `left:${(a.x + b.x) / 2 - 14}px;top:${(a.y + b.y) / 2 - 14}px`,
          onclick: deleteSelectedEdge,
        }, '✕'));
        const end = h('div', { class: 'edge-end', title: '끌어서 다른 단계로 옮기기', style: `left:${b.x}px;top:${b.y - 10}px` });
        end.addEventListener('pointerdown', (ev) => startEdgeDrag(ev, e, true));
        stage.appendChild(end);
      }
    }
  }

  // ── 조작 ────────────────────────────────────────────────────────────────
  // 포인터 캡처: 끄는 중 커서가 도형 밖으로 나가도 이벤트를 계속 받는다. 일부 입력 장치에서 실패해도 끌기는 계속되게 한다
  function capture(el, ev) {
    try { el.setPointerCapture(ev.pointerId); } catch (e) { /* 캡처 없이 진행 */ }
  }

  function startMove(ev, n, el) {
    if (ev.button !== 0 || ev.target.closest('.port')) return;
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

  // 화살표 끌기(새 연결·끝점 옮기기 공용): 가까운 도형을 강조하고 끝을 입구에 붙인다.
  // 놓을 때 붙은 도형이 있으면 onDrop(도형 id), 없으면 아무것도 하지 않는다
  function dragArrow(ev, el, fromNode, label, skip, onDrop) {
    const from = portPoint(fromNode, label);
    let target = null;
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
      drawEdges({ from, to: n ? inPoint(n) : p, skip, snapped: !!n });
    };
    const end = (drop) => {
      el.onpointermove = el.onpointerup = el.onpointercancel = null;
      const t = target;
      mark(null);
      drawEdges();
      if (drop && t) onDrop(t.id);
    };
    capture(el, ev);
    el.onpointermove = move;
    el.onpointerup = (e2) => { move(e2); end(true); };   // 놓은 자리로 한 번 더 판정(빠르게 끌어도 맞게)
    el.onpointercancel = () => end(false);
    move(ev);
  }

  function startConnect(ev, n, label) {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    dragArrow(ev, ev.currentTarget, n, label, null, (to) => connect(n.id, to, label));
  }

  // 이어 둔 화살표 누르기: 그대로 떼면 선택, 끌면 끝점을 다른 도형으로 옮긴다(손잡이는 바로 끌기)
  function startEdgeDrag(ev, e, immediate) {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const key = edgeKey(e);
    const fromNode = S.strategy.nodes.find(n => n.id === e.from);
    const begin = (e2) => dragArrow(e2, stage, fromNode, e.label, key, (to) => reconnect(key, to));
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

  function reconnect(key, to) {
    const s = S.strategy;
    const old = s.edges.find(x => edgeKey(x) === key);
    if (!old || old.to === to) return;
    const e = Object.assign({}, old, { to });
    if (s.edges.some(x => edgeKey(x) === edgeKey(e))) { root.App.flash('이미 같은 연결이 있습니다', 'info'); return; }
    const edges = s.edges.map(x => (edgeKey(x) === key ? e : x));
    if (E.order(Object.assign({}, s, { edges })).cycle.length) {
      root.App.flash('이 연결은 순서가 고리처럼 돌아가게 만들어 옮기지 않았습니다', 'danger');
      return;
    }
    if (selectedEdge === key) selectedEdge = edgeKey(e);
    S.update(st => { const i = st.edges.findIndex(x => edgeKey(x) === key); st.edges[i] = e; }, 'canvas-edge');
  }

  function connect(from, to, label) {
    const s = S.strategy;
    const e = label === null || label === undefined ? { from, to } : { from, to, label };
    if (s.edges.some(x => edgeKey(x) === edgeKey(e))) return;
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
    if (ev.key === 'Escape') select(null);
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
      st.nodes.push({ id, name: S.uniqueName(E.NODE_TYPES[type]), type, config: defaultConfig(type), format: type === 'debt' || type === 'pva' ? 'money' : 'number', x, y });
      if (sel) {
        const used = new Set(st.edges.filter(e => e.from === sel.id).map(e => e.label));
        const label = sel.type === 'branch' ? (ports(sel).find(l => !used.has(l)) || ports(sel)[0]) : null;
        st.edges.push(label === null ? { from: sel.id, to: id } : { from: sel.id, to: id, label });
      }
    }, 'canvas-add');
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

  root.Canvas = { mount, select, defaultConfig, ports, get selected() { return selectedNode; } };
})(typeof self !== 'undefined' ? self : this);
