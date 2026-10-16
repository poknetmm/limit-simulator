/* ============================================================================
   전략 의논 — 오른쪽 패널의 두 번째 탭. 지금 전략을 두고 Claude와 의논한다
   · 대화는 이 탭(브라우저 메모리)에만 있다. 새로고침·탭 닫기·전략 바꾸기(열기·새로 만들기·가져오기)·로그아웃이면 사라진다
   · 서버(중계 함수 limitsim-chat)에는 {messages, strategy}만 보낸다. strategy는 대화를 시작할 때의 전략으로 고정하고,
     그 뒤 바뀐 전략은 다음 질문 끝 "[화면 상태]"에 붙인다 — 앞 대화를 고치지 않아야 캐시·생각 블록이 유지된다
   · 받은 응답 블록(생각 블록 포함)은 바꾸지 않고 그대로 이어 붙인다. 생각 내용은 화면에 보이지 않는다
   · 모델이 run_simulation을 부르면 이 브라우저의 계산 엔진으로 계산해 돌려준다. 질문 1개당 도구 왕복 최대 5회
   · 답 글은 글자로만 그린다(HTML로 해석하지 않는다)
   ========================================================================== */
(function (root) {
  'use strict';
  const E = root.LimitEngine, S = root.Store, D = root.Describe, { h, clear } = root.UI;
  const $ = (sel) => document.querySelector(sel);

  const FN = 'limitsim-chat';
  const MAX_TOOL_ROUNDS = 5;
  const RESET_REASONS = new Set(['load', 'new', 'example', 'import']);

  let messages = [];        // API 형식 대화 이력
  let baseStrategy = null;  // 대화 시작 때의 전략(모델용) — 매 요청 같은 값을 보낸다
  let lastDesign = null;    // 모델이 마지막으로 본 전략(모델용 JSON 글자)
  let busy = false;
  let gen = 0;              // 대화 세대 — [새 대화]·전략 바꾸기마다 늘린다. 받는 중에 바뀌면 그 답은 버린다
  let left = null;          // {day_left, month_left}

  // 주민등록번호·휴대전화 형식 — 중계 함수(chat.ts personalInfo)와 같은 검사
  function personalInfo(text) {
    if (/\d{6}\s*-\s*[1-8]\d{6}/.test(text)) return '주민등록번호';
    if (/01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/.test(text)) return '휴대전화 번호';
    return null;
  }

  // 모델에 보내는 전략: 화면 배치 좌표·대량 예시·갱신 시각을 빼고, 테스트 입력값(고객 입력 값·부채 잔액)은 "[화면 상태]"로 따로 보낸다
  function modelStrategy(s) {
    const c = S.clone(s);
    delete c.samples;
    if (c.meta) delete c.meta.updated;
    for (const n of c.nodes) { delete n.x; delete n.y; }
    for (const v of c.variables) {
      if (v.kind === 'input' && v.type !== 'table' && v.type !== 'debt') delete v.value;
      if (v.type === 'debt') for (const r of v.rows) delete r.balance;
    }
    return c;
  }

  function reset() {
    messages = []; baseStrategy = null; lastDesign = null;
    gen++;
    render();
  }

  // ── 지금 화면 상태(테스트 입력값·결과·전략 변경분) ─────────────────────────
  function inputsSummary(s, inputs) {
    const lines = [];
    for (const v of s.variables.filter(x => x.kind === 'input' && x.type !== 'table' && x.type !== 'debt')) {
      const val = Object.prototype.hasOwnProperty.call(inputs, v.id) ? inputs[v.id] : v.value;
      lines.push(`${v.name} = ${v.type === 'bool' ? (val ? '예' : '아니오') : v.type === 'choice' ? val : E.fmtValue(E.toNum(val) ?? val, v.type)}`);
    }
    for (const v of s.variables.filter(x => x.type === 'debt')) {
      const bal = Array.isArray(inputs[v.id]) ? inputs[v.id] : v.rows.map(r => r.balance || 0);
      const used = v.rows.map((r, i) => [r, bal[i]]).filter(([, b]) => b);
      lines.push(`${v.name}: ${used.length ? used.map(([r, b]) => `${r.sector}·${r.kind} ${E.fmtValue(b, 'money')}`).join(', ') : '잔액 없음'}`);
    }
    return lines;
  }

  function resultSummary(s, r) {
    const fid = r.finalNodeId && s.nodes.find(n => n.id === r.finalNodeId);
    const status = r.status === 'ok' ? '정상 산출' : r.status === 'reject' ? '대출 거절' : '확인 필요';
    const steps = [];
    for (const id of E.order(s).order) {
      const n = s.nodes.find(x => x.id === id), st = r.steps[id] || {};
      if (st.active || st.error) steps.push(`${n.name}: ${st.error ? `오류 — ${st.error}` : D.stepValueText(n, st)}`);
    }
    return {
      상태: status,
      최종한도: r.final === null ? null : E.fmtValue(r.final, fid ? fid.format : 'money'),
      최종한도_값: r.final,
      결정요인: r.determinant || null,
      오류: [...new Set([...E.validate(s), ...r.errors])],
      단계별: steps.slice(0, 120),
    };
  }

  function snapshot() {
    const s = S.strategy, inputs = S.evalInputs();
    let r;
    try { r = E.evaluate(s, inputs); } catch (e) { r = { status: 'error', final: null, steps: {}, errors: [e.message] }; }
    const parts = ['[화면 상태]', '단일 시뮬레이션 입력값:', ...inputsSummary(s, inputs).map(l => `- ${l}`),
      `결과: ${JSON.stringify(resultSummary(s, r))}`];
    const design = JSON.stringify(modelStrategy(s));
    if (design !== lastDesign) {
      parts.push(`전략이 대화 시작 이후 바뀌었습니다. 지금 전략 전체(JSON): ${design}`);
      lastDesign = design;
    }
    return parts.join('\n');
  }

  // ── run_simulation — 화면 테스트 입력값에서 일부만 바꿔 계산 ───────────────
  function toValue(v, text) {
    const t = String(text).trim();
    if (v.type === 'bool') return /^(예|y|yes|true|1)$/i.test(t);
    if (v.type === 'choice') return t;
    const pct = /%$/.test(t);
    const n = Number(t.replace(/[,원%\s]/g, ''));
    if (!Number.isFinite(n)) throw new Error(`[${v.name}] 값 "${t}"을(를) 숫자로 읽을 수 없습니다`);
    return pct ? n / 100 : n;
  }

  function runSimulation(input) {
    const s = S.strategy, base = S.evalInputs(), ins = { ...base }, changed = [], warnings = [];
    for (const it of (input && input.inputs) || []) {
      const v = s.variables.find(x => x.name === it.name && x.kind === 'input' && x.type !== 'table' && x.type !== 'debt');
      if (!v) { warnings.push(`고객 입력값 [${it.name}]이(가) 없어 무시했습니다`); continue; }
      ins[v.id] = toValue(v, it.value);
      if (v.type === 'choice' && v.options && !v.options.includes(ins[v.id])) warnings.push(`[${v.name}]의 선택지에 "${ins[v.id]}"이(가) 없습니다`);
      changed.push(`${v.name} = ${it.value}`);
    }
    for (const d of (input && input.debts) || []) {
      const v = s.variables.find(x => x.type === 'debt' && x.name === d.table);
      const i = v ? v.rows.findIndex(r => r.sector === d.sector && r.kind === d.kind) : -1;
      if (i < 0) { warnings.push(`부채표 [${d.table}]에 ${d.sector}·${d.kind} 행이 없어 무시했습니다`); continue; }
      if (!Array.isArray(ins[v.id])) ins[v.id] = v.rows.map(r => r.balance || 0);
      ins[v.id] = ins[v.id].slice();
      ins[v.id][i] = Number(d.balance) || 0;
      changed.push(`${v.name} ${d.sector}·${d.kind} = ${E.fmtValue(Number(d.balance) || 0, 'money')}`);
    }
    const r = E.evaluate(s, ins);
    return { 바꾼_입력: changed, 경고: warnings, ...resultSummary(s, r) };
  }

  // ── 서버 호출(스트리밍) ─────────────────────────────────────────────────
  // 중계 함수의 data: 줄을 하나씩 onEvent로 넘긴다. 끝나면 마지막 done/error 이벤트를 돌려준다
  async function request(onEvent) {
    const res = await root.Cloud.callFunction(FN, { messages, strategy: baseStrategy });
    if (!res.ok) {
      let j = {};
      try { j = await res.json(); } catch (e) { /* 본문 없음 */ }
      if (j.day_left !== undefined && j.day_left !== null) left = { day_left: j.day_left, month_left: j.month_left };
      return { type: 'error', error: j.error || `서버 오류(${res.status})` };
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', last = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, k).trim();
        buf = buf.slice(k + 2);
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.day_left !== undefined && ev.day_left !== null) left = { day_left: ev.day_left, month_left: ev.month_left };
        if (ev.type === 'done' || ev.type === 'error') last = ev;
        onEvent(ev);
      }
    }
    return last || { type: 'error', error: '답이 중간에 끊겼습니다 — 다시 시도하세요' };
  }

  // 질문 하나: 보내고, 도구 요청이면 계산해 다시 보낸다(최대 5회). 실패하면 대화를 질문 전으로 되돌린다
  async function ask(question) {
    const kind = personalInfo(question);
    if (kind) { showError(`${kind} 형식이 들어 있어 보낼 수 없습니다 — 가상 데이터 전용입니다`); return; }
    if (!root.Cloud.user) { showError('로그인한 뒤 쓸 수 있습니다'); return; }
    const before = messages.slice();
    if (!baseStrategy) { baseStrategy = modelStrategy(S.strategy); lastDesign = JSON.stringify(baseStrategy); }
    messages.push({ role: 'user', content: [{ type: 'text', text: question }, { type: 'text', text: snapshot() }] });
    const turn = { q: question, a: '', notes: [], error: null };
    view.turns.push(turn);
    busy = true;
    render();
    const my = gen;   // 받는 중에 [새 대화]를 누르면 이 대화는 버린다
    try {
      for (let round = 0; ; round++) {
        const end = await request((ev) => { if (ev.type === 'text' && my === gen) { turn.a += ev.text; renderTurns(); } });
        if (my !== gen) return;
        if (end.type === 'error') throw new Error(end.error);
        const hasTool = end.content.some(b => b.type === 'tool_use');
        if (end.stop_reason === 'refusal') throw new Error('답할 수 없는 질문입니다');
        if (end.stop_reason === 'max_tokens' && hasTool) throw new Error('답이 너무 길어 끊겼습니다 — 질문을 나눠 보세요');
        messages.push({ role: 'assistant', content: end.content });
        if (end.stop_reason !== 'tool_use') break;
        if (round >= MAX_TOOL_ROUNDS) throw new Error(`계산을 ${MAX_TOOL_ROUNDS}번 넘게 요청해 멈췄습니다 — 질문을 좁혀 보세요`);
        const results = end.content.filter(b => b.type === 'tool_use').map(b => {
          if (b.name !== 'run_simulation') return { type: 'tool_result', tool_use_id: b.id, is_error: true, content: '없는 도구입니다' };
          try {
            const out = runSimulation(b.input);
            turn.notes.push(`계산: ${out.바꾼_입력.length ? out.바꾼_입력.join(', ') : '지금 입력값 그대로'} → ${out.상태}${out.최종한도 ? ` ${out.최종한도}` : ''}`);
            return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) };
          } catch (e) {
            turn.notes.push(`계산 실패: ${e.message}`);
            return { type: 'tool_result', tool_use_id: b.id, is_error: true, content: e.message };
          }
        });
        messages.push({ role: 'user', content: results });
        turn.a += turn.a && !/\n$/.test(turn.a) ? '\n' : '';
        renderTurns();
      }
    } catch (e) {
      if (my !== gen) return;
      messages = before;
      if (!before.length) { baseStrategy = null; lastDesign = null; }
      turn.error = e.message || String(e);
    } finally {
      busy = false;
      render();
    }
  }

  // ── 화면 ─────────────────────────────────────────────────────────────────
  const view = { turns: [] };
  function showError(msg) { const el = $('#chatError'); if (el) el.textContent = msg; }

  function renderTurns() {
    const host = clear($('#chatLog'));
    if (!view.turns.length) {
      host.appendChild(h('div', { class: 'chat-empty muted small' },
        '지금 열린 전략을 두고 질문하세요. 예: "직군 CAP이 결정요인이 되는 이유는?", "월소득을 500만 원으로 바꾸면 한도는?"'));
      return;
    }
    for (const t of view.turns) {
      host.appendChild(h('div', { class: 'chat-q' }, t.q));
      const a = h('div', { class: 'chat-a' });
      for (const n of t.notes) a.appendChild(h('div', { class: 'chat-note' }, n));
      if (t.a) a.appendChild(h('div', { class: 'chat-text' }, t.a));
      if (t.error) a.appendChild(h('div', { class: 'chat-err' }, t.error));
      else if (busy && t === view.turns[view.turns.length - 1] && !t.a) a.appendChild(h('div', { class: 'muted small' }, '답을 기다리는 중…'));
      host.appendChild(a);
    }
    host.scrollTop = host.scrollHeight;
  }

  function render() {
    if (!messages.length && !busy) view.turns = view.turns.filter(t => t.error).slice(-1);
    renderTurns();
    $('#chatSend').disabled = busy;
    const usd = (n) => `$${Number(n).toFixed(2)}`;
    $('#chatLeft').textContent = left ? `오늘 남은 사용량 ${usd(left.day_left)} · 이번 달 팀 남은 사용량 ${usd(left.month_left)}` : '';
  }

  function showPane(name) {
    document.querySelectorAll('.res-tab').forEach(b => { const on = b.dataset.pane === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    $('#resPaneSim').hidden = name !== 'sim';
    $('#resPaneChat').hidden = name !== 'chat';
  }

  function mount() {
    document.querySelectorAll('.res-tab').forEach(b => b.addEventListener('click', () => showPane(b.dataset.pane)));
    const input = $('#chatInput');
    const go = () => {
      const q = input.value.trim();
      if (!q || busy) return;
      showError('');
      input.value = '';
      ask(q);
    };
    $('#chatForm').addEventListener('submit', (ev) => { ev.preventDefault(); go(); });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); go(); } });
    $('#chatNew').addEventListener('click', () => { view.turns = []; showError(''); reset(); });
    S.subscribe((reason) => { if (RESET_REASONS.has(reason)) { view.turns = []; reset(); } });
    render();
  }

  root.Chat = { mount, reset: () => { view.turns = []; reset(); }, _runSimulation: runSimulation, _modelStrategy: modelStrategy, _personalInfo: personalInfo };
})(typeof self !== 'undefined' ? self : this);
