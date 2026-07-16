// 콘텐츠 스크립트: 페이지 위에 선택 UI를 띄우고,
// 선택 영역(문서 좌표 기준 — 한 화면을 넘어도 됨)을 스크롤하며 나눠 캡처하도록
// 백그라운드에 단계별로 요청한다. 여러 번 주입돼도 한 번만 초기화된다.
(function () {
  if (window.__SCO_INJECTED__) return;
  window.__SCO_INJECTED__ = true;

  const Z = 2147483646; // 최상위 z-index
  const EDGE = 48;      // 드래그 중 자동 스크롤이 시작되는 가장자리 폭(px)
  let ui = null;        // 현재 떠 있는 선택 UI
  let confirmUi = null; // 선택 후 [실행] 확인 바 (선택 UI와 별개 — 새 선택 시작 시 반드시 정리)
  let capturing = false;

  // 캡처 도중 탭을 닫지 않고 다른 페이지로 이동/새로고침하면 background.js에 END/ABORT가
  // 전달되지 못해 job이 고아로 남을 수 있다. pagehide에서 최선노력(best-effort)으로
  // 중단을 알린다 — 응답을 기다릴 수 없으므로 콜백 없이 fire-and-forget으로 보낸다.
  window.addEventListener('pagehide', () => {
    if (!capturing) return;
    try { chrome.runtime.sendMessage({ type: 'SCO_CAP_ABORT' }); } catch (_) { /* 컨텍스트 무효화 등 무시 */ }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'SCO_START_SELECTION' || capturing) return;
    cancelSelection();
    if (msg.mode === 'element') startElementSelect();
    else if (msg.mode === 'paged') startPagedSelect();
    else if (msg.mode === 'text') startTextSelect();
    else startDragSelect();
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!res || !res.ok) reject(new Error(res && res.error ? res.error : 'no response'));
        else resolve(res);
      });
    });
  }

  function makeToast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    Object.assign(t.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(20,24,32,.92)', color: '#fff', padding: '8px 16px',
      borderRadius: '8px', font: '13px/1.4 "Malgun Gothic", sans-serif',
      zIndex: Z + 1, pointerEvents: 'none', boxShadow: '0 2px 12px rgba(0,0,0,.4)'
    });
    document.documentElement.appendChild(t);
    return t;
  }

  // 확인 바(선택 후 [실행]/[다시 선택]/[취소])를 한 곳에서 정리한다.
  // 이걸 두지 않으면 새 선택을 시작해도 이전 확인 바가 남아, Enter로 스테일 사각형이 캡처될 수 있다.
  function clearConfirmUi() {
    if (!confirmUi) return;
    confirmUi.outline.remove();
    confirmUi.bar.remove();
    document.removeEventListener('keydown', confirmUi.onKey, true);
    confirmUi = null;
  }

  function cancelSelection() {
    clearConfirmUi(); // 이전 확인 바가 남아 있으면 함께 정리
    if (!ui) return;
    ui.elements.forEach((el) => el.remove());
    document.removeEventListener('keydown', ui.onKey, true);
    ui.cleanup && ui.cleanup();
    ui = null;
  }

  function finishSelection(docRect, restartFn) {
    cancelSelection();
    if (docRect.w < 3 || docRect.h < 3) return;
    showCaptureConfirm(docRect, restartFn);
  }

  // 선택 영역을 표시한 채 [실행] 버튼을 띄운다 (곧바로 캡처하지 않음)
  function showCaptureConfirm(docRect, restartFn) {
    // 선택 윤곽선 (문서 좌표 기준으로 그려 스크롤해도 제자리 유지)
    const outline = document.createElement('div');
    Object.assign(outline.style, {
      position: 'absolute', left: docRect.x + 'px', top: docRect.y + 'px',
      width: docRect.w + 'px', height: docRect.h + 'px',
      border: '2px dashed #2f81f7', background: 'rgba(47,129,247,.12)',
      zIndex: Z, pointerEvents: 'none', boxSizing: 'border-box'
    });
    // 실행/다시선택/취소 바 (화면 하단 고정)
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)',
      display: 'flex', gap: '8px', alignItems: 'center', zIndex: Z + 2,
      background: 'rgba(20,24,32,.95)', padding: '10px 14px', borderRadius: '10px',
      boxShadow: '0 4px 20px rgba(0,0,0,.5)', font: '13px "Malgun Gothic", sans-serif'
    });
    const info = document.createElement('span');
    info.textContent = `선택 영역 ${Math.round(docRect.w)}×${Math.round(docRect.h)} — 캡처하시겠어요?`;
    info.style.cssText = 'color:#e8ecf3;margin-right:4px';
    const mk = (txt, primary) => {
      const b = document.createElement('button');
      b.textContent = txt;
      Object.assign(b.style, {
        padding: '8px 16px', border: 'none', borderRadius: '7px', cursor: 'pointer',
        font: '13px "Malgun Gothic", sans-serif', fontWeight: '700',
        background: primary ? '#2f81f7' : '#384357', color: '#fff'
      });
      return b;
    };
    const runB = mk('▶ 실행', true);
    const redoB = mk('↺ 다시 선택', false);
    const cancelB = mk('✖ 취소', false);
    bar.append(info, runB, redoB, cancelB);
    clearConfirmUi(); // 혹시 남아 있는 이전 확인 바 정리
    document.documentElement.appendChild(outline);
    document.documentElement.appendChild(bar);

    const cleanup = () => clearConfirmUi();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cleanup(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); cleanup(); captureDocRect(docRect); }
    };
    confirmUi = { outline, bar, onKey };
    document.addEventListener('keydown', onKey, true);

    runB.addEventListener('click', () => { cleanup(); captureDocRect(docRect); });
    redoB.addEventListener('click', () => { cleanup(); if (restartFn) restartFn(); });
    cancelB.addEventListener('click', cleanup);
  }

  // ---------- 스크롤 분할 캡처 (문서 좌표 rect 전체를 이어붙임) ----------
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  // 화면이 실제로 다시 그려질 때까지 확실히 기다린다 (토스트 숨김/스크롤 반영용)
  async function paintFlush() { await raf(); await raf(); await sleep(120); }

  function intersectRect(a, b) {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
    if (r - x < 3 || btm - y < 3) return null;
    return { x, y, w: r - x, h: btm - y };
  }

  // 뷰포트 기준 clip 영역의 60% 이상을 덮는 fixed/sticky 패널을 찾는다
  function findFixedPanel(clip) {
    let best = null, bestArea = 0;
    let scanned = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (++scanned > 15000) break;
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      const inter = intersectRect(clip, { x: r.left, y: r.top, w: r.width, h: r.height });
      if (!inter) continue;
      const area = inter.w * inter.h;
      if (area >= clip.w * clip.h * 0.6 && area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  // 패널 자신 또는 내부에서 실제로 스크롤되는 요소를 찾는다
  function findScrollerIn(panel) {
    const scrollable = (el) => {
      if (el.scrollHeight - el.clientHeight < 8) return false;
      const ov = getComputedStyle(el).overflowY;
      return ov === 'auto' || ov === 'scroll' || ov === 'overlay';
    };
    if (scrollable(panel)) return panel;
    let best = null, bestH = 0;
    let scanned = 0;
    for (const el of panel.querySelectorAll('*')) {
      if (++scanned > 3000) break;
      if (scrollable(el) && el.clientHeight > bestH) { best = el; bestH = el.clientHeight; }
    }
    return best;
  }

  async function captureDocRect(rect) {
    capturing = true;
    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth, vh = window.innerHeight;

    const toast = makeToast('캡처 준비 중…');
    const blocker = document.createElement('div'); // 캡처 중 클릭/입력 차단
    Object.assign(blocker.style, {
      position: 'fixed', inset: '0', zIndex: Z, cursor: 'wait', background: 'transparent'
    });
    document.documentElement.appendChild(blocker);

    // 선택 영역이 고정 패널(내부 스크롤 창) 위에 있으면 패널 내부를 스크롤하며 캡처
    const vpSel = { x: rect.x - window.scrollX, y: rect.y - window.scrollY, w: rect.w, h: rect.h };
    const vpClip = intersectRect(vpSel, { x: 0, y: 0, w: vw, h: vh });
    const panel = vpClip ? findFixedPanel(vpClip) : null;
    const scroller = panel ? findScrollerIn(panel) : null;

    try {
      if (scroller) await captureScrollerMode(vpClip, scroller, dpr, toast);
      else await captureWindowMode(rect, dpr, vw, vh, toast);
    } catch (e) {
      chrome.runtime.sendMessage({ type: 'SCO_CAP_ABORT' });
      toast.style.visibility = 'visible';
      toast.textContent = '캡처 실패: ' + (e && e.message ? e.message : e);
      await sleep(2500);
    } finally {
      blocker.remove();
      toast.remove();
      capturing = false;
    }
  }

  // 캡처 한 장: 진행 UI를 확실히 숨긴 뒤 찍고, 실패(호출 제한) 시 한 번 재시도
  async function shoot(segMsg, hideEls) {
    const els = Array.isArray(hideEls) ? hideEls : [hideEls];
    els.forEach((el) => { el.style.visibility = 'hidden'; });
    await paintFlush();
    let res;
    try {
      res = await send(segMsg);
    } catch (e) {
      await sleep(800);
      res = await send(segMsg);
    }
    els.forEach((el) => { el.style.visibility = 'visible'; });
    return res;
  }

  // ---- 모드 A: 일반 페이지 — window를 스크롤하며 캡처 ----
  // opts: { part(연속 캡처의 부 번호), openViewer(끝나고 결과 탭 열지), shouldStop() }
  // 반환값: 캡처한 화면(세그먼트) 수
  async function captureWindowMode(rect, dpr, vw, vh, toast, opts = {}) {
    const docW = document.documentElement.scrollWidth;
    const docH = document.documentElement.scrollHeight;
    rect.x = Math.max(0, rect.x);
    rect.y = Math.max(0, rect.y);
    rect.w = Math.min(rect.w, docW - rect.x, vw);
    rect.h = Math.min(rect.h, docH - rect.y);

    // 캔버스 안전 한도: 세로 32000 device px, 전체 2.4억 px²
    const totalW = Math.max(1, Math.round(rect.w * dpr));
    const maxHDev = Math.min(32000, Math.floor(240e6 / totalW));
    if (rect.h * dpr > maxHDev) rect.h = Math.floor(maxHDev / dpr);

    const origX = window.scrollX, origY = window.scrollY;

    // 여러 장으로 나눠 찍을 때 반복해서 찍히는 고정(fixed/sticky) 요소 수집
    const needScroll = rect.h > vh - 2;
    const fixedEls = [];
    if (needScroll) {
      let scanned = 0;
      for (const el of document.querySelectorAll('body *')) {
        if (++scanned > 15000) break;
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') fixedEls.push([el, el.style.visibility]);
      }
    }
    const hideFixed = () => fixedEls.forEach(([el]) => { el.style.visibility = 'hidden'; });
    const restoreFixed = () => fixedEls.forEach(([el, v]) => { el.style.visibility = v; });

    let seg = 0;
    try {
      await send({
        type: 'SCO_CAP_BEGIN',
        totalW,
        totalH: Math.max(1, Math.round(rect.h * dpr)),
        dpr,
        part: opts.part || 1,
        pageUrl: location.href,
        pageTitle: document.title,
        ...(opts.meta || {}) // chapterTitle / chapterKey / workId
      });

      const bottom = rect.y + rect.h;
      let covered = rect.y; // 문서 좌표 기준, 여기까지 캡처 완료
      let prevSy = -1;
      let stoppedMid = false;

      while (covered < bottom - 0.5 && seg < 100) {
        if (opts.shouldStop && opts.shouldStop()) { stoppedMid = true; break; }
        window.scrollTo({ left: rect.x, top: covered, behavior: 'instant' });
        await sleep(seg === 0 ? 250 : 550); // 렌더링 대기 + captureVisibleTab 호출 제한(초당 2회) 준수
        if (seg === 1) hideFixed();         // 두 번째 장부터 고정 요소 숨김

        const sx = window.scrollX, sy = window.scrollY;
        const sliceTop = Math.max(covered, sy);
        const sliceBottom = Math.min(bottom, sy + vh);
        // 스크롤이 더 이상 전진하지 않으면(페이지 끝/스크롤 차단) 여기까지만 저장
        if (sliceBottom <= covered + 0.5 || (seg > 0 && sy === prevSy && sliceTop >= sy + vh)) break;
        prevSy = sy;

        toast.textContent =
          `캡처 중… ${Math.min(100, Math.round(((sliceBottom - rect.y) / rect.h) * 100))}%`;

        await shoot({
          type: 'SCO_CAP_SEG',
          srcX: Math.round((rect.x - sx) * dpr),
          srcY: Math.round((sliceTop - sy) * dpr),
          srcW: totalW,
          srcH: Math.max(1, Math.round((sliceBottom - sliceTop) * dpr)),
          dstX: 0,
          dstY: Math.round((sliceTop - rect.y) * dpr)
        }, toast);

        covered = sliceBottom;
        seg++;
      }

      // 스크롤 도중(stoppedMid)뿐 아니라 '루프 정상 종료 직후'에 눌린 중지도 여기서 잡는다.
      // 이 확인이 없으면, 완성 회차를 SCO_CAP_END로 저장한 뒤 상위 루프가 '중지됨'을 보고
      // 같은 회차에서 일시정지 → 재개 시 같은 회차를 다시 캡처해 중복이 생긴다.
      if (stoppedMid || (opts.shouldStop && opts.shouldStop())) {
        // 중단 → 이 구간을 저장하지 않고 폐기. 재개 시 이 구간을 처음부터 다시 캡처하므로
        // '완성본 + 재캡처' 중복이 생기지 않는다 (fix 10 / MEDIUM-002).
        toast.textContent = '중단됨 — 이 구간은 저장하지 않습니다.';
        await send({ type: 'SCO_CAP_ABORT' });
      } else {
        toast.textContent = '이미지 생성 중…';
        await send({ type: 'SCO_CAP_END', openViewer: opts.openViewer !== false });
      }
    } finally {
      restoreFixed();
      window.scrollTo(origX, origY);
    }
    return seg;
  }

  // ---- 모드 B: 고정 패널 내부 스크롤 캡처 (댓글/채팅 패널 등) ----
  // 화면에 고정된 clip 영역은 그대로 두고, 패널 내부 스크롤러를 내리면서
  // 스크롤된 거리만큼 아래에 이어붙인다.
  async function captureScrollerMode(clip, scroller, dpr, toast) {
    const top0 = scroller.scrollTop;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    let totalCss = (maxTop - top0) + clip.h; // 현재 위치부터 끝까지

    const totalW = Math.max(1, Math.round(clip.w * dpr));
    const maxHDev = Math.min(32000, Math.floor(240e6 / totalW));
    if (totalCss * dpr > maxHDev) totalCss = Math.floor(maxHDev / dpr);

    try {
      await send({
        type: 'SCO_CAP_BEGIN',
        totalW,
        totalH: Math.max(1, Math.round(totalCss * dpr)),
        dpr,
        pageUrl: location.href,
        pageTitle: document.title
      });

      let seg = 0;
      let prevTop = -1;
      await sleep(250);

      while (seg < 200) {
        const cur = scroller.scrollTop;
        if (cur === prevTop) break; // 더 이상 스크롤되지 않음 → 종료
        prevTop = cur;
        if ((cur - top0) + clip.h > totalCss + 0.5) break; // 안전 한도 도달

        toast.textContent = `캡처 중(내부 스크롤)… ${Math.min(100, Math.round((((cur - top0) + clip.h) / totalCss) * 100))}%`;

        await shoot({
          type: 'SCO_CAP_SEG',
          srcX: Math.round(clip.x * dpr),
          srcY: Math.round(clip.y * dpr),
          srcW: totalW,
          srcH: Math.max(1, Math.round(clip.h * dpr)),
          dstX: 0,
          dstY: Math.round((cur - top0) * dpr)
        }, toast);

        if (cur >= maxTop - 0.5) break; // 끝까지 캡처 완료
        scroller.scrollTop = Math.min(cur + clip.h, maxTop);
        await sleep(550); // 렌더링 대기 + 캡처 호출 제한 준수
        seg++;
      }

      toast.textContent = '이미지 생성 중…';
      await send({ type: 'SCO_CAP_END' });
    } finally {
      scroller.scrollTop = top0;
    }
  }

  // ---- 모드 C: 페이지 넘김 캡처 (카카오페이지 등 넘겨보는 뷰어) ----
  // 선택한 영역을 찍고 → 다음 페이지로 넘기고 → 다시 찍기를 반복해 세로로 이어붙인다.
  // 내용이 더 이상 바뀌지 않으면(마지막 페이지) 자동 종료한다.
  function advancePage(strategy, clip, blocker) {
    if (strategy === 'key') {
      const opts = {
        key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39,
        bubbles: true, cancelable: true
      };
      document.dispatchEvent(new KeyboardEvent('keydown', opts));
      document.dispatchEvent(new KeyboardEvent('keyup', opts));
    } else {
      // 선택 영역 오른쪽 끝 클릭 (뷰어의 "다음 페이지" 영역)
      const x = clip.x + clip.w - Math.min(24, clip.w * 0.08);
      const y = clip.y + clip.h / 2;
      blocker.style.pointerEvents = 'none';
      const el = document.elementFromPoint(x, y) || document.body;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, clientX: x, clientY: y, view: window
        }));
      }
      blocker.style.pointerEvents = 'auto';
    }
  }

  // ---- 모드 E: jjwxc 화(chapter) 단위 연속 캡처 ----
  // jjwxc는 chapterid가 붙은 URL로 실제 페이지 이동을 하므로,
  // 세션을 storage에 저장해 두고 다음 화 페이지가 로드되면 이어서 캡처한다.
  function jjwxcChapterInfo(url) {
    if (!/jjwxc\.net/i.test(url)) return null;
    const n = /[?&]novelid=(\d+)/.exec(url);
    const c = /[?&]chapterid=(\d+)/.exec(url);
    if (!n || !c) return null;
    return { novelid: Number(n[1]), chapterid: Number(c[1]) };
  }

  // 사이트 어댑터 (site-adapters.js). 없으면 최소 동작 폴백.
  function getAdapter() {
    if (globalThis.SCOAdapters && SCOAdapters.detect) return SCOAdapters.detect();
    return {
      id: 'generic',
      chapterInfo: () => null,
      contentElement: () => null,
      chapterTitle: () => (document.title || '').slice(0, 60),
      nextUrl: () => ''
    };
  }

  const sameUrl = (a, b) => {
    const norm = (u) => String(u || '').split('#')[0].replace(/\/$/, '');
    return norm(a) === norm(b);
  };

  // 한 화를 캡처하고, 남은 화가 있으면 세션을 갱신한 뒤 다음 화로 이동한다.
  async function captureChapterRun(s) {
    capturing = true;
    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth, vh = window.innerHeight;
    const adapter = getAdapter();
    const label = adapter.chapterTitle() || s.chapterKey || `${s.part}번째 화`;

    const toast = makeToast(`「${label}」 캡처 준비 중…`);
    const blocker = document.createElement('div');
    Object.assign(blocker.style, {
      position: 'fixed', inset: '0', zIndex: Z, cursor: 'wait', background: 'transparent'
    });
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '■ 캡처 중지';
    Object.assign(stopBtn.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: Z + 1,
      padding: '10px 16px', border: 'none', borderRadius: '8px',
      background: '#d64545', color: '#fff', font: '13px "Malgun Gothic", sans-serif',
      cursor: 'pointer', boxShadow: '0 2px 12px rgba(0,0,0,.4)'
    });
    document.documentElement.appendChild(blocker);
    document.documentElement.appendChild(stopBtn);

    let stopped = false;
    stopBtn.addEventListener('click', () => { stopped = true; stopBtn.textContent = '중지 중…'; });
    const onKey = (e) => { if (e.key === 'Escape' && e.isTrusted) { stopped = true; e.stopPropagation(); } };
    window.addEventListener('keydown', onKey, true);

    const failed = Array.isArray(s.failed) ? s.failed : [];

    // 회차 캡처 종료 처리: 실패 목록을 남겨 결과 창에서 재실행할 수 있게 한다
    const finishRun = async (message) => {
      await chrome.storage.local.set({
        lastChapterRun: {
          finishedAt: Date.now(),
          siteId: adapter.id,
          clipX: s.clipX, clipY: s.clipY, clipW: s.clipW,
          failed
        }
      });
      await chrome.storage.local.remove('contSession');
      toast.textContent = message +
        (failed.length ? ` (실패 ${failed.length}화 — 결과 창에서 재실행 가능)` : '');
      await send({ type: 'SCO_OPEN_VIEWER' }).catch(() => {});
      await sleep(failed.length ? 2500 : 800);
    };

    try {
      const docH = document.documentElement.scrollHeight;
      const clipY = Math.min(s.clipY, Math.max(0, docH - 10));
      // 본문 컨테이너 아래의 댓글/광고 UI는 캡처하지 않는다 (어댑터가 본문을 앎)
      let bottomDoc = docH;
      const contentEl = adapter.contentElement();
      if (contentEl) {
        const nb = contentEl.getBoundingClientRect().bottom + window.scrollY + 24;
        if (nb > clipY + 300) bottomDoc = Math.min(bottomDoc, nb);
      }
      const rect = { x: s.clipX, y: clipY, w: s.clipW, h: Math.max(1, bottomDoc - clipY) };
      toast.textContent = `「${label}」 캡처 중… (${s.part}번째${s.remaining > 1 ? `, 이후 ${s.remaining - 1}화 남음` : ''})`;

      const info = adapter.chapterInfo();
      const capOpts = {
        part: s.part,
        openViewer: false,
        shouldStop: () => stopped,
        meta: {
          chapterTitle: label,
          chapterKey: (info && info.chapterKey) || s.chapterKey || '',
          workId: (info && info.workId) || s.workId || ''
        }
      };

      // 일시적 오류에 대비해 1회 재시도, 반복 실패 시 이 화만 실패 처리하고 계속 진행
      try {
        try {
          await captureWindowMode(rect, dpr, vw, vh, toast, capOpts);
        } catch (firstErr) {
          chrome.runtime.sendMessage({ type: 'SCO_CAP_ABORT' });
          toast.textContent = `「${label}」 캡처 오류 — 3초 후 한 번 더 시도합니다…`;
          await sleep(3000);
          await captureWindowMode(rect, dpr, vw, vh, toast, capOpts);
        }
      } catch (finalErr) {
        chrome.runtime.sendMessage({ type: 'SCO_CAP_ABORT' });
        failed.push({
          url: location.href.split('#')[0],
          label,
          error: String((finalErr && finalErr.message) || finalErr).slice(0, 120)
        });
        toast.textContent = `「${label}」 캡처 실패 — 기록해 두고 다음 화로 넘어갑니다.`;
        await sleep(1500);
      }

      if (stopped) {
        // 중단: 세션을 일시정지 상태로 보존 → 결과 창의 「▶ 재개」로 이어서 진행
        await chrome.storage.local.set({
          contSession: { ...s, failed, paused: true, expectUrl: location.href.split('#')[0], startedAt: Date.now() }
        });
        toast.textContent = '캡처를 중지했습니다 — 결과 창의 「▶ 재개」 버튼으로 이어서 진행할 수 있습니다.';
        await send({ type: 'SCO_OPEN_VIEWER' }).catch(() => {});
        await sleep(2000);
        return;
      }

      if (s.remaining <= 1) {
        await finishRun(`연속 캡처 완료 (${s.part}개 화) — 결과 창을 엽니다.`);
        return;
      }

      // 다음 화 결정: 재실행 큐가 있으면 큐 우선, 없으면 어댑터의 다음 화 URL
      const queue = Array.isArray(s.queue) ? s.queue.slice() : null;
      let nextUrl = queue && queue.length ? queue.shift() : adapter.nextUrl();
      if (!nextUrl || sameUrl(nextUrl, location.href)) {
        await finishRun('다음 화 주소를 찾지 못해 종료합니다 — 여기까지 저장되었습니다.');
        return;
      }
      await chrome.storage.local.set({
        contSession: {
          ...s,
          queue,
          failed,
          paused: false,
          expectUrl: String(nextUrl).split('#')[0],
          part: s.part + 1,
          remaining: s.remaining - 1,
          startedAt: Date.now()
        }
      });
      toast.textContent = `「${label}」 저장됨 — 다음 화로 이동합니다…`;
      await sleep(700);
      location.href = nextUrl; // 페이지 이동 → 새 페이지에서 자동 재개
      return;
    } catch (e) {
      await finishRun('❌ 연속 캡처 중단 (이전 화까지는 저장됨): ' + (e && e.message ? e.message : e));
    } finally {
      window.removeEventListener('keydown', onKey, true);
      stopBtn.remove();
      blocker.remove();
      toast.remove();
      capturing = false;
    }
  }

  // 페이지 로드 시: 진행 중인 화 단위 연속 캡처 세션이 있으면 자동 재개
  (async () => {
    try {
      const { contSession } = await chrome.storage.local.get('contSession');
      if (!contSession || !contSession.active || contSession.paused) return;
      if (Date.now() - (contSession.startedAt || 0) > 10 * 60 * 1000) {
        chrome.storage.local.remove('contSession'); // 오래된 세션 정리
        return;
      }
      // 새 세션: expectUrl 일치 / 구버전 세션: novelid+chapterid 일치
      if (contSession.expectUrl) {
        if (!sameUrl(contSession.expectUrl, location.href)) return;
      } else {
        const info = jjwxcChapterInfo(location.href);
        if (!info || info.novelid !== contSession.novelid || info.chapterid !== contSession.chapterid) return;
      }
      if (capturing) return;
      // 아래 렌더링 대기(최대 20초) 동안 수동 캡처가 끼어들지 못하도록 즉시 선점한다.
      // (이전에는 이 지점에서만 capturing을 확인하고, 정작 캡처를 시작하는 시점에는
      // 재확인하지 않아 대기 중 사용자가 수동 선택을 시작하면 두 캡처 흐름이 동시에
      // capturing을 건드리는 경쟁 상태가 있었다.)
      capturing = true;
      try {
        // 본문 렌더링 완료 대기: 문서 높이가 안정될 때까지 (최대 20초)
        let prevH = 0;
        for (let i = 0; i < 40; i++) {
          await sleep(500);
          const h = document.documentElement.scrollHeight;
          if (document.readyState === 'complete' && h > window.innerHeight && h === prevH) break;
          prevH = h;
        }
        await sleep(500);
        // 대기하는 동안 세션이 취소/일시정지됐을 수 있으니 실제 시작 직전에 다시 확인한다.
        const fresh = await chrome.storage.local.get('contSession');
        if (!fresh.contSession || !fresh.contSession.active || fresh.contSession.paused) {
          capturing = false;
          return;
        }
        // nextUrl()은 chapterid를 단순히 +1 하거나(jjwxc) 화면에 보이는 "다음" 링크를
        // 그대로 따라간 것이라 실제로 존재하는 화인지 보장하지 않는다. URL이 기대값과
        // 같더라도, 도착한 페이지가 같은 작품의 유효한 회차가 아니면(챕터 정보 없음 /
        // 다른 workId) 잘못된 페이지를 회차로 캡처하지 않도록 여기서 멈춘다.
        const landedAdapter = getAdapter();
        const landedInfo = landedAdapter.chapterInfo && landedAdapter.chapterInfo();
        const expectedWorkId = fresh.contSession.workId;
        if (expectedWorkId && (!landedInfo || String(landedInfo.workId) !== String(expectedWorkId))) {
          await chrome.storage.local.set({
            lastChapterRun: {
              finishedAt: Date.now(),
              siteId: fresh.contSession.siteId,
              clipX: fresh.contSession.clipX, clipY: fresh.contSession.clipY, clipW: fresh.contSession.clipW,
              failed: Array.isArray(fresh.contSession.failed) ? fresh.contSession.failed : []
            }
          });
          await chrome.storage.local.remove('contSession');
          capturing = false;
          return;
        }
        capturing = false; // captureChapterRun이 자체적으로 다시 true로 설정하고 종료 시 해제한다.
        captureChapterRun(fresh.contSession);
      } catch (e) {
        capturing = false;
        throw e;
      }
    } catch (_) { /* 세션 없음 */ }
  })();

  // ---- 모드 D: 연속 캡처 — 스크롤 캡처 후 [다음] 버튼을 자동으로 눌러 다음 구간 반복 ----
  // 카카오페이지 뷰어처럼 한 구간을 다 읽으면 아래 화살표/다음 버튼으로
  // 다음 구간을 로드하는 구조에 대응한다. 구간마다 별도 이미지로 저장된다.
  const MAX_TOTAL_SCREENS = 300; // 연속 캡처 상한 (약 300화면)

  // [다음] 컨트롤 후보 탐색 (카카오페이지 '아래 화살표' 이미지 / '다음' 텍스트 버튼)
  function findNextControl() {
    for (const img of document.querySelectorAll('img[alt]')) {
      const alt = (img.alt || '').replace(/\s+/g, '');
      if ((alt.includes('아래화살표') || alt.includes('다음화') || alt === '다음') &&
          img.getBoundingClientRect().width > 0) return img;
    }
    for (const el of document.querySelectorAll('a,button,[role="button"]')) {
      const t = (el.textContent || '').replace(/\s+/g, '');
      const aria = (el.getAttribute('aria-label') || '').replace(/\s+/g, '');
      if ((/^다음(화|편|회차|이야기)?(보기)?$/.test(t) || aria.includes('다음')) &&
          el.getBoundingClientRect().width > 0) return el;
    }
    return null;
  }

  function clickWithCoords(el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy
      }));
    }
  }

  // 문서 맨 아래의 [다음] 컨트롤을 찾아 클릭하고, 새 구간 로딩을 기다린다.
  // (참고: 카카오페이지 등 본문을 안티스크래핑 처리하는 사이트는 document.body.innerText가
  // 실제 내용이 아니라 해시성 플레이스홀더로 뒤덮여 있어, 텍스트 서명 비교로 "이미 본 화면"을
  // 판정하면 정상적인 다음 구간도 재방문으로 오판해 연속 캡처가 1구간 만에 멈춘다.
  // 그래서 순환 감지는 실제 픽셀 해시를 쓰는 capturePagedMode 쪽에서만 하고, 여기서는
  // 기존의 단순 isChanged() 판정만 사용한다.)
  async function goNextSection(blocker) {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });

    // 버튼은 맨 아래에서만 나타나는 경우가 많으므로 최대 5초 동안 반복 탐색
    let target = null;
    for (let attempt = 0; attempt < 10 && !target; attempt++) {
      await sleep(500);
      target = findNextControl();
      if (!target && attempt % 3 === 2) {
        // 다시 한 번 바닥으로 (내용이 늦게 로드되어 문서가 더 길어졌을 수 있음)
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      }
    }
    if (!target) return false;

    // 클릭 가능한 조상으로 승격
    let btn = target;
    while (btn && btn !== document.body &&
           !(btn.tagName === 'BUTTON' || btn.tagName === 'A' || btn.getAttribute('role') === 'button')) {
      btn = btn.parentElement;
    }
    const clickEl = (btn && btn !== document.body) ? btn : target;

    const prevUrl = location.href;
    const prevH = document.documentElement.scrollHeight;
    const prevSig = (document.body.innerText || '').slice(0, 300);
    const isChanged = () =>
      location.href !== prevUrl ||
      Math.abs(document.documentElement.scrollHeight - prevH) > 50 ||
      (document.body.innerText || '').slice(0, 300) !== prevSig;

    blocker.style.pointerEvents = 'none';
    clickWithCoords(clickEl);
    blocker.style.pointerEvents = 'auto';

    // 새 구간 로딩 감지: URL 변경 또는 문서 높이/본문 앞부분 변화 (최대 16초)
    // 8초가 지나도 변화가 없으면 한 번 더 클릭해 본다.
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      if (isChanged()) {
        await sleep(900); // 렌더링 안정화
        window.scrollTo({ top: 0, behavior: 'instant' });
        await sleep(400);
        return true;
      }
      if (i === 20) {
        const again = findNextControl();
        if (again) {
          blocker.style.pointerEvents = 'none';
          clickWithCoords(again);
          blocker.style.pointerEvents = 'auto';
        }
      }
    }
    return false;
  }

  async function captureContinuous(clipVp, maxParts) {
    capturing = true;
    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth, vh = window.innerHeight;

    const toast = makeToast('연속 캡처 준비 중…');
    const blocker = document.createElement('div');
    Object.assign(blocker.style, {
      position: 'fixed', inset: '0', zIndex: Z, cursor: 'wait', background: 'transparent'
    });
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '■ 캡처 중지';
    Object.assign(stopBtn.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: Z + 1,
      padding: '10px 16px', border: 'none', borderRadius: '8px',
      background: '#d64545', color: '#fff', font: '13px "Malgun Gothic", sans-serif',
      cursor: 'pointer', boxShadow: '0 2px 12px rgba(0,0,0,.4)'
    });
    document.documentElement.appendChild(blocker);
    document.documentElement.appendChild(stopBtn);

    let stopped = false;
    stopBtn.addEventListener('click', () => { stopped = true; stopBtn.textContent = '중지 중…'; });
    const onKey = (e) => { if (e.key === 'Escape' && e.isTrusted) { stopped = true; e.stopPropagation(); } };
    window.addEventListener('keydown', onKey, true);

    const clipX = clipVp.x + window.scrollX;
    let screens = 0, part = 1;

    try {
      const limit = Math.max(1, Math.min(maxParts || 100, 100));
      let startY = clipVp.y + window.scrollY;
      while (!stopped && screens < MAX_TOTAL_SCREENS && part <= limit) {
        const docH = document.documentElement.scrollHeight;
        const rect = { x: clipX, y: startY, w: clipVp.w, h: Math.max(1, docH - startY) };
        toast.textContent = `연속 캡처 ${part}/${maxParts ? limit : '?'}부 진행 중… (누적 ${screens}화면, 중지: ESC/우하단 버튼)`;

        // 한 부(部)의 캡처 실패가 전체를 중단시키지 않도록 격리 + 1회 재시도
        let segs = 0;
        try {
          segs = await captureWindowMode(rect, dpr, vw, vh, toast, {
            part, openViewer: false, shouldStop: () => stopped
          });
        } catch (err) {
          chrome.runtime.sendMessage({ type: 'SCO_CAP_ABORT' });
          toast.textContent = `${part}부 캡처 오류 — 3초 후 한 번 더 시도합니다…`;
          await sleep(3000);
          try {
            segs = await captureWindowMode(rect, dpr, vw, vh, toast, {
              part, openViewer: false, shouldStop: () => stopped
            });
          } catch (err2) {
            chrome.runtime.sendMessage({ type: 'SCO_CAP_ABORT' });
            toast.textContent = `${part}부 캡처가 반복 실패해 여기서 종료합니다 (이전 부까지는 저장됨): ` +
              (err2 && err2.message ? err2.message : err2);
            await sleep(2500);
            break;
          }
        }
        screens += Math.max(1, segs);
        if (stopped || screens >= MAX_TOTAL_SCREENS) break;
        if (part >= limit) { // 지정한 구간 수 도달
          toast.textContent = `지정한 ${limit}부까지 캡처를 완료했습니다.`;
          await sleep(1200);
          break;
        }

        toast.textContent = `${part}부 저장됨 — 다음 구간으로 이동 중…`;
        const moved = await goNextSection(blocker);
        if (!moved) {
          toast.textContent = '다음 구간(다음 화) 버튼을 찾지 못해 종료합니다 — 여기까지 저장되었습니다.';
          await sleep(2000);
          break;
        }
        startY = 0; // 다음 구간부터는 문서 맨 위부터
        part++;
      }

      toast.textContent = `연속 캡처 완료 — 총 ${part}부, 약 ${screens}화면. 결과 창을 엽니다.`;
      await send({ type: 'SCO_OPEN_VIEWER' });
      await sleep(800);
    } catch (e) {
      chrome.runtime.sendMessage({ type: 'SCO_CAP_ABORT' });
      toast.style.visibility = 'visible';
      toast.textContent = '연속 캡처 실패: ' + (e && e.message ? e.message : e);
      await sleep(2500);
    } finally {
      window.removeEventListener('keydown', onKey, true);
      stopBtn.remove();
      blocker.remove();
      toast.remove();
      capturing = false;
    }
  }

  async function capturePagedMode(clip) {
    // 스크롤 방식 뷰어(카카오페이지 웹 등) 자동 감지:
    // 선택한 가로 폭으로 현재 위치부터 문서 끝까지 캡처하고,
    // [다음] 버튼을 자동으로 눌러가며 다음 구간을 계속 캡처한다 (최대 300화면).
    const docH = document.documentElement.scrollHeight;

    // 챕터형 사이트(jjwxc, 起点 등): URL로 다음 화로 이동하는 사이트만 화 단위 모드.
    // 카카오처럼 URL 이동이 아닌(navMode!=='url') 뷰어는 아래 연속(클릭) 모드로 처리 (fix 11).
    const adapter = getAdapter();
    const info = adapter.chapterInfo && adapter.chapterInfo();
    if (info && adapter.navMode === 'url' && docH > window.innerHeight + 200) {
      const ans = prompt(
        `몇 화까지 캡처할까요? (현재: ${adapter.chapterTitle() || info.chapterKey})\n` +
        '숫자를 입력하세요. 1 = 현재 화만.',
        '1'
      );
      if (ans === null) return; // 취소
      let count = parseInt(String(ans).trim(), 10);
      if (!Number.isFinite(count) || count < 1) count = 1;
      count = Math.min(count, 100);

      const session = {
        active: true,
        paused: false,
        startedAt: Date.now(),
        siteId: adapter.id,
        workId: info.workId,
        chapterKey: info.chapterKey,
        expectUrl: location.href.split('#')[0],
        clipX: clip.x + window.scrollX,
        clipY: clip.y + window.scrollY,
        clipW: clip.w,
        part: 1,
        remaining: count,
        failed: []
      };
      await chrome.storage.local.set({ contSession: session });
      captureChapterRun(session);
      return;
    }

    if (docH > window.innerHeight + 200) {
      // 몇 구간(화)까지 캡처할지 입력받는다. 비워두면 끝까지(안전 한도 내).
      const ans = prompt(
        '몇 구간(화)까지 캡처할까요?\n' +
        '숫자를 입력하세요. 비워두면 끝까지 캡처합니다 (최대 300화면).',
        ''
      );
      if (ans === null) return; // 취소
      let maxParts = parseInt(String(ans).trim(), 10);
      if (!Number.isFinite(maxParts) || maxParts < 1) maxParts = 0; // 0 = 무제한(끝까지)

      const notice = makeToast(
        maxParts
          ? `스크롤 방식 뷰어 감지 — [다음] 버튼을 자동으로 눌러가며 ${maxParts}구간까지 캡처합니다.`
          : '스크롤 방식 뷰어 감지 — [다음] 버튼을 자동으로 눌러가며 끝까지 캡처합니다.'
      );
      await sleep(1400);
      notice.remove();
      captureContinuous(clip, maxParts);
      return;
    }

    capturing = true;
    const dpr = window.devicePixelRatio || 1;

    const toast = makeToast('페이지 넘김 캡처 시작…');
    const blocker = document.createElement('div');
    Object.assign(blocker.style, {
      position: 'fixed', inset: '0', zIndex: Z, cursor: 'wait', background: 'transparent'
    });
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '■ 캡처 중지';
    Object.assign(stopBtn.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: Z + 1,
      padding: '10px 16px', border: 'none', borderRadius: '8px',
      background: '#d64545', color: '#fff', font: '13px "Malgun Gothic", sans-serif',
      cursor: 'pointer', boxShadow: '0 2px 12px rgba(0,0,0,.4)'
    });
    document.documentElement.appendChild(blocker);
    document.documentElement.appendChild(stopBtn);

    let stopped = false;
    stopBtn.addEventListener('click', () => { stopped = true; stopBtn.textContent = '중지 중…'; });
    const onKey = (e) => { if (e.key === 'Escape' && e.isTrusted) { stopped = true; e.stopPropagation(); } };
    window.addEventListener('keydown', onKey, true);

    const totalW = Math.max(1, Math.round(clip.w * dpr));
    const maxHDev = Math.min(32000, Math.floor(240e6 / totalW));
    const maxPages = Math.max(1, Math.min(200, Math.floor(maxHDev / Math.max(1, clip.h * dpr))));

    try {
      await send({
        type: 'SCO_CAP_BEGIN',
        totalW,
        totalH: Math.max(1, Math.round(Math.min(maxPages * clip.h, maxHDev / dpr) * dpr)),
        dpr,
        pageUrl: location.href,
        pageTitle: document.title
      });

      let page = 0;
      let prevHash = null;
      // 직전 페이지와만 비교하면, [다음]이 이미 봤던 페이지로 순환(마지막→처음)하거나
      // 오탐된 컨트롤이 목차 등으로 되돌리는 경우를 감지하지 못해 maxPages까지 같은
      // 내용을 계속 다시 캡처하게 된다. 지금까지 나온 모든 해시를 기억해 재등장 시 종료한다.
      const seenHashes = new Set();
      let strategy = 'key'; // 우선 →키로 넘기고, 안 되면 클릭으로 전환
      let triedClick = false;
      await sleep(300);

      while (!stopped && page < maxPages) {
        const res = await shoot({
          type: 'SCO_CAP_SEG',
          srcX: Math.round(clip.x * dpr),
          srcY: Math.round(clip.y * dpr),
          srcW: totalW,
          srcH: Math.max(1, Math.round(clip.h * dpr)),
          dstX: 0,
          dstY: Math.round(page * clip.h * dpr),
          wantHash: true
        }, [toast, stopBtn]);

        if (prevHash && res.hash === prevHash) {
          // 페이지가 넘어가지 않았음
          if (strategy === 'key' && !triedClick) {
            strategy = 'click'; // 키가 안 먹는 뷰어 → 클릭 방식으로 재시도
            triedClick = true;
            advancePage(strategy, clip, blocker);
            await sleep(800);
            continue; // 같은 슬롯에 다시 찍는다 (중복분은 덮어씀)
          }
          break; // 마지막 페이지 도달
        }
        if (res.hash && seenHashes.has(res.hash)) break; // 이전에 이미 캡처한 페이지로 순환 — 종료
        if (res.hash) seenHashes.add(res.hash);
        prevHash = res.hash;
        page++;
        toast.textContent = `페이지 넘김 캡처… ${page}페이지 (중지: ESC 또는 우하단 버튼)`;

        if (stopped || page >= maxPages) break;
        advancePage(strategy, clip, blocker);
        await sleep(800); // 페이지 전환 애니메이션 + 캡처 호출 제한 대기
      }

      toast.textContent = `이미지 생성 중… (${page}페이지)`;
      await send({ type: 'SCO_CAP_END', usedH: Math.max(1, Math.round(page * clip.h * dpr)) });
    } catch (e) {
      chrome.runtime.sendMessage({ type: 'SCO_CAP_ABORT' });
      toast.style.visibility = 'visible';
      toast.textContent = '캡처 실패: ' + (e && e.message ? e.message : e);
      await sleep(2500);
    } finally {
      window.removeEventListener('keydown', onKey, true);
      stopBtn.remove();
      blocker.remove();
      toast.remove();
      capturing = false;
    }
  }

  // 연속 캡처용 섹션 선택: 마우스를 올리면 요소가 강조되고, 클릭하면
  // 그 요소의 화면 영역(가로 폭 기준)으로 연속 캡처를 시작한다.
  function startPagedSelect() {
    const highlight = document.createElement('div');
    Object.assign(highlight.style, {
      position: 'fixed', border: '2px solid #8957e5',
      background: 'rgba(137,87,229,.18)', zIndex: Z,
      pointerEvents: 'none', display: 'none', boxSizing: 'border-box',
      borderRadius: '3px'
    });
    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'fixed', background: '#8957e5', color: '#fff',
      font: '11px/1 monospace', padding: '3px 6px', borderRadius: '4px',
      zIndex: Z + 1, display: 'none', pointerEvents: 'none'
    });
    const toast = makeToast('캡처할 본문 섹션 위에 마우스를 올리고 클릭하세요 — 선택한 폭으로 연속 캡처가 시작됩니다 (ESC: 취소)');
    document.documentElement.appendChild(highlight);
    document.documentElement.appendChild(label);

    let current = null;

    const onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === highlight || el === label || el === toast) return;
      current = el;
      const r = el.getBoundingClientRect();
      Object.assign(highlight.style, {
        display: 'block',
        left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px'
      });
      label.style.display = 'block';
      label.textContent =
        el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '') +
        ` (${Math.round(r.width)} × ${Math.round(r.height)})`;
      label.style.left = Math.max(0, r.left) + 'px';
      label.style.top = Math.max(0, r.top - 22) + 'px';
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!current) return;
      const r = current.getBoundingClientRect();
      // 선택 요소의 화면 영역을 뷰포트 안으로 잘라 연속 캡처 시작점으로 사용
      const clip = {
        x: Math.max(0, r.left),
        y: Math.max(0, r.top),
        w: 0,
        h: 0
      };
      clip.w = Math.min(r.right, window.innerWidth) - clip.x;
      clip.h = Math.min(r.bottom, window.innerHeight) - clip.y;
      cancelSelection();
      if (clip.w < 3 || clip.h < 3) return;
      capturePagedMode(clip);
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);

    const onKey = (e) => { if (e.key === 'Escape') cancelSelection(); };
    document.addEventListener('keydown', onKey, true);

    ui = {
      elements: [highlight, label, toast],
      onKey,
      cleanup() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
      }
    };
  }

  // ---- 모드 F: 텍스트 바로 저장 — 요소를 클릭하면 innerText를 즉시 TXT로 저장 ----
  // 起点(qdmm/qidian) 등 본문이 일반 텍스트인 사이트용. OCR을 거치지 않아 100% 정확.
  // 결과 탭(viewer.js)의 "⚙️ 설정 — 파일 이름·저장 위치"와 같은 저장소 키(fileNameConfig)를
  // 공유한다. 거기서 정한 토큰 순서가 이미지·OCR·일괄다운로드·텍스트 바로 저장 모두에
  // 똑같이 적용된다. 사이트 태그: 카카오 kk / jjwxc 데스크톱 jj / jjwxc 모바일 mjj /
  // 起点(qidian·qdmm) qd / 기타 호스트명.
  // 결과 탭 설정에서 등록한 도메인→줄임말 매핑을 최우선으로 적용한다 (정확히 일치하는
  // 호스트가 없으면 상위 도메인까지 확인 — 예: "jjwxc.net" 등록 시 "m.jjwxc.net"에도 적용).
  function fnSiteTagOverride(overrides, host) {
    if (!overrides || !host) return '';
    if (overrides[host]) return overrides[host];
    const parts = host.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const suf = parts.slice(i).join('.');
      if (overrides[suf]) return overrides[suf];
    }
    return '';
  }

  function fnSiteTag(u, overrides) {
    const host = location.hostname.replace(/^www\./, '');
    const override = fnSiteTagOverride(overrides, host);
    if (override) return override;
    if (/jjwxc\.net/i.test(u)) {
      if (/[?&]novelid=\d+/.test(u)) return 'jj';
      // 모바일판은 소설번호·화번호를 쿼리 파라미터가 아니라 경로 세그먼트로 준다.
      // 무료 화는 /book2/{novelid}/{chapter}, 유료(VIP) 화는 /vip/{novelid}/{chapter}.
      if (/\/(?:book2|vip)\/\d+\/\d+/.test(u)) return 'mjj';
    }
    if (/(?:qdmm|qidian)\.com/i.test(u)) return 'qd';
    if (/page\.kakao\.com/i.test(u)) return 'kk';
    return (host.split('.')[0] || 'cap').slice(0, 8);
  }

  function fnInfoFromLocation(overrides) {
    const u = location.href;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateOnly = `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    let workId = '', chapterKey = '';
    const n = /[?&]novelid=(\d+)/.exec(u), c = /[?&]chapterid=(\d+)/.exec(u);
    const m = /\/(?:book2|vip)\/(\d+)\/(\d+)/.exec(u);
    const q = /(?:qdmm|qidian)\.com\/chapter\/(\d+)\/(\d+)/.exec(u);
    const k = /page\.kakao\.com\/content\/(\d+)(?:\/viewer\/(\d+))?/.exec(u);
    if (n) { workId = n[1]; chapterKey = c ? c[1] : ''; }
    else if (m) { workId = m[1]; chapterKey = m[2]; }
    else if (q) { workId = q[1]; chapterKey = q[2]; }
    else if (k) { workId = k[1]; chapterKey = k[2] || ''; }
    return {
      site: fnSiteTag(u, overrides), workId, chapterKey, dateOnly,
      dateTime: `${dateOnly}_${pad(d.getHours())}${pad(d.getMinutes())}`,
      part: 1
    };
  }

  const FN_GET = {
    site: (i) => i.site, workId: (i) => i.workId || '', chapterKey: (i) => i.chapterKey || '',
    date: (i) => i.dateOnly, datetime: (i) => i.dateTime, part: (i) => (i.part > 1 ? 'p' + i.part : '')
  };
  const FN_DEFAULT_SLOTS = ['site', 'workId', 'date', 'chapterKey', 'part'];

  function fnBuild(info, slots) {
    const list = Array.isArray(slots) && slots.length ? slots : FN_DEFAULT_SLOTS;
    const seen = new Set();
    const parts = [];
    for (const key of list) {
      if (!key || key === 'none' || seen.has(key)) continue;
      seen.add(key);
      const fn = FN_GET[key];
      const v = fn && fn(info);
      if (v) parts.push(v);
    }
    return parts.join('_') || 'cap';
  }

  async function textFileTag() {
    const { fileNameConfig, siteTagOverrides } = await chrome.storage.local.get(['fileNameConfig', 'siteTagOverrides']);
    return fnBuild(fnInfoFromLocation(siteTagOverrides), fileNameConfig);
  }

  // 요소에서 본문 텍스트만 추출: 단락 댓글 배지(段评 숫자) 등 부가 요소를 제외한다.
  function extractCleanText(el) {
    // 1) 댓글/배지 성격의 요소를 잠시 숨겨 innerText에서 제외 (display:none은 innerText에 안 잡힘)
    const junk = el.querySelectorAll(
      'sup, button, [class*="review" i], [class*="comment" i], [class*="remark" i], ' +
      '[class*="pinglun" i], [class*="duanping" i], [class*="count" i], [class*="badge" i]'
    );
    const saved = [];
    junk.forEach((n) => { saved.push([n, n.style.display]); n.style.display = 'none'; });
    let text = (el.innerText || '').trim();
    saved.forEach(([n, v]) => { n.style.display = v; });

    // 2) 남은 배지 숫자 정리
    text = text
      .replace(/([。！？…”’”…])[ \t]*\d{1,3}(?=\s|$)/g, '$1') // 문장부호 뒤에 붙은 1~3자리 숫자
      .replace(/([一-鿿가-힣])[ \t]+\d{1,3}$/gm, '$1')          // 줄 끝 한자/한글 뒤 공백+숫자 (제목 배지)
      .replace(/^\s*\d{1,4}\s*$/gm, '')                                  // 숫자만 있는 줄
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  // 실제 저장 (확장 다운로드 API → 실패 시 페이지 내 직접 다운로드)
  async function doSaveText(text, name) {
    const filename = name + '.txt';
    try {
      const res = await send({ type: 'SCO_SAVE_TEXT', text, filename });
      const t = makeToast(`✅ 저장 완료 (${text.length}자) — ${res.path || filename}`);
      setTimeout(() => t.remove(), 5000);
    } catch (err) {
      try {
        const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.documentElement.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        const t = makeToast(`✅ 저장 완료 (${text.length}자) — 브라우저 다운로드 폴더 (예비 방식)`);
        setTimeout(() => t.remove(), 5000);
      } catch (err2) {
        const t = makeToast('❌ 저장 실패: ' + (err && err.message ? err.message : err));
        setTimeout(() => t.remove(), 5000);
      }
    }
  }

  // 확장에 내장된 언어별 글꼴(Noto Sans SC/KoPub돋움체)을 @font-face로 등록한다.
  // 콘텐츠 스크립트는 임의의 웹페이지 안에서 실행되므로 상대 경로가 아니라
  // chrome.runtime.getURL()로 확장 자체의 리소스 URL을 만들어야 하고(매니페스트의
  // web_accessible_resources에 등록돼 있어야 페이지에서 로드 가능), 페이지마다 중복
  // 삽입되지 않도록 한 번만 추가한다.
  function ensureFontFaceInjected() {
    if (document.getElementById('sco-fontface')) return;
    const url = (p) => chrome.runtime.getURL('fonts/' + p);
    const style = document.createElement('style');
    style.id = 'sco-fontface';
    style.textContent = `
      @font-face { font-family: "Noto Sans SC"; src: url("${url('NotoSansSC-Regular.woff2')}") format("woff2"); font-weight: 400; font-display: swap; }
      @font-face { font-family: "Noto Sans SC"; src: url("${url('NotoSansSC-Bold.woff2')}") format("woff2"); font-weight: 700; font-display: swap; }
      @font-face { font-family: "KoPub돋움체"; src: url("${url('KoPubDotum-Light.woff2')}") format("woff2"); font-weight: 300; font-display: swap; }
      @font-face { font-family: "KoPub돋움체"; src: url("${url('KoPubDotum-Medium.woff2')}") format("woff2"); font-weight: 500; font-display: swap; }
      @font-face { font-family: "KoPub돋움체"; src: url("${url('KoPubDotum-Bold.woff2')}") format("woff2"); font-weight: 700; font-display: swap; }
    `;
    document.documentElement.appendChild(style);
  }

  // Listly식 미리보기: 추출된 텍스트를 보여주고 저장/복사/취소를 고르게 한다
  async function showTextPreview(text) {
    ensureFontFaceInjected();
    const back = document.createElement('div');
    Object.assign(back.style, {
      position: 'fixed', inset: '0', zIndex: Z + 5, background: 'rgba(0,0,0,.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    });
    const box = document.createElement('div');
    Object.assign(box.style, {
      width: 'min(680px, 92vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column',
      background: '#1e2430', color: '#e8ecf3', borderRadius: '10px', overflow: 'hidden',
      boxShadow: '0 10px 40px rgba(0,0,0,.5)', font: '13px "Malgun Gothic", sans-serif'
    });
    const head = document.createElement('div');
    head.textContent = `📝 저장 미리보기 — ${text.length}자`;
    Object.assign(head.style, { padding: '12px 16px', fontWeight: '700', background: '#232c3b', fontSize: '14px' });

    const nameRow = document.createElement('div');
    Object.assign(nameRow.style, { display: 'flex', gap: '6px', alignItems: 'center', padding: '10px 16px 6px' });
    const nameLabel = document.createElement('span');
    nameLabel.textContent = '파일명';
    nameLabel.style.cssText = 'font-size:12px;color:#9aa6b8';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = await textFileTag();
    Object.assign(nameInput.style, {
      flex: '1', padding: '6px 8px', border: '1px solid #2c3444', borderRadius: '6px',
      background: '#12161f', color: '#e8ecf3', font: '13px monospace'
    });
    const ext = document.createElement('span');
    ext.textContent = '.txt';
    ext.style.cssText = 'font-size:12px;color:#9aa6b8';
    nameRow.append(nameLabel, nameInput, ext);

    // "저장 시 위치 직접 선택"은 원래 결과 탭(viewer.html) 설정 안에만 있어 이 화면(빠른
    // 텍스트 바로 저장)에서는 찾기 어려웠다. 같은 저장소 키(saveAsDialog)를 여기서도
    // 바로 켜고 끌 수 있게 노출한다 — 동작(대화상자를 매번 띄울지 여부) 자체는 그대로.
    const saveAsRow = document.createElement('label');
    Object.assign(saveAsRow.style, {
      display: 'flex', alignItems: 'center', gap: '6px', padding: '0 16px 8px',
      fontSize: '12px', color: '#9aa6b8', cursor: 'pointer'
    });
    const saveAsChk = document.createElement('input');
    saveAsChk.type = 'checkbox';
    const saveAsTxt = document.createElement('span');
    saveAsTxt.textContent = '저장 시 위치 직접 선택 (파일 탐색기로 매번 고르기)';
    saveAsRow.append(saveAsChk, saveAsTxt);
    chrome.storage.local.get('saveAsDialog').then((o) => { saveAsChk.checked = !!o.saveAsDialog; });
    saveAsChk.addEventListener('change', () => {
      chrome.storage.local.set({ saveAsDialog: saveAsChk.checked });
    });

    const pre = document.createElement('textarea');
    pre.value = text;
    pre.readOnly = true;
    Object.assign(pre.style, {
      flex: '1', minHeight: '240px', margin: '6px 16px', padding: '10px',
      border: '1px solid #2c3444', borderRadius: '6px', background: '#12161f',
      color: '#e8ecf3',
      // 중국어 Noto Sans SC / 한국어 KoPub돋움체 / 영어 Helvetica를 기본 글꼴로 지정.
      // 브라우저가 글자 단위로 폴백하므로 한 텍스트에 세 언어가 섞여 있어도 각각
      // 지정한 글꼴로 표시된다(단, 해당 글꼴이 시스템에 설치돼 있을 때만 — 없으면
      // Malgun Gothic 등으로 자동 대체).
      font: '13px/1.6 "Noto Sans SC", "KoPub돋움체", "Helvetica", "Malgun Gothic", sans-serif',
      resize: 'none'
    });

    const foot = document.createElement('div');
    Object.assign(foot.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', padding: '10px 16px 14px' });
    const mkBtn = (txt, primary) => {
      const b = document.createElement('button');
      b.textContent = txt;
      Object.assign(b.style, {
        padding: '8px 16px', border: 'none', borderRadius: '7px', cursor: 'pointer',
        font: '13px "Malgun Gothic", sans-serif', fontWeight: '600',
        background: primary ? '#2f81f7' : '#384357', color: '#fff'
      });
      return b;
    };
    const cancelB = mkBtn('취소', false);
    const copyB = mkBtn('📋 복사', false);
    const saveB = mkBtn('💾 TXT 저장', true);
    foot.append(cancelB, copyB, saveB);

    box.append(head, nameRow, saveAsRow, pre, foot);
    back.appendChild(box);
    document.documentElement.appendChild(back);
    nameInput.focus();
    nameInput.select();

    // ESC가 아닌 다른 방법(취소/저장/배경 클릭)으로 닫을 때도 keydown 리스너가 반드시
    // 해제되도록 close() 자체에서 제거한다(이전에는 ESC 분기 안에서만 제거해 누수됨).
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    cancelB.addEventListener('click', close);
    copyB.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        copyB.textContent = '✅ 복사됨';
        setTimeout(() => { copyB.textContent = '📋 복사'; }, 1500);
      } catch (_) {
        pre.select(); document.execCommand && document.execCommand('copy');
        copyB.textContent = '✅ 복사됨';
        setTimeout(() => { copyB.textContent = '📋 복사'; }, 1500);
      }
    });
    saveB.addEventListener('click', () => {
      let name = (nameInput.value || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\.txt$/i, '') || textFileTag();
      close();
      doSaveText(text, name);
    });
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey, true);
  }

  function startTextSelect() {
    const highlight = document.createElement('div');
    Object.assign(highlight.style, {
      position: 'fixed', border: '2px solid #2ea043',
      background: 'rgba(46,160,67,.18)', zIndex: Z,
      pointerEvents: 'none', display: 'none', boxSizing: 'border-box',
      borderRadius: '3px'
    });
    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'fixed', background: '#2ea043', color: '#fff',
      font: '11px/1 monospace', padding: '3px 6px', borderRadius: '4px',
      zIndex: Z + 1, display: 'none', pointerEvents: 'none'
    });
    const toast = makeToast('저장할 텍스트 섹션 위에 마우스를 올리고 클릭하세요 — 글자 그대로 TXT로 저장됩니다 (ESC: 취소)');
    document.documentElement.appendChild(highlight);
    document.documentElement.appendChild(label);

    let current = null;

    // 일부 사이트(예: jjwxc 모바일)는 마우스로 텍스트를 드래그·복사하지 못하게
    // 본문 위에 투명 이미지(안티카피 오버레이)를 씌워 둔다. elementFromPoint()(단수)는
    // z-order상 그 오버레이만 잡아 늘 "텍스트 없음"으로 오판하게 되므로,
    // elementsFromPoint()(복수)로 클릭 지점의 요소들을 위에서부터 훑어
    // 실제 텍스트를 가진 첫 요소를 고른다. 텍스트 있는 요소가 하나도 없으면
    // (진짜 이미지/버튼 등) 기존처럼 맨 위 요소를 그대로 쓴다.
    const pickAt = (x, y) => {
      const stack = document.elementsFromPoint(x, y);
      const real = stack.filter((el) => el && el !== highlight && el !== label && el !== toast);
      return real.find((el) => (el.innerText || '').trim().length > 0) || real[0] || null;
    };

    const onMove = (e) => {
      const el = pickAt(e.clientX, e.clientY);
      if (!el) return;
      current = el;
      const r = el.getBoundingClientRect();
      Object.assign(highlight.style, {
        display: 'block',
        left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px'
      });
      label.style.display = 'block';
      const len = (el.innerText || '').trim().length;
      label.textContent = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} — 텍스트 ${len}자`;
      label.style.left = Math.max(0, r.left) + 'px';
      label.style.top = Math.max(0, r.top - 22) + 'px';
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!current) return;
      const text = extractCleanText(current);
      cancelSelection();
      if (!text) {
        const t = makeToast('선택한 요소에 텍스트가 없습니다.');
        setTimeout(() => t.remove(), 2000);
        return;
      }
      showTextPreview(text); // Listly식 미리보기 창을 띄운다
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);

    const onKey = (e) => { if (e.key === 'Escape') cancelSelection(); };
    document.addEventListener('keydown', onKey, true);

    ui = {
      elements: [highlight, label, toast],
      onKey,
      cleanup() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
      }
    };
  }

  // ---------- 모드 1: 드래그로 영역 지정 (가장자리에 닿으면 자동 스크롤) ----------
  function startDragSelect() {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: Z,
      cursor: 'crosshair', background: 'rgba(0,0,0,.12)'
    });
    // 선택 박스/라벨은 문서 좌표(absolute)로 그려서 스크롤해도 제자리에 붙어 있게 한다
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'absolute', border: '2px solid #2f81f7',
      background: 'rgba(47,129,247,.15)', zIndex: Z, display: 'none',
      pointerEvents: 'none', boxSizing: 'border-box', left: '0', top: '0'
    });
    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'absolute', background: '#2f81f7', color: '#fff',
      font: '11px/1 monospace', padding: '3px 6px', borderRadius: '4px',
      zIndex: Z + 1, display: 'none', pointerEvents: 'none'
    });
    const toast = makeToast('캡처할 영역을 드래그하세요 — 화면 아래/위 가장자리에 대면 자동 스크롤 (휠 스크롤 가능, ESC: 취소)');
    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(label);

    let startDoc = null;                 // 드래그 시작점 (문서 좌표)
    let lastClient = { x: 0, y: 0 };     // 마지막 마우스 위치 (뷰포트 좌표)
    let dragging = false;
    let rafId = 0;

    const curDoc = () => ({
      x: lastClient.x + window.scrollX,
      y: lastClient.y + window.scrollY
    });
    const norm = (a, b) => ({
      x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y)
    });

    function update() {
      if (!dragging) return;
      const r = norm(startDoc, curDoc());
      box.style.display = 'block';
      Object.assign(box.style, {
        left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px'
      });
      label.style.display = 'block';
      label.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}` +
        (r.h > window.innerHeight ? ' (스크롤 캡처)' : '');
      label.style.left = (r.x + 4) + 'px';
      label.style.top = Math.max(0, r.y - 22) + 'px';
    }

    // 가장자리 자동 스크롤 루프
    function autoScrollLoop() {
      if (dragging) {
        let dy = 0;
        if (lastClient.y > window.innerHeight - EDGE) {
          dy = Math.ceil((lastClient.y - (window.innerHeight - EDGE)) / 3) + 4;
        } else if (lastClient.y < EDGE && window.scrollY > 0) {
          dy = -(Math.ceil((EDGE - lastClient.y) / 3) + 4);
        }
        if (dy) { window.scrollBy(0, dy); update(); }
      }
      rafId = requestAnimationFrame(autoScrollLoop);
    }
    rafId = requestAnimationFrame(autoScrollLoop);

    const onScroll = () => update(); // 휠로 스크롤해도 박스가 따라오도록

    overlay.addEventListener('mousedown', (e) => {
      e.preventDefault();
      lastClient = { x: e.clientX, y: e.clientY };
      startDoc = curDoc();
      dragging = true;
      update();
    });
    overlay.addEventListener('mousemove', (e) => {
      lastClient = { x: e.clientX, y: e.clientY };
      if (dragging) update();
    });
    overlay.addEventListener('mouseup', (e) => {
      if (!dragging) return;
      dragging = false;
      lastClient = { x: e.clientX, y: e.clientY };
      finishSelection(norm(startDoc, curDoc()), startDragSelect);
    });
    window.addEventListener('scroll', onScroll, { passive: true });

    const onKey = (e) => { if (e.key === 'Escape') cancelSelection(); };
    document.addEventListener('keydown', onKey, true);

    ui = {
      elements: [overlay, box, label, toast],
      onKey,
      cleanup() {
        cancelAnimationFrame(rafId);
        window.removeEventListener('scroll', onScroll);
      }
    };
  }

  // ---------- 모드 2: 요소(섹션) 위에 올려서 클릭 ----------
  function startElementSelect() {
    const highlight = document.createElement('div');
    Object.assign(highlight.style, {
      position: 'fixed', border: '2px solid #e3742f',
      background: 'rgba(227,116,47,.18)', zIndex: Z,
      pointerEvents: 'none', display: 'none', boxSizing: 'border-box',
      borderRadius: '3px'
    });
    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'fixed', background: '#e3742f', color: '#fff',
      font: '11px/1 monospace', padding: '3px 6px', borderRadius: '4px',
      zIndex: Z + 1, display: 'none', pointerEvents: 'none'
    });
    const toast = makeToast('캡처할 섹션 위에 마우스를 올리고 클릭하세요 — 화면보다 긴 섹션도 전체 캡처됩니다 (ESC: 취소)');
    document.documentElement.appendChild(highlight);
    document.documentElement.appendChild(label);

    let current = null;

    const onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === highlight || el === label || el === toast) return;
      current = el;
      const r = el.getBoundingClientRect();
      Object.assign(highlight.style, {
        display: 'block',
        left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px'
      });
      label.style.display = 'block';
      label.textContent =
        el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '') +
        ` (${Math.round(r.width)} × ${Math.round(r.height)})`;
      label.style.left = Math.max(0, r.left) + 'px';
      label.style.top = Math.max(0, r.top - 22) + 'px';
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!current) return;
      const r = current.getBoundingClientRect();
      finishSelection({
        x: r.left + window.scrollX,
        y: r.top + window.scrollY,
        w: r.width,
        h: r.height
      }, startElementSelect);
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);

    const onKey = (e) => { if (e.key === 'Escape') cancelSelection(); };
    document.addEventListener('keydown', onKey, true);

    ui = {
      elements: [highlight, label, toast],
      onKey,
      cleanup() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
      }
    };
  }
})();
