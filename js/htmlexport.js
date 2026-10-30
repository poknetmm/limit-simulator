/* ============================================================================
   HTML 내보내기 공통 틀 — 열린 전략을 담은 단독 HTML 파일(간이 한도 산출기 · 대량 분석기)을 만든다
   ----------------------------------------------------------------------------
   화면과 무관한 순수 생성부. 브라우저(window.HtmlExport)와 Node(require) 양쪽에서 같은 코드를 쓴다.
   파일 안에는 스튜디오와 같은 계산 엔진(engine.js)을 그대로 넣는다 — 엔진 사본을 따로 두지 않으므로 결과가 갈라지지 않는다.
   만든 파일은 네트워크를 쓰지 않는다: 외부 주소·글꼴이 없고 CSP 메타가 연결을 막으며,
   실행 스크립트는 생성 때 계산한 해시와 같은 블록만 실행된다. 저장소(쿠키·localStorage 등)도 쓰지 않는다.

   build(kind, strategy, parts, opt) → Promise<HTML 글>
     kind  : 'calc'(간이 한도 산출기) | 'analyzer'(대량 분석기)
     parts : { 부품 이름: 글 } — partFiles(kind)가 알려 주는 파일을 읽어 넣는다(loadParts)
     opt   : date(내려받은 시각, 기본 지금) · serverVer(서버 버전, 없으면 생략)
   해시 계산이 비동기(crypto.subtle)라 build도 Promise를 돌려준다.
   ========================================================================== */
(function (root, factory) {
  const X = factory(root, root && root.LimitEngine ? root.LimitEngine : require('./engine.js'));
  if (typeof module === 'object' && module.exports) module.exports = X;
  else root.HtmlExport = X;
})(typeof self !== 'undefined' ? self : this, function (root, E) {
  'use strict';

  const GLOBAL = typeof globalThis !== 'undefined' ? globalThis : root;

  class HtmlExportError extends Error {}

  // 종류마다: 화면 이름 · 파일 이름 앞부분 · 형식 버전 · 부품 파일(상대 경로) · 파일 안 실행 스크립트 순서
  //   scripts의 'shim'은 describe.js가 읽는 Store 대용(window.Store = {strategy})이다
  const KINDS = {
    calc: {
      title: '간이 한도 산출기', file: '한도산출기', ver: 'v1',
      files: { engine: 'js/engine.js', describe: 'js/describe.js', screen: 'js/standalone-calc.js', tokens: 'css/tokens.css', standalone: 'css/standalone.css' },
      scripts: ['engine', 'shim', 'describe', 'screen'],
    },
    analyzer: {
      title: '대량 분석기', file: '대량분석기', ver: 'v1',
      files: {
        engine: 'js/engine.js', describe: 'js/describe.js', sheetjs: 'lib/xlsx.full.min.js', sheetjsLicense: 'lib/LICENSE-sheetjs.txt',
        analysis: 'js/analysis.js', screen: 'js/standalone-analyzer.js', tokens: 'css/tokens.css', standalone: 'css/standalone.css',
      },
      scripts: ['engine', 'describe', 'sheetjs', 'analysis', 'screen'],
    },
  };

  const kindOf = (kind) => {
    if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) throw new HtmlExportError(`알 수 없는 종류입니다: ${kind}`);
    return KINDS[kind];
  };

  // 읽어 와야 할 부품 {이름: 상대 경로}
  const partFiles = (kind) => Object.assign({}, kindOf(kind).files);

  // read(상대 경로) → 글(또는 Promise). 브라우저는 같은 사이트 GET, Node는 디스크 읽기를 넘긴다
  async function loadParts(kind, read) {
    const out = {};
    await Promise.all(Object.entries(partFiles(kind)).map(async ([key, path]) => { out[key] = await read(path); }));
    return out;
  }

  // ── 글 다듬기 ───────────────────────────────────────────────────────────
  // 부품 글은 줄 끝을 LF로 통일하고 맨 앞 BOM을 뗀다 — 읽은 경로(브라우저·Node)와 운영체제가 달라도 해시와 파일이 같게
  const norm = (t) => String(t).replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  // CSS 설명문(/* … */)은 뺀다 — 공용 디자인 토큰 설명에 내부 메모가 있다. 스타일 값은 그대로. 게시본 만들기(tools/build-publish.js)도 이 함수를 쓴다
  const stripCssComments = (css) => String(css).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n{3,}/g, '\n\n');

  const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // 한 줄 글(제목·머리 주석)로: 줄바꿈·제어 문자를 공백으로
  const oneLine = (t) => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  // 주석 안의 --는 다른 글자로 바꾼다(주석이 닫히지 않게)
  const commentSafe = (t) => esc(oneLine(t)).replace(/-{2,}/g, (m) => '‐'.repeat(m.length));

  const pad = (n) => String(n).padStart(2, '0');
  const timeText = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const stampText = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

  // 파일 이름: 한도산출기_{전략이름}_{YYYYMMDD-HHmm}.html — 파일 이름에 못 쓰는 글자는 _
  function fileName(kind, strategy, date) {
    const K = kindOf(kind);
    const name = String(strategy && strategy.meta && strategy.meta.name || '전략').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim() || '전략';
    return `${K.file}_${name}_${stampText(date || new Date())}.html`;
  }

  // ── 부품 검사 ───────────────────────────────────────────────────────────
  // </script 가 들어 있거나 <!-- 와 <script 가 함께 든 부품은 파일 구조를 깨뜨릴 수 있어 만들지 않는다
  function checkScriptPart(key, text) {
    if (/\u0000/.test(text)) throw new HtmlExportError(`부품 "${key}"에 널 문자가 들어 있어 파일을 만들 수 없습니다`);
    if (/<\/script/i.test(text)) throw new HtmlExportError(`부품 "${key}"에 </script 가 들어 있어 파일을 만들 수 없습니다`);
    if (/<!--/.test(text) && /<script/i.test(text)) throw new HtmlExportError(`부품 "${key}"에 <!-- 와 <script 가 함께 들어 있어 파일을 만들 수 없습니다`);
  }
  function checkStylePart(key, text) {
    if (/<\/style/i.test(text)) throw new HtmlExportError(`부품 "${key}"에 </style 이 들어 있어 파일을 만들 수 없습니다`);
  }

  // ── 해시 ────────────────────────────────────────────────────────────────
  async function sha256Base64(text) {
    const bytes = new TextEncoder().encode(text);
    const subtle = GLOBAL.crypto && GLOBAL.crypto.subtle;
    if (subtle) {
      const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
      let bin = '';
      for (let i = 0; i < digest.length; i++) bin += String.fromCharCode(digest[i]);
      return GLOBAL.btoa(bin);
    }
    if (typeof require === 'function') return require('crypto').createHash('sha256').update(bytes).digest('base64');
    throw new HtmlExportError('이 브라우저에서는 파일을 만들 수 없습니다(보안 연결 주소에서 여세요)');
  }

  // 전략 JSON을 스크립트 데이터 블록에 넣는 글: <는 <로 바꿔 </script>·<!-- 가 만들어지지 않게
  const strategyJson = (s) => JSON.stringify(s).replace(/</g, '\\u003c');

  // 스크립트 블록 안쪽 글: 앞뒤 줄바꿈 하나씩(해시는 이 글 그대로 계산)
  const blockText = (label, text) => `\n/* ── ${label} ── */\n${text.replace(/\n+$/, '')}\n`;

  const SHIM = "window.Store = { strategy: JSON.parse(document.getElementById('strategy').textContent) };";

  async function build(kind, strategy, parts, opt) {
    const K = kindOf(kind);
    opt = opt || {};
    parts = parts || {};
    if (!strategy || !Array.isArray(strategy.variables) || !Array.isArray(strategy.nodes) || !Array.isArray(strategy.edges)) throw new HtmlExportError('전략 형식이 올바르지 않습니다');
    const issues = E.validate(strategy);
    if (issues.length) throw new HtmlExportError(`확인 필요 항목이 있어 파일을 만들 수 없습니다 — ${issues.slice(0, 3).join(' / ')}${issues.length > 3 ? ` 외 ${issues.length - 3}건` : ''}`);

    const P = {};
    for (const key of Object.keys(K.files)) {
      if (typeof parts[key] !== 'string' || !parts[key].trim()) throw new HtmlExportError(`부품이 없습니다: ${key}`);
      P[key] = norm(parts[key]);
    }
    for (const key of ['engine', 'describe', 'sheetjs', 'analysis', 'screen']) if (P[key] !== undefined) checkScriptPart(key, P[key]);
    for (const key of ['tokens', 'standalone']) checkStylePart(key, P[key]);
    if (P.sheetjsLicense !== undefined) checkScriptPart('sheetjsLicense', P.sheetjsLicense);

    const date = opt.date instanceof Date ? opt.date : new Date();
    const time = timeText(date);
    const name = oneLine(strategy.meta && strategy.meta.name) || '전략';
    const verText = opt.serverVer !== undefined && opt.serverVer !== null && String(opt.serverVer) !== '' ? ` (서버 v${oneLine(opt.serverVer)})` : '';

    // 실행 스크립트 블록(순서 고정)과 해시
    const blocks = [];
    for (const key of K.scripts) {
      if (key === 'shim') blocks.push(blockText('Store 대용', SHIM));
      else if (key === 'sheetjs') {
        const lic = P.sheetjsLicense.replace(/\*\//g, '* /');
        blocks.push(blockText('SheetJS', `/*\n${lic.replace(/\n+$/, '')}\n*/\n${P.sheetjs}`));
      } else blocks.push(blockText(KINDS[kind].files[key].split('/').pop(), P[key]));
    }
    const hashes = await Promise.all(blocks.map(sha256Base64));

    const csp = [
      "default-src 'none'",
      `script-src ${hashes.map(h => `'sha256-${h}'`).join(' ')}`,
      "style-src 'unsafe-inline'",
      'img-src data:',
      "font-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ].join('; ');

    const css = `\n${stripCssComments(P.tokens).trim()}\n${stripCssComments(P.standalone).trim()}\n`;
    const fixed = `이 파일은 ${time}의 전략으로 고정되어 있습니다. 스튜디오에서 전략을 고치면 다시 내려받으세요.`;

    return [
      '<!doctype html>',
      '<html lang="ko" translate="no" data-theme="light" data-brand="claude">',
      '<head>',
      '<meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">`,
      `<title>${esc(K.title)} · ${esc(name)}</title>`,
      `<!-- ${esc(K.title)} 형식 ${esc(K.ver)} | 전략: ${commentSafe(name)}${verText ? ` ${commentSafe(verText)}` : ''} | 내려받은 시각: ${esc(time)} | 계산 엔진을 파일 안에 담은 단독 파일입니다. 네트워크와 저장소를 쓰지 않습니다 -->`,
      `<style>${css}</style>`,
      '</head>',
      `<body data-kind="${esc(kind)}">`,
      '<header class="sa-head">',
      `<div class="sa-title"><span class="sa-kind">${esc(K.title)}</span><span class="sa-sep"> · </span><span class="sa-name" id="saName">${esc(name)}</span><span class="sa-ver" id="saVer">${esc(verText)}</span></div>`,
      `<div class="sa-meta">내려받은 시각 <span id="saTime">${esc(time)}</span> · 형식 ${esc(K.ver)}</div>`,
      `<div class="sa-fixed" id="saFixed">${esc(fixed)}</div>`,
      '<div class="sa-tools" id="saTools"></div>',
      '</header>',
      '<main id="app" class="sa-app"></main>',
      `<script type="application/json" id="strategy">${strategyJson(strategy)}</script>`,
      ...blocks.map(b => `<script>${b}</script>`),
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  return { KINDS, HtmlExportError, partFiles, loadParts, build, fileName, stripCssComments, norm, esc, timeText, stampText, sha256Base64 };
});
