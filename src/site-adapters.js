// 사이트별 어댑터: 본문 컨테이너 / 회차 정보 / 회차 제목 / 다음 화 URL 규칙.
// 사이트 UI가 바뀌면 이 파일의 해당 항목만 수정하면 된다.
(function (root) {
  'use strict';
  if (root.SCOAdapters) return;

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) return false;
    // getBoundingClientRect는 visibility:hidden/opacity:0 요소도 크기를 그대로 반환하므로
    // 화면에 실제로 보이지 않는 숨은 복제 컨테이너(레이지로드 자리표시자 등)를
    // 본문/다음버튼으로 잘못 고르지 않도록 계산된 스타일도 함께 확인한다.
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  const firstVisible = (selectors) => {
    for (const sel of selectors) {
      try {
        for (const el of document.querySelectorAll(sel)) if (visible(el)) return el;
      } catch (_) {}
    }
    return null;
  };
  // 제목 끝의 "- 사이트명"류 접미사만 제거한다. 첫 구분자에서 자르면
  // "3-1화 특별편 - 소설사이트"처럼 본문에 하이픈이 있는 흔한 한국 웹소설 제목이
  // 첫 하이픈에서 잘려나가 화 제목이 통째로 사라진다. 마지막 구분자 이후만 제거되도록
  // [^-_|｜]*$ 로 앵커링한다.
  const titleFallback = () =>
    clean(document.title).replace(/\s*[-_|｜][^-_|｜]*$/, '').slice(0, 60);

  const adapters = [
    {
      id: 'jjwxc', navMode: 'url',
      match: (host) => /(^|\.)jjwxc\.net$/i.test(host),
      chapterInfo() {
        const n = /[?&]novelid=(\d+)/.exec(location.href);
        const c = /[?&]chapterid=(\d+)/.exec(location.href);
        if (!n || !c) return null;
        return { workId: n[1], chapterKey: c[1], number: Number(c[1]) };
      },
      contentElement() {
        return firstVisible(['#oneboolt', '.noveltext', '[class*="novel"]']);
      },
      chapterTitle() {
        // jjwxc 문서 제목: 《작품명》작가 ^第20章^ ... → ^...^ 부분이 회차 제목
        const m = /\^([^^]{1,40})\^/.exec(document.title);
        if (m) return clean(m[1]);
        const el = firstVisible(['.noveltitle', 'h2']);
        return clean(el && el.textContent) || titleFallback();
      },
      nextUrl() {
        const info = this.chapterInfo();
        if (!info) return '';
        return location.href.replace(/([?&]chapterid=)\d+/, `$1${info.number + 1}`);
      }
    },
    {
      id: 'qidian', navMode: 'url',
      match: (host) => /(^|\.)(qidian|qdmm)\.com$/i.test(host),
      chapterInfo() {
        const m = /\/chapter\/(\d+)\/(\d+)/.exec(location.pathname);
        return m ? { workId: m[1], chapterKey: m[2], number: null } : null;
      },
      contentElement() {
        return firstVisible(['.read-content', '#chapterContent', '.main-text-wrap', '[class*="chapter-content"]']);
      },
      chapterTitle() {
        const el = firstVisible(['.j_chapterName', '.chapter-name', 'h1']);
        return clean(el && el.textContent) || titleFallback();
      },
      nextUrl() {
        const el = firstVisible(['#j_chapterNext', 'a.j_chapterNext', 'a[rel="next"]', 'a[class*="next"][href*="/chapter/"]']);
        return (el && el.href) || '';
      }
    },
    {
      id: 'kakao', navMode: 'scroll',
      match: (host) => /(^|\.)page\.kakao\.com$/i.test(host),
      chapterInfo() {
        const m = /\/content\/(\d+)(?:\/viewer\/(\d+))?/.exec(location.pathname);
        return m ? { workId: m[1], chapterKey: m[2] || '', number: null } : null;
      },
      contentElement() { return null; }, // SPA 뷰어 — 기존 구간 방식 사용
      chapterTitle() { return titleFallback(); },
      nextUrl() { return ''; } // 페이지 이동이 아니라 화살표 클릭 방식
    },
    {
      id: 'generic', navMode: 'scroll',
      match: () => true,
      chapterInfo() { return null; },
      contentElement() { return firstVisible(['article', 'main', '[role="main"]']); },
      chapterTitle() { return titleFallback(); },
      nextUrl() {
        const el = firstVisible(['a[rel="next"]']);
        return (el && el.href) || '';
      }
    }
  ];

  function detect() {
    const host = location.hostname;
    for (const a of adapters) {
      try { if (a.match(host)) return a; } catch (_) {}
    }
    return adapters[adapters.length - 1];
  }

  root.SCOAdapters = Object.freeze({ detect });
})(typeof self !== 'undefined' ? self : globalThis);
