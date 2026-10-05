/* ============================================================================
   로그인 · 서버 저장(팀) — Supabase
   ----------------------------------------------------------------------------
   · 첫 화면은 로그인 화면이다. 로그인해야 작업 화면이 열린다(로그인 없이 쓰기 없음)
   · 왼쪽 메뉴: 전략 목록 / 서버에 저장 / 서버에 다른 이름으로 저장(새 버전 또는 새 전략), 맨 아래 사용자(누르면 로그아웃)
   · 표 public.limitsim_strategies (web/supabase/001_limitsim_strategies.sql) — 행 하나 = 전략의 한 버전
   · 권한은 서버(RLS)가 지킨다: 읽기 = 로그인한 팀 전체, 쓰기·삭제 = 작성자 본인. 화면은 안내만 한다
   · 계정은 관리자가 발급한다(새 가입 꺼짐). 가상 데이터는 서버에 올리지 않고 전략만 저장한다
   · 아래 주소·키는 공개용(publishable) 키다 — 브라우저에 두도록 만들어진 값이며 권한은 RLS가 막는다
   ========================================================================== */
(function (root) {
  'use strict';
  const S = root.Store, { h, clear, modal } = root.UI;
  const $ = (sel) => document.querySelector(sel);

  const URL_ = 'https://bkajzgdmaaggzkiixxil.supabase.co';
  const KEY = 'sb_publishable_UdzGDsJTwJySJKUjYqi81w_h9Szhzrt';
  const TABLE = 'limitsim_strategies';
  const LIST_COLS = 'id,lineage_id,version,name,note,owner_id,owner_email,copied_from,created_at,updated_at';

  let client = null, user = null, guard = null;

  function mount(guardFn) {
    guard = guardFn;
    bindLogin();
    if (!root.supabase || !root.supabase.createClient) {
      setAuth(false);
      $('#loginError').textContent = '서버 연결 모듈을 불러오지 못했습니다 — 페이지를 새로고침하세요';
      $('#loginSubmit').disabled = true;
      return;
    }
    // 로그인은 이 탭에서만 유지한다(sessionStorage) — 새 탭·새 창·브라우저를 다시 열면 항상 로그인 화면부터.
    // 같은 탭 새로고침은 로그인 유지. 예전 방식(localStorage)에 남은 로그인 정보는 지운다
    try { localStorage.removeItem('limitsim.auth'); } catch (e) { /* 지우지 못해도 동작에는 지장 없음 */ }
    client = root.supabase.createClient(URL_, KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'limitsim.auth', storage: root.sessionStorage } });
    client.auth.getSession().then(({ data }) => { user = data.session ? data.session.user : null; setAuth(!!user); });
    client.auth.onAuthStateChange((_e, session) => { user = session ? session.user : null; setAuth(!!user); });
    $('#menuList').addEventListener('click', openList);
    $('#strategyTitle').addEventListener('click', openList);
    $('#menuSave').addEventListener('click', () => save());
    $('#menuSaveAs').addEventListener('click', () => saveAs());
    S.subscribe((reason) => { if (['cloud-saved', 'load', 'new', 'example', 'import'].includes(reason)) renderMenu(); });
  }

  // 로그인 여부에 따라 로그인 화면 / 작업 화면을 바꾼다
  function setAuth(on) {
    document.body.classList.remove('auth-pending');
    document.body.classList.toggle('auth-in', on);
    document.body.classList.toggle('auth-out', !on);
    renderUser();
    renderMenu();
    renderBadge($('#cloudState'));
    if (!on) setTimeout(() => $('#loginEmail').focus(), 0);
  }

  const mine = (c) => !!(c && user && c.owner_id === user.id);
  const canSave = () => !!user && (!S.state.cloud || mine(S.state.cloud));
  // 서버 보관 30일(003_limitsim_retention.sql) — 마지막 수정 후 30일이 지나면 매일 03:00에 지워진다
  const KEEP_DAYS = 30;
  const daysLeft = (t) => Math.max(0, Math.ceil((+new Date(t) + KEEP_DAYS * 864e5 - Date.now()) / 864e5));
  const when = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const who = (email) => String(email || '').split('@')[0] || '(알 수 없음)';

  // 서버 오류를 한국어로
  function msg(err) {
    const m = String((err && (err.message || err.error_description)) || err || '');
    if (/invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 맞지 않습니다';
    if (/email not confirmed/i.test(m)) return '확인되지 않은 계정입니다 — 관리자에게 "Auto Confirm"을 요청하세요';
    if (/failed to fetch|network|load failed/i.test(m)) return '서버에 연결하지 못했습니다 — 네트워크·회사망 접속을 확인하세요';
    if (err && err.code === '23505') return '같은 버전이 방금 저장되었습니다 — 목록을 새로 열어 확인하세요';
    if (err && err.code === '42501') return '권한이 없습니다(작성자만 고칠 수 있습니다)';
    if (/jwt|token/i.test(m)) return '로그인이 만료되었습니다 — 다시 로그인하세요';
    return m || '알 수 없는 오류';
  }
  const flash = (t, k) => root.App.flash(t, k);

  // ── 로그인 화면 ─────────────────────────────────────────────────────────
  function bindLogin() {
    const form = $('#loginForm');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!client) return;
      const err = $('#loginError'), go = $('#loginSubmit');
      err.textContent = '';
      go.disabled = true;
      go.textContent = '확인 중…';
      const { error } = await client.auth.signInWithPassword({ email: $('#loginEmail').value.trim(), password: $('#loginPassword').value });
      go.disabled = false;
      go.textContent = '로그인';
      if (error) { err.textContent = msg(error); return; }
      $('#loginPassword').value = '';
    });
  }

  async function logout() {
    await client.auth.signOut();
    // 작업 중이던 전략은 브라우저 임시저장에 남는다 — 다시 로그인하면 이어서 본다
  }

  // ── 메뉴 맨 아래 사용자 ─────────────────────────────────────────────────
  function renderUser() {
    const box = $('#userBox');
    if (!box) return;
    clear(box);
    if (!user) return;
    const name = who(user.email);
    const pop = h('div', { class: 'user-pop', hidden: true },
      h('div', { class: 'muted small' }, user.email),
      h('button', { class: 'menu-btn', type: 'button', onclick: logout }, '로그아웃'));
    const me = h('button', { class: 'user-me', type: 'button', 'aria-expanded': 'false', title: user.email },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, name.slice(0, 1).toUpperCase()),
      h('span', { class: 'user-name' }, name), h('span', { class: 'muted' }, '⌃'));
    me.addEventListener('click', () => { pop.hidden = !pop.hidden; me.setAttribute('aria-expanded', String(!pop.hidden)); });
    box.append(pop, me);
    // 밖을 누르면 접는다 — 한 번만 건다(다시 그릴 때마다 늘지 않게)
    if (!box.dataset.outside) {
      box.dataset.outside = '1';
      document.addEventListener('pointerdown', (ev) => {
        if (box.contains(ev.target)) return;
        const p = box.querySelector('.user-pop'), b = box.querySelector('.user-me');
        if (p) p.hidden = true;
        if (b) b.setAttribute('aria-expanded', 'false');
      });
    }
  }

  // 메뉴 "서버에 저장"에 지금 무엇을 하게 될지 적어 둔다
  function renderMenu() {
    const b = $('#menuSave');
    if (!b) return;
    const c = S.state.cloud;
    b.textContent = c && mine(c) ? `서버에 저장 (v${c.version} 덮어쓰기)` : '서버에 저장';
    b.title = c && !mine(c) ? '팀원 전략은 덮어쓸 수 없어 내 새 전략으로 저장합니다' : c ? '' : '서버에 처음 저장합니다 — 이름을 정합니다';
  }

  // 상단 막대: 지금 전략이 서버의 어느 버전인지
  function renderBadge(el) {
    if (!el) return;
    const c = S.state.cloud;
    if (!c) {
      el.textContent = '서버 미저장';
      el.className = 'title-status';
      el.title = '서버에 저장되지 않은 전략입니다 — 메뉴의 "서버에 저장"으로 올리세요';
    } else if (mine(c)) {
      el.textContent = `서버 v${c.version}`;
      el.className = 'title-status';
      el.title = `서버에 저장된 "${c.name}" v${c.version}${c.note ? ` — ${c.note}` : ''}`;
    } else {
      el.textContent = `팀 전략 · ${who(c.owner_email)} v${c.version} (열람)`;
      el.className = 'title-status warn';
      el.title = '팀원 전략은 열람·테스트만 됩니다. 고치려면 "서버에 다른 이름으로 저장"이나 목록의 "내 전략으로 복사"를 쓰세요';
    }
  }

  // ── 저장 ────────────────────────────────────────────────────────────────
  const info = (row) => ({ id: row.id, lineage_id: row.lineage_id, version: row.version, owner_id: row.owner_id, owner_email: row.owner_email, name: row.name, note: row.note });

  async function insertVersion(lineage, version, name, note, copiedFrom) {
    const id = root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : undefined;
    const content = S.clone(S.strategy);
    content.meta.name = name;
    const row = { lineage_id: lineage || id, version, name, note: note || '', content, copied_from: copiedFrom || null };
    if (id) row.id = id;
    const { data, error } = await client.from(TABLE).insert(row).select(LIST_COLS).single();
    if (error) throw error;
    return data;
  }

  // 서버에 저장: 열린 내 전략이면 그 버전을 덮어쓰고, 아니면(서버에 없음·팀원 전략) 다른 이름으로 저장 창을 연다.
  // 저장했으면 true(새로 만들기·열기 전 확인에서 "저장한 뒤 계속"이 기다린다)
  async function save() {
    if (!user) return false;
    const c = S.state.cloud;
    if (!c || !mine(c)) return saveAs();
    try {
      const { data, error } = await client.from(TABLE).update({ name: c.name, content: S.clone(S.strategy) }).eq('id', c.id).select(LIST_COLS);
      if (error) throw error;
      const row = data && data[0];
      if (!row) { S.unlinkCloud(); flash('서버의 이 버전이 삭제되었습니다 — 다른 이름으로 저장하세요', 'danger'); return saveAs(); }
      S.markCloudSaved(info(row));
      flash(`서버에 저장했습니다 — "${row.name}" v${row.version} (서버 보관 ${KEEP_DAYS}일)`, 'ok');
      return true;
    } catch (e) { flash(`서버 저장 실패: ${msg(e)}`, 'danger'); return false; }
  }

  // 서버에 다른 이름으로 저장: ① 같은 전략의 새 버전(열린 전략이 내 것일 때) ② 새 전략(이름을 정함)
  function saveAs() {
    return new Promise((resolve) => {
      if (!user) { resolve(false); return; }
      const c = S.state.cloud;
      const canVersion = !!(c && mine(c));
      const team = !!(c && !mine(c));
      let done = false;
      const pick = (v) => h('input', { type: 'radio', name: 'saveas', value: v });
      const rVer = pick('version'), rNew = pick('new');
      const note = h('input', { type: 'text', class: 'login-input', placeholder: '메모 (예: 직업군 한도 상향안)', maxlength: '120', 'aria-label': '메모' });
      const name = h('input', { type: 'text', class: 'login-input', maxlength: '80', 'aria-label': '새 전략 이름',
        value: team ? `${S.strategy.meta.name} (복사)` : canVersion ? `${S.strategy.meta.name} (2)` : S.strategy.meta.name });
      const err = h('div', { class: 'field-error' });
      const go = h('button', { class: 'btn btn-primary', type: 'submit' }, '저장');
      const sync = () => { name.disabled = !rNew.checked; go.textContent = rNew.checked ? '새 전략으로 저장' : '새 버전으로 저장'; };
      (canVersion ? rVer : rNew).checked = true;
      rVer.addEventListener('change', sync); rNew.addEventListener('change', sync);
      const form = h('form', { class: 'login-form saveas-form' },
        team ? h('div', { class: 'hint' }, `팀원(${who(c.owner_email)})의 전략은 덮어쓸 수 없어 내 새 전략으로 저장합니다. 복사 원본이 기록됩니다.`) : null,
        canVersion ? h('label', { class: 'saveas-opt' }, rVer, h('span', {}, h('strong', {}, `같은 전략의 새 버전 (v${c.version + 1}~)`), h('span', { class: 'muted small' }, ` — "${c.name}" 묶음에 버전을 더합니다. 지금 v${c.version}은 그대로 남습니다`))) : null,
        h('label', { class: 'saveas-opt' }, rNew, h('span', {}, h('strong', {}, '새 전략으로'), h('span', { class: 'muted small' }, ' — 목록에 별개의 전략으로 생깁니다'))),
        h('div', { class: 'saveas-field' }, h('span', { class: 'muted small' }, '이름'), name),
        h('div', { class: 'saveas-field' }, h('span', { class: 'muted small' }, '메모'), note),
        h('div', { class: 'hint' }, `서버는 작업 공간입니다 — 마지막 수정 후 ${KEEP_DAYS}일이 지나면 자동 삭제됩니다. 보관은 "로컬 PC에 저장(내보내기)"으로 하세요.`),
        err, go);
      sync();
      const m = modal('서버에 다른 이름으로 저장', form, false, () => { if (!done) resolve(false); });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        err.textContent = '';
        const asNew = rNew.checked;
        const nm = asNew ? name.value.trim() : c.name;
        if (!nm) { err.textContent = '이름을 입력하세요'; return; }
        go.disabled = true;
        try {
          let row;
          if (asNew) row = await insertVersion(null, 1, nm, note.value.trim(), team ? c.id : null);
          else {
            const { data, error } = await client.from(TABLE).select('version').eq('lineage_id', c.lineage_id).order('version', { ascending: false }).limit(1);
            if (error) throw error;
            row = await insertVersion(c.lineage_id, (data && data[0] ? data[0].version : c.version) + 1, nm, note.value.trim(), null);
          }
          if (S.strategy.meta.name !== row.name) S.update(s => { s.meta.name = row.name; }, 'meta', true);
          S.markCloudSaved(info(row));
          done = true;
          m.close();
          flash(asNew ? `서버에 새 전략으로 저장했습니다 — "${row.name}" v1` : `서버에 새 버전을 저장했습니다 — "${row.name}" v${row.version}`, 'ok');
          resolve(true);
        } catch (e) { err.textContent = msg(e); go.disabled = false; }
      });
      (rNew.checked ? name : note).focus();
    });
  }

  // ── 목록 ────────────────────────────────────────────────────────────────
  async function openList() {
    if (!user) return;
    const body = h('div', { class: 'cloud-list' }, h('div', { class: 'muted' }, '불러오는 중…'));
    const m = modal('전략 목록', body, true);
    let rows;
    try {
      const { data, error } = await client.from(TABLE).select(LIST_COLS).order('updated_at', { ascending: false });
      if (error) throw error;
      rows = data;
    } catch (e) { clear(body).appendChild(h('div', { class: 'err' }, msg(e))); return; }
    let tab = 'mine';
    const draw = () => {
      clear(body);
      const my = rows.filter(r => r.owner_id === user.id), team = rows.filter(r => r.owner_id !== user.id);
      body.appendChild(h('div', { class: 'tabs cloud-tabs' },
        h('button', { class: `tab${tab === 'mine' ? ' active' : ''}`, type: 'button', onclick: () => { tab = 'mine'; draw(); } }, `내 전략 ${groups(my).length}`),
        h('button', { class: `tab${tab === 'team' ? ' active' : ''}`, type: 'button', onclick: () => { tab = 'team'; draw(); } }, `팀 전략 ${groups(team).length}`)));
      const list = groups(tab === 'mine' ? my : team);
      if (!list.length) {
        body.appendChild(h('div', { class: 'empty' }, tab === 'mine' ? '서버에 저장한 전략이 없습니다. 왼쪽 메뉴 "서버에 저장"으로 지금 전략을 올리세요.' : '팀원이 저장한 전략이 없습니다.'));
        return;
      }
      for (const g of list) body.appendChild(groupEl(g, tab === 'mine', m));
    };
    draw();
  }

  // 같은 lineage를 묶고 최신 버전을 앞에. 묶음은 최근 수정 순
  function groups(rows) {
    const m = new Map();
    for (const r of rows) { if (!m.has(r.lineage_id)) m.set(r.lineage_id, []); m.get(r.lineage_id).push(r); }
    return [...m.values()].map(vs => vs.sort((a, b) => b.version - a.version))
      .sort((a, b) => new Date(Math.max(...b.map(x => +new Date(x.updated_at)))) - new Date(Math.max(...a.map(x => +new Date(x.updated_at)))));
  }

  function groupEl(versions, own, m) {
    const latest = versions[0];
    const cur = S.state.cloud;
    const wrap = h('div', { class: 'cloud-group' });
    const verList = h('div', { class: 'cloud-versions', hidden: true });
    const row = (r, isHead) => {
      const del = h('button', { class: 'btn btn-small btn-ghost-danger', type: 'button' }, '삭제');
      let armed = false;
      del.addEventListener('click', async () => {
        // 두 번째 누름에서 삭제. 빨간 글자(ghost) 대신 빨간 바탕·흰 글자로 바꿔 글자가 묻히지 않게 한다
        if (!armed) { armed = true; del.textContent = `v${r.version} 정말 삭제`; del.classList.replace('btn-ghost-danger', 'btn-danger'); return; }
        const { error } = await client.from(TABLE).delete().eq('id', r.id);
        if (error) { flash(`삭제 실패: ${msg(error)}`, 'danger'); return; }
        if (cur && cur.id === r.id) S.unlinkCloud();
        flash(`"${r.name}" v${r.version}을(를) 서버에서 삭제했습니다`, 'info');
        m.close(); openList();
      });
      return h('div', { class: `cloud-row${isHead ? ' head' : ''}${cur && cur.id === r.id ? ' current' : ''}` },
        h('div', { class: 'cloud-main' },
          isHead ? h('strong', {}, r.name) : null,
          h('span', { class: 'badge badge-neutral' }, `v${r.version}`),
          h('span', { class: 'muted small' }, when(r.updated_at)),
          h('span', { class: `badge ${daysLeft(r.updated_at) <= 3 ? 'badge-danger' : 'badge-neutral'}`, title: '서버 보관은 마지막 수정 후 30일입니다. 보관하려면 "로컬 PC에 저장"으로 내려받으세요' }, `${daysLeft(r.updated_at)}일 후 삭제`),
          own ? null : h('span', { class: 'muted small' }, `작성 ${who(r.owner_email)}`),
          r.copied_from ? h('span', { class: 'muted small' }, '복사본') : null,
          r.note ? h('span', { class: 'cloud-note-text' }, r.note) : null,
          cur && cur.id === r.id ? h('span', { class: 'badge badge-ok' }, '지금 열림') : null),
        h('div', { class: 'row-actions inline' },
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => openRow(r, m) }, own ? '열기' : '열람'),
          own ? null : h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => copyToMine(r, m) }, '내 전략으로 복사'),
          own ? del : null));
    };
    wrap.appendChild(row(latest, true));
    if (versions.length > 1) {
      const t = h('button', { class: 'btn-link', type: 'button' }, `이전 버전 ${versions.length - 1}개 보기`);
      t.addEventListener('click', () => { verList.hidden = !verList.hidden; t.textContent = verList.hidden ? `이전 버전 ${versions.length - 1}개 보기` : '이전 버전 접기'; });
      wrap.appendChild(t);
      for (const r of versions.slice(1)) verList.appendChild(row(r, false));
      wrap.appendChild(verList);
    }
    return wrap;
  }

  async function fetchRow(id) {
    const { data, error } = await client.from(TABLE).select('*').eq('id', id).single();
    if (error) throw error;
    return data;
  }

  function openRow(r, m) {
    guard(async () => {
      try {
        const row = await fetchRow(r.id);
        const s = row.content;
        s.meta = Object.assign({}, s.meta, { name: row.name });
        S.load(s, 'load', new Date(), info(row));
        m.close();
        flash(mine(row) ? `"${row.name}" v${row.version}을(를) 열었습니다` : `팀 전략 "${row.name}" v${row.version}(작성 ${who(row.owner_email)})을(를) 열람합니다 — 고치려면 "내 전략으로 복사"`, 'info');
      } catch (e) { flash(`열기 실패: ${msg(e)}`, 'danger'); }
    }, '서버 전략 열기');
  }

  function copyToMine(r, m) {
    guard(async () => {
      try {
        const row = await fetchRow(r.id);
        const s = row.content;
        s.meta = Object.assign({}, s.meta, { name: `${row.name} (복사)`, updated: new Date().toISOString() });
        S.load(s, 'load', new Date(), null);
        const saved = await insertVersion(null, 1, s.meta.name, `${who(row.owner_email)}의 "${row.name}" v${row.version}에서 복사`, row.id);
        S.markCloudSaved(info(saved));
        m.close();
        flash(`내 전략으로 복사했습니다 — "${saved.name}" v1`, 'ok');
      } catch (e) { flash(`복사 실패: ${msg(e)}`, 'danger'); }
    }, '내 전략으로 복사');
  }

  // 서버 전략 하나를 골라 돌려준다(전략 비교의 기준 A). 지금 열린 전략은 바꾸지 않는다.
  // 결과: {strategy, label} 또는 닫으면 null
  function pickStrategy(title) {
    return new Promise(async (resolve) => {
      if (!user) { resolve(null); return; }
      let done = false;
      const body = h('div', { class: 'cloud-list' }, h('div', { class: 'muted' }, '불러오는 중…'));
      const m = modal(title || '서버 전략 고르기', body, true, () => { if (!done) resolve(null); });
      let rows;
      try {
        const { data, error } = await client.from(TABLE).select(LIST_COLS).order('updated_at', { ascending: false });
        if (error) throw error;
        rows = data;
      } catch (e) { clear(body).appendChild(h('div', { class: 'err' }, msg(e))); return; }
      const choose = async (r) => {
        try {
          const row = await fetchRow(r.id);
          const s = row.content;
          s.meta = Object.assign({}, s.meta, { name: row.name });
          done = true;
          m.close();
          resolve({ strategy: s, label: `${row.name} v${row.version}${mine(row) ? '' : ` (${who(row.owner_email)})`} · 서버` });
        } catch (e) { flash(`불러오기 실패: ${msg(e)}`, 'danger'); }
      };
      let tab = 'mine';
      const draw = () => {
        clear(body);
        const my = rows.filter(r => r.owner_id === user.id), team = rows.filter(r => r.owner_id !== user.id);
        body.appendChild(h('div', { class: 'tabs cloud-tabs' },
          h('button', { class: `tab${tab === 'mine' ? ' active' : ''}`, type: 'button', onclick: () => { tab = 'mine'; draw(); } }, `내 전략 ${groups(my).length}`),
          h('button', { class: `tab${tab === 'team' ? ' active' : ''}`, type: 'button', onclick: () => { tab = 'team'; draw(); } }, `팀 전략 ${groups(team).length}`)));
        const list = groups(tab === 'mine' ? my : team);
        if (!list.length) { body.appendChild(h('div', { class: 'empty' }, '서버에 저장된 전략이 없습니다.')); return; }
        for (const vs of list) {
          body.appendChild(h('div', { class: 'cloud-group' },
            h('div', { class: 'cloud-row head' }, h('div', { class: 'cloud-main' }, h('strong', {}, vs[0].name),
              tab === 'team' ? h('span', { class: 'muted small' }, `작성 ${who(vs[0].owner_email)}`) : null)),
            vs.map(r => h('div', { class: 'cloud-row pick-row' },
              h('div', { class: 'cloud-main' }, h('span', { class: 'badge badge-neutral' }, `v${r.version}`), h('span', { class: 'muted small' }, when(r.updated_at)),
                r.note ? h('span', { class: 'cloud-note-text' }, r.note) : null),
              h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => choose(r) }, '이 버전 선택')))));
        }
      };
      draw();
    });
  }

  root.Cloud = { mount, renderBadge, canSave, save, saveAs, pickStrategy, get user() { return user; } };
})(typeof self !== 'undefined' ? self : this);
