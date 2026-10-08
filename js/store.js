/* ============================================================================
   전략 상태 관리 — 현재 열린 전략 1개, 변경 알림, 자동 임시저장, 파일 내보내기·가져오기
   Supabase 서버 저장(cloud.js)이 정식 보관이고, 브라우저 임시저장은 복구용이다.
   cloud = 지금 전략이 연결된 서버 버전 {id, lineage_id, version, owner_id, owner_email, name, note} | null
   ========================================================================== */
(function (root) {
  'use strict';
  const E = root.LimitEngine;
  const DRAFT_KEY = 'limitsim.draft.v1';

  const listeners = new Set();
  // view: "이 건 보기" 모드 — {label, index, count, id, inputs, warnings, nav(delta), close()}. 있으면 화면이 테스트 입력값 대신 이 값으로 계산한다
  const state = { strategy: null, savedAt: null, saveFailed: false, exportedAt: null, view: null, cloud: null };

  // 되돌리기: 수정 직전의 전략 사본을 쌓는다. 테스트 입력값은 전략 설계가 아니라 빼고,
  // 변수 편집기의 글자 입력처럼 잇따르는 수정은 한 번으로 묶는다
  const HISTORY_MAX = 50;
  const NO_HISTORY = new Set(['test-input']);
  const history = [];
  let lastReason = null, lastAt = 0;

  function emit(reason) { for (const fn of listeners) fn(reason); }

  // exportedAt = "여기까지는 보관된 상태"인 시각. 방금 연 전략은 열린 시점 그대로가 보관본이다
  function load(strategy, reason, exportedAt, cloud) {
    state.cloud = cloud || null;            // 파일·예시·새로 만들기는 서버와 연결되지 않은 상태로 연다
    state.migrated = E.migrate(strategy);   // 옛 형식(절사·하한·상한, 합류, 부채 집계, 현가계수, 요소형 기초한도) 단계 변환 수 — 화면이 알린다
    state.view = null;                      // 다른 전략을 열면 이 건 보기는 끝낸다(변수가 달라진다)
    state.strategy = strategy;
    state.exportedAt = exportedAt ? new Date(exportedAt) : new Date(strategy.meta.updated);
    history.length = 0;
    lastReason = null;
    autosave();
    emit(reason || 'load');
  }

  // 모든 수정은 이 함수를 거친다: 되돌리기 기록 → 수정 → 갱신일 → 임시저장 → 화면 알림
  // quiet: 사람이 고친 것이 아닌 보정(위치 없는 도형 자동 배치 등) — 갱신일을 바꾸지 않아 "변경 있음"으로 잡히지 않는다
  function update(mutator, reason, quiet) {
    if (!quiet && !NO_HISTORY.has(reason)) {
      const now = Date.now();
      if (!(reason === 'vars-edit' && lastReason === reason && now - lastAt < 800)) {
        history.push(clone(state.strategy));
        if (history.length > HISTORY_MAX) history.shift();
      }
      lastReason = reason; lastAt = now;
    }
    mutator(state.strategy);
    if (!quiet) state.strategy.meta.updated = new Date().toISOString();
    autosave();
    emit(reason || 'update');
  }

  // 화면 계산에 쓸 입력값(이 건 보기 중이면 그 건의 값). 전략을 바꾸지 않으므로 되돌리기 기록에 남기지 않는다
  function evalInputs() { return state.view ? state.view.inputs : {}; }
  function setView(v) { state.view = v || null; emit('view'); }

  // 마지막 수정 하나를 취소한다. 되돌릴 것이 없으면 false
  function undo() {
    if (!history.length) return false;
    state.strategy = history.pop();
    lastReason = null;
    autosave();
    emit('undo');
    return true;
  }

  let saveTimer = null;
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ strategy: state.strategy, savedAt: new Date().toISOString(), exportedAt: state.exportedAt, cloud: state.cloud }));
        state.savedAt = new Date();
        state.saveFailed = false;
      } catch (e) {
        state.saveFailed = true;   // 사생활 보호 모드 등 저장 불가 — 화면은 그대로 동작한다
      }
      emit('saved');
    }, 300);
  }

  function restoreDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return checkShape(d.strategy) ? d : null;
    } catch (e) { return null; }
  }

  function checkShape(s) {
    return s && typeof s === 'object' && s.schema === E.SCHEMA && s.meta
      && Array.isArray(s.variables) && Array.isArray(s.nodes) && Array.isArray(s.edges);
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function newStrategy() { load(E.emptyStrategy('새 전략'), 'new'); }

  function openExample(i) {
    const ex = (root.LIMIT_EXAMPLES || [])[i || 0];
    if (!ex) return;
    const s = clone(ex);
    s.meta.name = `${ex.meta.name} (사본)`;
    load(s, 'example');
  }

  function safeFileName(name) { return String(name || '전략').replace(/[\\/:*?"<>|]/g, '_').trim() || '전략'; }

  // name: 저장 창에서 정한 이름 — 파일 이름과 파일 안의 전략 이름에만 쓰고, 열린 전략의 이름은 바꾸지 않는다
  function exportJson(name) {
    const s = clone(state.strategy);
    if (name) s.meta.name = name;
    const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${safeFileName(s.meta.name)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    state.exportedAt = new Date();
    autosave();
    emit('exported');
  }

  // 서버에 저장했다: 연결 정보를 바꾸고 "보관됨"으로 표시한다
  function markCloudSaved(cloud) {
    state.cloud = cloud;
    state.exportedAt = new Date();
    autosave();
    emit('cloud-saved');
  }
  function unlinkCloud() { state.cloud = null; autosave(); emit('cloud-saved'); }

  // 가져오기 실패 사유를 돌려준다(성공이면 null)
  function importJson(text) {
    let s;
    try { s = JSON.parse(text); } catch (e) { return '파일을 읽을 수 없습니다 — 한도 스튜디오에서 내보낸 .json 파일인지 확인하세요'; }
    if (!checkShape(s)) return '한도 스튜디오 전략 파일 형식이 아닙니다';
    load(s, 'import');
    return null;
  }

  // 이름 규칙: 비어 있지 않고, [ ] 없이, 변수·단계 전체에서 겹치지 않음
  function nameProblem(name, selfId) {
    const n = String(name || '').trim();
    if (!n) return '이름을 입력하세요';
    if (/[\[\]]/.test(n)) return '이름에 [ ] 는 쓸 수 없습니다';
    if (n.includes('›')) return '이름에 › 는 쓸 수 없습니다(기초한도 중간값 표시에 씁니다)';
    if (n === E.IN_NAME) return `"${E.IN_NAME}"은(는) 합류용으로 예약된 이름입니다`;
    const s = state.strategy;
    if ([...s.variables, ...s.nodes].some(x => x.id !== selfId && x.name === n)) return '같은 이름이 이미 있습니다';
    return null;
  }

  // 내보낸 뒤(또는 처음 연 뒤) 고친 내용이 있는가 — 새로 만들기·열기 전에 경고할지 판단
  function hasUnexported() {
    const s = state.strategy;
    if (!s || (!s.variables.length && !s.nodes.length)) return false;
    return new Date(s.meta.updated) > state.exportedAt;
  }

  function uniqueName(base) {
    const s = state.strategy;
    const used = new Set([...s.variables, ...s.nodes].map(x => x.name));
    if (!used.has(base)) return base;
    for (let i = 2; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  // 구분값을 붙인 단계 이름(앞부분_구분값). 겹치면 앞부분에 번호를 붙인다(예: 새 단계 2_표). base는 검사한 값만 넘긴다
  function suffixedName(base, sfx, selfId) {
    for (let i = 1; ; i++) { const n = `${base}${i > 1 ? ` ${i}` : ''}_${sfx}`; if (!nameProblem(n, selfId)) return n; }
  }

  root.Store = {
    state, load, update, undo, evalInputs, setView, markCloudSaved, unlinkCloud, restoreDraft, newStrategy, openExample, exportJson, importJson,
    nameProblem, uniqueName, suffixedName, clone, hasUnexported,
    get strategy() { return state.strategy; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})(typeof self !== 'undefined' ? self : this);
