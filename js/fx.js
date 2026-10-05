/* ============================================================================
   화면 재미 요소 — 캐릭터·설명 말풍선·카운트업·첫 방문 안내
   ----------------------------------------------------------------------------
   · 캐릭터: 선화(線畫) 스타일의 비서 로봇(가슴 배지 ₩). 색은 전부 토큰
     표정(data-mood): happy 기쁨 · worry 걱정 · think 생각 중 · '' 기본. 눈은 마우스를 따라보고 가끔 깜빡인다
   · 설명 말풍선: data-tip="제목|설명"이 있는 요소에 마우스를 올리면(키보드 포커스 포함) 화면 맨 위 레이어에 띄운다
   · 첫 방문 안내: 로그인 뒤 프로세스 화면에서 한 번(닫으면 다시 안 뜸). 캔버스 왼쪽 위 ? 버튼으로 다시 본다
   · 운영체제의 '애니메이션 줄이기'가 켜져 있으면 움직임을 모두 끈다(app.css 끝의 규칙 + 아래 REDUCED)
   ========================================================================== */
(function (root) {
  'use strict';
  const $$ = (sel, r) => [...(r || document).querySelectorAll(sel)];
  const REDUCED = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TOUR_KEY = 'limitsim.tour';

  // ── 캐릭터 ──────────────────────────────────────────────────────────────
  function mascot(pose) {
    const body =
      '<ellipse cx="100" cy="226" rx="54" ry="8" class="shade"/>' +
      '<rect x="74" y="182" width="20" height="34" rx="9" class="fill ln"/><rect x="106" y="182" width="20" height="34" rx="9" class="fill ln"/>' +
      '<path d="M66 222 q0-12 14-12 h12 q4 0 4 6 v6 z" class="fill ln"/><path d="M134 222 q0-12-14-12 h-12 q-4 0-4 6 v6 z" class="fill ln"/>' +
      '<rect x="58" y="104" width="84" height="88" rx="34" class="fill ln"/>' +
      '<path d="M120 110 q20 10 20 40 q0 34-20 40" class="shade" opacity=".9"/>' +
      '<rect x="58" y="104" width="84" height="88" rx="34" fill="none" class="ln"/>' +
      // 가슴 ₩ 배지
      '<circle cx="100" cy="140" r="13" class="accs ln" style="stroke-width:2.5"/>' +
      '<path d="M92 133 l3 14 l5-10 l5 10 l3-14 M90 139 h20" fill="none" class="ln" style="stroke-width:2.2"/>' +
      '<rect x="40" y="52" width="14" height="30" rx="7" class="fill ln"/><rect x="146" y="52" width="14" height="30" rx="7" class="fill ln"/>' +
      '<path d="M100 28 V12" class="ln"/><circle cx="100" cy="9" r="7" class="acc ln" style="stroke-width:2.5"/>' +
      '<rect x="48" y="26" width="104" height="80" rx="36" class="fill ln"/>' +
      '<rect x="62" y="42" width="76" height="48" rx="21" class="shade ln"/>' +
      '<g class="m-eyes"><ellipse cx="86" cy="64" rx="5" ry="7" class="ink"/><ellipse cx="114" cy="64" rx="5" ry="7" class="ink"/></g>' +
      '<path class="m-brow ln" d="M78 50 l12 4 M122 50 l-12 4" style="stroke-width:2.5"/>' +
      '<path class="m-m0" d="M92 77 q8 6 16 0" fill="none" style="stroke:var(--ink);stroke-width:2.5;stroke-linecap:round"/>' +
      '<path class="m-m1" d="M90 75 q10 12 20 0 z" style="fill:var(--ink);stroke:var(--ink);stroke-width:2;stroke-linejoin:round"/>' +
      '<path class="m-m2" d="M91 80 q4-4 9 0 q5 4 9 0" fill="none" style="stroke:var(--ink);stroke-width:2.5;stroke-linecap:round"/>' +
      '<ellipse cx="76" cy="76" rx="5" ry="3" class="accs"/><ellipse cx="124" cy="76" rx="5" ry="3" class="accs"/>' +
      // 상황 소품 — 기쁨: 반짝이 / 걱정: 땀방울 / 생각 중: 점 세 개 말풍선
      '<g class="m-fx m-fx1"><path d="M166 30 l3 8 l8 3 l-8 3 l-3 8 l-3-8 l-8-3 l8-3z M150 14 l2 5 l5 2 l-5 2 l-2 5 l-2-5 l-5-2 l5-2z" class="acc"/></g>' +
      '<g class="m-fx m-fx2"><path d="M158 40 q6 10 0 14 q-6-4 0-14z" style="fill:var(--info-soft);stroke:var(--info);stroke-width:2"/></g>' +
      '<g class="m-fx m-fx3"><rect x="148" y="6" width="46" height="24" rx="12" class="fill ln" style="stroke-width:2.5"/><circle cx="160" cy="18" r="3" class="ink"/><circle cx="171" cy="18" r="3" class="ink"/><circle cx="182" cy="18" r="3" class="ink"/></g>';
    const arms = pose === 'wave'
      ? '<rect x="128" y="112" width="18" height="50" rx="9" class="fill ln" transform="rotate(-18 137 116)"/>' +
        '<g class="m-wave"><rect x="47" y="64" width="18" height="58" rx="9" class="fill ln" transform="rotate(-38 56 120)"/><circle cx="23" cy="74" r="13" class="fill ln"/><path d="M12 66 l-6-6 M19 61 l-3-9 M28 61 l2-9" class="ln" style="stroke-width:2.5"/></g>'
      : '<path d="M60 150 q40-14 40 0 q0-14 40 0 v36 q-40-14-40 0 q0-14-40 0 z" class="fill ln"/><path d="M100 150 v36" class="ln"/>' +
        '<path d="M70 160 q14-4 22 0 M70 170 q14-4 22 0 M108 160 q14-4 22 0" class="ln" style="stroke-width:2;stroke:var(--muted)"/><circle cx="56" cy="168" r="10" class="fill ln"/><circle cx="144" cy="168" r="10" class="fill ln"/>';
    return `<svg class="mascot" viewBox="0 0 200 240" aria-hidden="true" data-mood=""><g class="m-all">${body}${arms}</g></svg>`;
  }

  // data-mascot 자리를 캐릭터로 바꾼다. 처음 그려질 때 한 번 손을 흔든다
  function paint(r) {
    for (const el of $$('[data-mascot]', r)) {
      const wrap = document.createElement('span');
      wrap.className = 'mwrap greet';
      if (el.id) wrap.id = el.id;
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'img');
      wrap.setAttribute('aria-label', '한도 비서 캐릭터');
      wrap.innerHTML = mascot(el.getAttribute('data-mascot'));
      el.replaceWith(wrap);
      setTimeout(() => wrap.classList.remove('greet'), 1800);
    }
  }

  // 오른쪽 패널 캐릭터의 표정·말. hold 뒤 기본 표정으로(걱정은 그대로 둔다)
  let moodTimer = null;
  function mood(m, hold) {
    const svg = document.querySelector('#buddy .mascot');
    if (!svg) return;
    clearTimeout(moodTimer);
    svg.setAttribute('data-mood', m || '');
    if (m && hold) moodTimer = setTimeout(() => svg.setAttribute('data-mood', ''), hold);
  }
  function say(text) {
    const w = document.getElementById('buddy');
    if (w) { w.setAttribute('data-say', text); w.setAttribute('aria-label', text); }
  }
  // 알림 앞에 붙는 작은 얼굴
  function face(m) {
    const el = document.createElement('span');
    el.className = 'face';
    el.innerHTML = mascot('wave');
    el.firstChild.setAttribute('data-mood', m || '');
    return el;
  }

  // ── 카운트업: from → to로 0.45초 동안 숫자를 굴린다. 끝나면 한 번 강조색 ──
  const counting = new WeakMap();
  function countTo(el, from, to, fmt) {
    cancelAnimationFrame(counting.get(el));
    if (REDUCED || !Number.isFinite(from) || !Number.isFinite(to) || from === to) { el.textContent = fmt(to); return; }
    // 첫 프레임 시각이 호출 시각보다 앞설 수 있어 진행률을 0~1로 묶는다. 탭이 가려져 프레임이 멈춰도 끝값은 맞춘다
    const t0 = performance.now(), dur = 450;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(counting.get(el));
      el.textContent = fmt(to);
      el.classList.remove('flash-val'); void el.offsetWidth; el.classList.add('flash-val');
    };
    const tick = (now) => {
      const k = Math.min(1, Math.max(0, (now - t0) / dur)), e = 1 - Math.pow(1 - k, 3);
      if (k >= 1) { finish(); return; }
      el.textContent = fmt(from + (to - from) * e);
      counting.set(el, requestAnimationFrame(tick));
    };
    counting.set(el, requestAnimationFrame(tick));
    setTimeout(finish, dur + 80);
  }

  // 클래스를 지웠다 다시 붙여 CSS 애니메이션을 한 번 재생한다
  function replay(el, cls, delay) {
    if (!el || REDUCED) return;
    const go = () => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
    if (delay) setTimeout(go, delay); else go();
  }

  // ── 설명 말풍선 ─────────────────────────────────────────────────────────
  let bubble = null, tipTimer = null;
  function showTip(el) {
    const text = el.getAttribute('data-tip') || el.getAttribute('data-say');
    if (!text || !document.body.contains(el)) return;
    const [title, desc] = text.split('|');
    bubble.textContent = title;
    if (desc) { const sm = document.createElement('small'); sm.textContent = desc; bubble.appendChild(sm); }
    bubble.classList.add('on');
    const r = el.getBoundingClientRect(), bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    let top = r.bottom + 8;
    if (top + bh > innerHeight - 8) top = r.top - bh - 8;
    bubble.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - bw / 2, innerWidth - bw - 8))}px`;
    bubble.style.top = `${Math.max(8, top)}px`;
  }
  function hideTip() { clearTimeout(tipTimer); if (bubble) bubble.classList.remove('on'); }
  const tipTarget = (t) => t && t.closest && t.closest('[data-tip], .mwrap[data-say]');

  // ── 눈동자 따라보기 · 깜빡임 ────────────────────────────────────────────
  let gazeQueued = false;
  const mouse = { x: 0, y: 0 };
  function gaze() {
    gazeQueued = false;
    for (const svg of $$('.mwrap .mascot')) {
      const r = svg.getBoundingClientRect();
      if (!r.width) continue;
      const dx = mouse.x - (r.left + r.width / 2), dy = mouse.y - (r.top + r.height * 0.27);
      const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 300);
      svg.querySelector('.m-eyes').style.transform = `translate(${(dx / d * 5 * k).toFixed(1)}px,${(dy / d * 3.5 * k).toFixed(1)}px)`;
    }
  }
  function blinkLater() {
    setTimeout(() => {
      for (const e of $$('.mwrap .m-eyes')) { e.classList.add('blink'); setTimeout(() => e.classList.remove('blink'), 200); }
      blinkLater();
    }, 6000 + Math.random() * 4000);
  }

  // ── 첫 방문 안내(3단계) ──────────────────────────────────────────────────
  const TOUR = [
    { sel: '#sidePalette', panel: 'menu', title: '① 단계를 고르세요', text: '계산 유형 9종이 계산·조회·흐름 제어로 묶여 있어요. 누르면 캔버스에 새 단계가 생깁니다.', side: 'right' },
    { sel: '.canvas-scroll', title: '② 도형을 이어 전략을 그려요', text: '도형 가장자리를 끌어 다른 도형에 놓으면 연결돼요. 도형을 누르면 아래에서 설정 창이 올라옵니다.', side: 'center' },
    { sel: '.results-inner', panel: 'results', title: '③ 바로 시뮬레이션해요', text: '테스트 입력값을 바꾸면 계산이 지나간 경로가 빛나고 최종한도가 즉시 바뀌어요.', side: 'left' },
  ];
  let hole = null, card = null, step = 0;
  function startTour() {
    endTour(false);
    if (root.App && root.App.showTab) root.App.showTab('process');
    step = 0;
    hole = document.createElement('div'); hole.className = 'tour-hole';
    card = document.createElement('div'); card.className = 'tour-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', '처음 안내');
    document.body.append(hole, card);
    showStep();
  }
  function showStep() {
    const s = TOUR[step];
    const opened = s.panel && root.App && root.App.setPanel ? root.App.setPanel(s.panel, true) : false;
    setTimeout(() => {
      if (!card) return;
      const target = document.querySelector(s.sel);
      if (!target) { endTour(true); return; }
      const r = target.getBoundingClientRect(), pad = 4;
      Object.assign(hole.style, { left: `${r.left + pad}px`, top: `${r.top + pad}px`, width: `${r.width - pad * 2}px`, height: `${r.height - pad * 2}px` });
      card.innerHTML = '';
      const h4 = document.createElement('h4'); h4.textContent = s.title;
      const p = document.createElement('p'); p.textContent = s.text;
      const foot = document.createElement('div'); foot.className = 'tour-foot';
      const dots = document.createElement('span'); dots.className = 'tour-dots';
      TOUR.forEach((_, i) => { const d = document.createElement('i'); if (i === step) d.className = 'on'; dots.appendChild(d); });
      const skip = document.createElement('button'); skip.type = 'button'; skip.className = 'btn btn-small'; skip.textContent = '닫기';
      const next = document.createElement('button'); next.type = 'button'; next.className = 'btn btn-small btn-primary';
      next.textContent = step === TOUR.length - 1 ? '시작하기' : '다음';
      skip.onclick = () => endTour(true);
      next.onclick = () => { if (step < TOUR.length - 1) { step++; showStep(); } else endTour(true); };
      foot.append(dots, skip, next);
      card.append(h4, p, foot);
      const cw = card.offsetWidth, ch = card.offsetHeight;
      let left, top;
      if (s.side === 'right') { left = r.right + 14; top = r.top + 40; }
      else if (s.side === 'left') { left = r.left - cw - 14; top = r.top + 40; }
      else { left = r.left + r.width / 2 - cw / 2; top = r.top + r.height / 2 - ch / 2; }
      card.style.left = `${Math.max(12, Math.min(left, innerWidth - cw - 12))}px`;
      card.style.top = `${Math.max(12, Math.min(top, innerHeight - ch - 12))}px`;
      next.focus();
    }, opened ? 360 : 0);
  }
  function endTour(remember) {
    if (hole) { hole.remove(); card.remove(); hole = card = null; }
    if (remember) { try { localStorage.setItem(TOUR_KEY, '1'); } catch (e) { /* 저장 못 하면 다음에 다시 뜬다 */ } }
  }
  function tourSeen() { try { return !!localStorage.getItem(TOUR_KEY); } catch (e) { return true; } }

  // ── 시작 ────────────────────────────────────────────────────────────────
  function init() {
    paint(document);
    bubble = document.createElement('div');
    bubble.className = 'tip-bubble';
    bubble.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bubble);
    document.addEventListener('mouseover', (ev) => {
      const el = tipTarget(ev.target);
      if (!el) return;
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => showTip(el), el.classList.contains('mwrap') ? 0 : 350);
    });
    document.addEventListener('mouseout', (ev) => { const el = tipTarget(ev.target); if (el && !el.contains(ev.relatedTarget)) hideTip(); });
    document.addEventListener('focusin', (ev) => { const el = tipTarget(ev.target); if (el && el.matches(':focus-visible')) showTip(el); });
    document.addEventListener('focusout', hideTip);
    document.addEventListener('pointerdown', hideTip);
    document.addEventListener('scroll', hideTip, true);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && hole) endTour(true); });
    if (!REDUCED) {
      document.addEventListener('mousemove', (ev) => {
        mouse.x = ev.clientX; mouse.y = ev.clientY;
        if (!gazeQueued) { gazeQueued = true; requestAnimationFrame(gaze); }
      });
      blinkLater();
    }
    // 로그인해 작업 화면이 열리면 첫 방문 안내(프로세스 화면에서만)
    new MutationObserver(() => {
      if (document.body.classList.contains('auth-in') && !tourSeen() && !hole) {
        setTimeout(() => {
          const proc = document.getElementById('tab-process');
          if (document.body.classList.contains('auth-in') && proc && !proc.hidden && !hole && !tourSeen()) startTour();
        }, 900);
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  root.Fx = { REDUCED, mascot, paint, mood, say, face, countTo, replay, startTour };
  document.addEventListener('DOMContentLoaded', init);
})(typeof self !== 'undefined' ? self : this);
