/* 단계 설명 문장·결과 표시 — 캔버스·설정 패널·오른쪽 결과 패널이 함께 쓴다 */
(function (root) {
  'use strict';
  const E = root.LimitEngine, S = root.Store;

  const OP_TEXT = { '>=': '≥', '>': '>', '<=': '≤', '<': '<', '=': '=', '<>': '≠', '*': '×', '/': '÷', '+': '+', '-': '−', '^': '^' };

  function refText(ref) {
    if (!ref) return '(비어 있음)';
    const s = S.strategy;
    if (ref.k === 'in') return `[${E.IN_NAME}]`;
    if (ref.k === 'part') {
      const n = S.strategy.nodes.find(x => x.id === ref.id);
      const label = ((n && E.PARTS[n.type]) || []).find(p => p[0] === ref.part)?.[1] || ref.part;
      return n ? `[${n.name}${E.PART_SEP}${label}]` : '[삭제됨]';
    }
    if (ref.k === 'var') { const v = s.variables.find(x => x.id === ref.id); return v ? `[${v.name}]` : '[삭제됨]'; }
    if (ref.k === 'node') { const n = s.nodes.find(x => x.id === ref.id); return n ? `[${n.name}]` : '[삭제됨]'; }
    return ref.k === 'str' ? `"${ref.v}"` : E.fmtNum(ref.v);
  }

  function groupText(g) {
    if (!g || !g.items || !g.items.length) return '(조건 없음)';
    const isBool = (r) => r && r.k === 'var' && (S.strategy.variables.find(v => v.id === r.id) || {}).type === 'bool';
    const rightText = (it) => isBool(it.left) && it.right && it.right.k === 'num' && (it.right.v === 1 || it.right.v === 0) ? (it.right.v ? '예' : '아니오') : refText(it.right);
    const parts = g.items.map(it => it.items ? `(${groupText(it)})` : `${refText(it.left)} ${OP_TEXT[it.op] || it.op} ${rightText(it)}`);
    return parts.join(g.logic === 'or' ? ' 또는 ' : ' 그리고 ');
  }

  function tokensText(tokens) {
    return (tokens || []).map(t => t.t === 'ref' ? refText(t.ref) : t.t === 'num' ? E.fmtNum(t.v) : t.t === 'lp' ? '(' : t.t === 'rp' ? ')' : (OP_TEXT[t.v] || t.v)).join(' ');
  }

  function describe(n) {
    const c = n.config || {};
    switch (n.type) {
      case 'debt': return `부채표 ${refText(c.table)}의 행별 원리금 합계, 고금리 기준 ${refText(c.hiRate)}`;
      case 'pva': return `실질월가처분소득 × 현가계수 — 월소득 ${refText(c.income)}, 불량률 ${refText(c.bad)}, 금리 ${refText(c.rate)}, 기간 ${refText(c.months)}`;
      case 'arith': return tokensText(c.tokens) || '(식 없음)';
      case 'formula': return c.text || '(수식 없음)';
      case 'lookup': return `표 ${refText(c.table)}에서 행 = ${refText(c.row)}${c.col ? `, 열 = ${refText(c.col)}` : ''}`;
      case 'progressive': return `구간표 ${refText(c.table)}로 ${refText(c.base)} 누진 합산`;
      case 'minmax': return `${c.mode === 'max' ? '최댓값' : '최솟값'}: ${(c.items || []).map(refText).join(', ') || '(항목 없음)'}`;
      case 'cond': return `만약 ${groupText(c.when)} 이면 ${refText(c.then)}, 아니면 ${refText(c.else)}`;
      case 'cutoff': return `${groupText(c.when)} 이면 ${c.action === 'reject' ? '대출 거절' : '0원'}${c.input ? `, 아니면 ${refText(c.input)}` : ''}`;
      case 'pv': return `현가계수(연 ${refText(c.rate)}, ${refText(c.months)}개월)${c.payment ? ` × ${refText(c.payment)}` : ''}`;
      case 'branch': return [...(c.cases || []).map(k => `${k.label}: ${groupText(k.when)}`), `그 외: ${c.elseLabel || '그 외'}`].join(' / ');
    }
    return '';
  }

  function stepValueText(n, st) {
    st = st || {};
    if (st.skipped) return '거절로 중단';
    if (!st.active) return '경로 아님';
    if (st.error) return '오류';
    if (n.type === 'cutoff' && st.triggered) return n.config.action === 'reject' ? '거절' : '0원';
    if (n.type === 'cutoff' && !n.config.input) return '통과';
    return E.fmtValue(st.value, n.format);
  }

  root.Describe = { OP_TEXT, refText, groupText, tokensText, describe, stepValueText };
})(typeof self !== 'undefined' ? self : this);
