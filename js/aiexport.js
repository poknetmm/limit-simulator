/* ============================================================================
   AI 검토용 내보내기 — 전략 하나를 ChatGPT 검토 도우미에 넘길 글(형식 v1)로 만든다
   ----------------------------------------------------------------------------
   화면과 무관한 순수 생성부. 브라우저(window.AiExport)와 Node(require) 양쪽에서 같은 코드를 쓴다.
   글의 모양: 머리 + 1~7장, 순서 고정. 받는 쪽이 첫 줄과 장 누락 여부로 입력을 거르므로
   머리·장 제목을 바꾸면 안 된다(바꾸려면 형식 버전을 올린다).
   · 원본 전략 JSON은 붙이지 않는다. 대량 시뮬레이션 결과도 싣지 않는다
   · 계산은 모두 이 엔진이 해서 숫자로 싣는다 — 플러그인은 다시 계산하지 않는다
   · 단계 설명 문장은 Describe(describe.js)를 쓴다. Describe는 Store.strategy를 읽으므로, 만들 전략은 Store.strategy와 같아야 한다

   build(strategy, opt) → 글(string)
     opt: round(검토 회차, 기본 1) · memo(이번 회차 변경 메모, 2회차부터) · question(질문 한 줄, 선택)
          serverVer(서버 버전 숫자·글자, 없으면 생략) · time(내보낸 시각 글자, 기본 지금)
          screenInputs("현재 화면 입력" 열의 입력값 — 기본 {} = 전략에 저장된 테스트 입력값) · Describe(기본 전역)
   ========================================================================== */
(function (root, factory) {
  const X = factory(root, root && root.LimitEngine ? root.LimitEngine : require('./engine.js'));
  if (typeof module === 'object' && module.exports) module.exports = X;
  else root.AiExport = X;
})(typeof self !== 'undefined' ? self : this, function (root, E) {
  'use strict';

  const GLOBAL = typeof globalThis !== 'undefined' ? globalThis : root;
  const HEAD = '[한도 전략 검토 요청 · 형식 v1]';
  const NOTICE = '※ 전략값은 작성자가 정한 값입니다(실제 운영값일 수 있습니다). 예시 고객과 현재 화면 입력은 가상 케이스이며 고객 개인신용정보가 없습니다.';
  const SCREEN_CASE = '현재 화면 입력';

  const esc = (t) => String(t == null ? '' : t).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const row = (cells) => `| ${cells.map(esc).join(' | ')} |`;
  const table = (head, rows) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

  function varValueText(v, val) {
    if (v.type === 'bool') return val ? '예' : '아니오';
    if (v.type === 'choice') return String(val);
    if (v.type === 'money') return E.fmtValue(val, 'money');
    if (v.type === 'percent') return E.fmtValue(val, 'percent');
    return E.fmtNum(val);
  }

  // 사용자가 적는 글(변경 메모·질문)에 주민등록번호·휴대전화 형식이 있는지 — chat.js·중계 함수와 같은 검사
  function personalInfo(text) {
    if (/\d{6}\s*-\s*[1-8]\d{6}/.test(text)) return '주민등록번호';
    if (/01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/.test(text)) return '휴대전화 번호';
    return null;
  }

  const pad = (n) => String(n).padStart(2, '0');
  function timeText(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const normRound = (r) => { const n = Math.floor(Number(r)); return Number.isFinite(n) && n >= 1 ? n : 1; };

  function fileName(s, round) {
    const name = String(s.meta.name || '전략').replace(/[\\/:*?"<>|]/g, '_').trim() || '전략';
    return `한도전략검토_${name}_${normRound(round)}회차.md`;
  }

  function build(s, opt) {
    opt = opt || {};
    const St = root.Store || GLOBAL.Store;
    if (St && St.strategy && St.strategy !== s) throw new Error('AI 검토용 내보내기: 만들 전략이 화면 전략(Store.strategy)과 다릅니다 — 단계 설명 문장이 어긋납니다');
    const D = opt.Describe || root.Describe || GLOBAL.Describe;
    if (!D) throw new Error('AI 검토용 내보내기: Describe(describe.js)를 먼저 불러오세요');

    const round = normRound(opt.round);
    const prep = E.prepare(s);
    const nodesById = new Map(s.nodes.map(n => [n.id, n]));
    const fid = E.finalNodeId(s);
    const inputs = s.variables.filter(v => v.kind === 'input');
    const params = s.variables.filter(v => v.kind === 'param' && v.type !== 'table');
    const tables = s.variables.filter(v => v.type === 'table');
    const out = [];

    // 머리
    out.push(HEAD);
    out.push(`전략: ${s.meta.name}${opt.serverVer ? ` (서버 v${opt.serverVer})` : ''} · 내보낸 시각: ${opt.time || timeText()}`);
    out.push(NOTICE);

    // 1. 개요
    const cases = [{ id: SCREEN_CASE, inputs: opt.screenInputs || {} }, ...(s.samples || [])];
    out.push('', '## 1. 전략 개요', s.meta.description || '(설명 없음)',
      `단계 ${s.nodes.length}개 · 변수 ${s.variables.length}개 · 예시 고객 ${(s.samples || []).length}건 · 최종 단계: ${fid ? nodesById.get(fid).name : '(없음)'}`);

    // 2. 입력값
    out.push('', '## 2. 입력값(고객)');
    out.push(table(['이름', '형식', '기본값', '설명'], inputs.map(v => [
      `[${v.name}]`, E.VAR_TYPES[v.type] + (v.options ? `(${v.options.join('·')})` : ''),
      v.type === 'debt' ? '아래 부채표' : varValueText(v, v.value), v.desc || ''])));
    for (const v of inputs.filter(x => x.type === 'debt')) {
      out.push('', `### 부채표 [${v.name}] — 기간·금리는 전략값, 잔액은 고객 입력`);
      out.push(table(['행', '업권', '대출구분', '기간(개월)', '금리', '기본 잔액'], v.rows.map((r, i) => [
        i + 1, r.sector, r.kind, E.fmtNum(r.months), E.fmtValue(r.rate, 'percent'), E.fmtValue(r.balance, 'money')])));
    }

    // 3. 전략값
    out.push('', '## 3. 전략값(파라미터)');
    out.push(table(['이름', '값', '설명'], params.map(v => [`[${v.name}]`, varValueText(v, v.value), v.desc || ''])));

    // 4. 기준표
    out.push('', '## 4. 기준표');
    for (const t of tables) {
      out.push('', `### [${t.name}]${t.desc ? ` — ${t.desc}` : ''}`);
      const rowHead = t.rows.mode === 'band' ? '구간' : '행 기준';
      const colHeads = t.cols ? t.cols.keys.map((_, j) => E.axisKeyLabel(t.cols, j)) : ['값'];
      out.push(table([rowHead, ...colHeads], t.rows.keys.map((_, i) => [
        E.axisKeyLabel(t.rows, i), ...colHeads.map((_, j) => { const c = (t.cells[i] || [])[j]; return c === null || c === undefined || c === '' ? '(빈칸)' : E.fmtNum(c); })])));
    }

    // 5. 계산 흐름
    const num = new Map(prep.ord.map((id, i) => [id, i + 1]));
    out.push('', '## 5. 계산 흐름', '계산 순서대로 적는다. → 는 다음 단계, ★ 는 최종 단계.');
    for (const id of prep.ord) {
      const n = nodesById.get(id);
      const nexts = s.edges.filter(e => e.from === id).map(e => {
        const t = nodesById.get(e.to);
        const label = `${num.get(e.to)}. ${t.name}`;
        return e.label ? `${e.label}이면 ${label}` : label;
      });
      out.push(`${num.get(id)}. ${id === fid ? '★ ' : ''}[${n.name}] (${E.NODE_TYPES[n.type]}) — ${D.describe(n)}${nexts.length ? ` → ${nexts.join(', ')}` : ''}`);
    }

    // 6. 예시 고객 결과
    const results = cases.map(c => ({ c, r: E.evaluate(s, c.inputs, prep) }));
    const changed = (c) => {
      const parts = [];
      for (const [k, val] of Object.entries(c.inputs)) {
        const v = s.variables.find(x => x.id === k);
        if (!v) continue;
        if (v.type === 'debt') {
          const nz = val.map((b, i) => [b, v.rows[i]]).filter(([b]) => b);
          parts.push(nz.length ? `부채표 ${nz.map(([b, r]) => `${r.sector} ${r.kind} ${E.fmtValue(b, 'money')}`).join(', ')}` : '부채표 모두 0');
        } else parts.push(`${v.name} = ${varValueText(v, val)}`);
      }
      return parts.length ? parts.join(' · ') : '(기본값)';
    };
    const statusText = (r) => {
      if (r.status === 'reject') return '거절';
      if (r.status === 'error') return '오류';
      const zero = Object.entries(r.steps).some(([id, st]) => st.active && st.triggered && nodesById.get(id).config.action === 'zero');
      return zero ? '0원' : '통과';
    };
    out.push('', '## 6. 예시 고객 결과', '### 6-1. 요약');
    out.push(table(['케이스', '바꾼 입력', '결과', '최종 한도', '결정요인'], results.map(({ c, r }) => [
      c.id, changed(c), statusText(r), r.status === 'ok' ? E.fmtValue(r.final, 'money') : '—',
      r.determinant || (r.errors || []).join(' / ') || '—'])));
    out.push('', '### 6-2. 단계별 값', '— = 이번 경로가 아님, 중단 = 앞에서 거절되어 계산하지 않음. "이름 › 항목" 줄은 중간값: 부채표 합계 줄은 맨 위에 모아 두고(부채표는 단계가 아니라 변수이며, 단계가 그 합계를 가져다 씀), 기초한도 단계의 줄 값은 그 단계 바로 아래에 둔다.');
    const cellOf = (n, st) => {
      if (!st) return '—';
      if (st.skipped) return '중단';
      if (st.cycle) return '순환';
      if (st.stopped) return '계산 중단';
      if (!st.active) return '—';
      return D.stepValueText(n, st);
    };
    const rows6 = [];
    // 부채표 합계 — 부채표 변수에서 바로 구한 값(result.debts). 이번 계산에서 쓰지 않았으면 경로 아님(—), 거절로 멈춘 경우는 중단
    for (const v of s.variables.filter(x => x.type === 'debt')) {
      for (const [key, label, fmt] of E.DEBT_PARTS) {
        if (key === 'high' && !v.hiRate) continue;   // 고금리 기준이 없으면 고금리채무를 계산하지 않는다
        rows6.push([`${v.name}${E.PART_SEP}${label}`, ...results.map(({ r }) => {
          const d = (r.debts || {})[v.id];
          if (!d) return r.status === 'reject' ? '중단' : '—';
          return d.parts[key] === undefined ? '—' : E.fmtValue(d.parts[key], fmt);
        })]);
      }
    }
    for (const id of prep.ord) {
      const n = nodesById.get(id);
      rows6.push([`${num.get(id)}. ${n.name}`, ...results.map(({ r }) => cellOf(n, r.steps[id]))]);
      // 기초한도 단계의 중간값(앞 줄들·현가계수) — 다른 단계가 "단계 › 항목"으로 쓰는 값
      for (const [key, label, fmt] of E.partsOf(n)) {
        rows6.push([`   ${n.name}${E.PART_SEP}${label}`, ...results.map(({ r }) => {
          const st = r.steps[id];
          if (!st || st.skipped || st.cycle || st.stopped || !st.active) return cellOf(n, st);
          return st.parts && key in st.parts ? E.fmtValue(st.parts[key], fmt) : '—';
        })]);
      }
    }
    out.push(table(['단계', ...results.map(x => x.c.id)], rows6));

    // 7. 검토 요청 — 메모의 둘째 줄부터는 들여써 목록 항목 안에 머물게 한다(장 제목처럼 읽히지 않게)
    const memoLines = String(opt.memo || '').split('\n').map(l => l.trim()).filter(Boolean);
    const memoText = round > 1 ? (memoLines.length ? memoLines.join('\n    ') : '(메모 없음)') : '없음(1회차)';
    const question = String(opt.question || '').replace(/\s+/g, ' ').trim();
    out.push('', '## 7. 검토 요청', `- 검토 회차: ${round}`,
      `- 이번 회차 변경 메모: ${memoText}`,
      '- 요청: 위 전략을 검토 관점에 따라 검토해 주세요.');
    if (question) out.push(`- 추가 질문: ${question}`);
    return out.join('\n') + '\n';
  }

  return { HEAD, NOTICE, SCREEN_CASE, build, personalInfo, timeText, fileName };
});
