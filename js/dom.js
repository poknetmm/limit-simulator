/* 화면 공용 도우미 — DOM 생성·숫자 입력칸 */
(function (root) {
  'use strict';
  const E = root.LimitEngine;

  // h('div', {class:'x', onclick: fn}, '글자', 자식요소, [배열도 가능])
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    children.forEach(add);
    return el;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  // 입력칸 표시값 ↔ 저장값. 비율은 90(%)로 보이고 0.9로 저장한다
  function toDisplay(v, format) {
    if (v === null || v === undefined || v === '') return '';
    const n = E.toNum(v);
    if (n === null) return String(v);
    if (format === 'percent') return E.fmtNum(n * 100, 6);
    if (format === 'money') return E.fmtNum(n, 0);
    return E.fmtNum(n, 10);
  }
  function fromDisplay(text, format) {
    const t = String(text).replace(/[,\s원%]/g, '');
    if (t === '') return null;
    const n = Number(t);
    if (isNaN(n)) return undefined;   // 잘못된 입력
    return format === 'percent' ? n / 100 : n;
  }

  // 숫자 입력칸: 입력 중에는 그대로 두고, 칸을 벗어나면 천 단위 쉼표로 정리
  function numberField(value, format, onChange, attrs) {
    const input = h('input', Object.assign({ type: 'text', inputmode: 'decimal', class: 'num-input', value: toDisplay(value, format) }, attrs || {}));
    const suffix = format === 'percent' ? '%' : format === 'money' ? '원' : null;
    input.addEventListener('input', () => {
      const v = fromDisplay(input.value, format);
      input.classList.toggle('invalid', v === undefined);
      if (v !== undefined) onChange(v);
    });
    input.addEventListener('blur', () => {
      const v = fromDisplay(input.value, format);
      if (v !== undefined) input.value = toDisplay(v, format);
    });
    return suffix ? h('span', { class: 'num-wrap' }, input, h('span', { class: 'num-suffix' }, suffix)) : input;
  }

  // 아래에서 밀려 올라오는 팝업(설정 패널·변수 편집 창). host에 열림 표시(pop-open)와
  // 팝업 높이(--pop-h)를 알려 뒤 화면이 가려진 만큼 스크롤 여백을 두게 한다
  function slidePopup(el, host) {
    el.classList.add('popup');
    const isOpen = () => el.classList.contains('open');
    const sync = () => host.style.setProperty('--pop-h', `${isOpen() ? el.offsetHeight : 0}px`);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sync).observe(el);
    return {
      open() { el.classList.add('open'); host.classList.add('pop-open'); sync(); },
      close() { el.classList.remove('open'); host.classList.remove('pop-open'); sync(); },
      get isOpen() { return isOpen(); },
      height() { return isOpen() ? el.offsetHeight : 0; },
    };
  }

  // 가운데 창(모달): 배경을 누르거나 Esc·✕로 닫는다. {close, win}을 돌려준다. onClose는 어떻게 닫혀도 한 번 불린다
  function modal(title, body, wide, onClose) {
    const back = h('div', { class: 'modal-back' });
    let closed = false;
    const close = () => { if (closed) return; closed = true; back.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    const win = h('div', { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'editor-head' }, h('div', { class: 'panel-title' }, title),
        h('button', { class: 'btn-round', type: 'button', 'aria-label': '닫기', title: '닫기 (Esc)', onclick: close }, '✕')),
      body);
    back.addEventListener('pointerdown', (ev) => { if (ev.target === back) close(); });
    back.appendChild(win);
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey);
    return { close, win };
  }

  root.UI = { h, clear, numberField, toDisplay, fromDisplay, slidePopup, modal };
})(typeof self !== 'undefined' ? self : this);
