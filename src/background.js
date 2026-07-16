// 백그라운드 서비스 워커 (Manifest V3):
// 콘텐츠 스크립트가 보내오는 조각들을 '세로 타일'로 이어붙여 완성되는 즉시
// IndexedDB(Blob)에 저장한다. 전체 장문 이미지를 메모리에 통째로 유지하지 않으므로
// 초대형 캡처에서도 메모리 사용량이 일정하게 유지된다.
// 구버전(단일 dataURL) 캡처와의 하위호환은 뷰어(viewer.js)에서 처리한다.
importScripts('tile-store.js');

const jobs = new Map();                 // tabId → 진행 중인 타일 캡처 작업
const MAX_CAPTURE_ITEMS = 240;          // 보관 캡처 상한 (저메모리 저장으로 확대)
const TILE_TARGET_BYTES = 32 * 1024 * 1024; // 타일 1장 목표 크기 (RGBA 기준)
const TILE_OVERLAP = 96;                // 타일 경계 겹침(px) — OCR 경계 문장 보호용

// 유효한 캡처 인덱스에 속하지 않는 고아 타일을 정리한다.
// (서비스 워커 강제 종료·업데이트 등으로 END까지 못 간 타일이 남을 수 있다.)
async function cleanupOrphanTiles() {
  try {
    const st = await chrome.storage.local.get('captureIndex');
    const validIds = new Set(
      (Array.isArray(st.captureIndex) ? st.captureIndex : []).map((x) => x && x.id).filter(Boolean)
    );
    // 아직 captureIndex에 등록되지 않은 '진행 중' 캡처의 타일도 유효로 취급해 정리에서 보호한다.
    for (const job of jobs.values()) validIds.add(job.captureId);
    const keys = await SCOStore.listKeys();
    const orphan = keys.filter((key) => {
      const id = String(key).split(':tile:')[0];
      return id && !validIds.has(id);
    });
    if (orphan.length) await SCOStore.deleteKeys(orphan);
  } catch (e) {
    console.warn('[SCO] 고아 타일 정리 실패', e);
  }
}

// 모든 고아 정리를 하나의 큐로 직렬화한다. onInstalled/onStartup/모듈 로드에서 각각 독립적으로
// 정리가 돌면, 한 정리가 유효 ID를 스냅샷한 뒤 새 캡처가 시작돼 그 타일을 지울 수 있다.
// 큐로 순차 실행하고, 메시지 처리는 큐가 빌 때까지 기다려 캡처가 정리와 겹치지 않게 한다.
let cleanupQueue = Promise.resolve();
function queueCleanup() {
  cleanupQueue = cleanupQueue.then(() => cleanupOrphanTiles(), () => cleanupOrphanTiles());
  return cleanupQueue;
}
chrome.runtime.onInstalled.addListener(() => { queueCleanup(); });
chrome.runtime.onStartup.addListener(() => { queueCleanup(); });
queueCleanup(); // 모듈 로드 시 1회

// 캡처 도중 탭을 닫으면 END/ABORT 메시지가 오지 않아 job이 jobs에 영원히 남고,
// 그 타일들이 고아 정리에서 계속 "진행 중"으로 보호돼 IndexedDB가 누적된다.
// 탭이 사라지면 해당 job을 즉시 폐기한다(추가 권한 불필요, url 등 민감정보 사용 안 함).
chrome.tabs.onRemoved.addListener((tabId) => { abortCapture(tabId).catch(() => {}); });
// 탭을 닫지 않고 다른 페이지로 이동하는 경우는 content.js의 pagehide 핸들러가
// SCO_CAP_ABORT를 보내 처리한다(webNavigation 권한을 새로 요구하지 않기 위함).

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  handle(msg, sender)
    .then((res) => sendResponse(res || { ok: true }))
    .catch((e) => {
      console.error('[SCO]', msg.type, e);
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });
  return true; // 비동기 응답
});

function requireTab(sender) {
  if (!sender.tab || sender.tab.id == null) {
    throw new Error('웹페이지 탭 정보가 없습니다. 캡처 페이지에서 다시 시도하세요.');
  }
  return sender.tab;
}

async function handle(msg, sender) {
  await cleanupQueue.catch(() => {}); // 대기 중인 모든 정리가 끝난 뒤에만 캡처를 받는다 (경쟁 방지)
  switch (msg.type) {
    case 'SCO_CAP_BEGIN': return beginCapture(msg, requireTab(sender));
    case 'SCO_CAP_SEG':   return captureSegment(msg, requireTab(sender));
    case 'SCO_CAP_END':   return endCapture(msg, requireTab(sender));
    case 'SCO_CAP_ABORT': return abortCapture(sender.tab && sender.tab.id);
    case 'SCO_OPEN_VIEWER':
      await chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
      return { ok: true };
    case 'SCO_SAVE_TEXT': return saveText(msg);
    default: return { ok: true };
  }
}

// ---------- 타일 기하 계산 ----------
function makeTileDescriptor(job, index) {
  const coreStart = index * job.tileCoreH;
  const coreEnd = Math.min(job.totalH, coreStart + job.tileCoreH);
  const storedStart = Math.max(0, coreStart - job.overlap);
  const storedEnd = Math.min(job.totalH, coreEnd + job.overlap);
  return {
    index,
    coreStart,
    coreHeight: Math.max(0, coreEnd - coreStart),
    storedStart,
    storedHeight: Math.max(1, storedEnd - storedStart),
    cropTop: coreStart - storedStart,   // 저장 타일 내부에서 core 영역이 시작하는 y
    width: job.totalW,
    key: `${job.captureId}:tile:${String(index).padStart(5, '0')}`
  };
}

async function ensureTile(job, index) {
  if (job.activeTiles.has(index)) return job.activeTiles.get(index);
  const meta = makeTileDescriptor(job, index);
  const canvas = new OffscreenCanvas(meta.width, meta.storedHeight);
  const ctx = canvas.getContext('2d', { alpha: false });

  // 이 타일이 이미 flush(저장)된 뒤 다시 세그먼트가 들어오는 경우(예: 페이지 넘김 캡처의
  // 같은 dstY 재시도)에는, 기존에 저장된 타일을 먼저 불러와 그 위에 이어 그린다.
  // 그렇지 않으면 빈 캔버스로 재생성돼 부분 재시도가 완성 타일을 덮어써 버린다(데이터 손실).
  // 이미 flush(저장)된 타일에 다시 세그먼트가 들어오면(예: 같은 dstY 재시도) 기존 타일을
  // 복원해 그 위에 이어 그린다. 복원 실패 시 빈 캔버스로 '폴백'하면 부분 조각이 완성 타일을
  // 덮어써 조용히 손실되므로, 폴백하지 않고 예외를 던져 캡처를 중단/재시도하게 한다(fail-closed).
  if (job.tileMeta[index]) {
    const blob = await SCOStore.getBlob(meta.key);
    if (!blob) throw new Error(`저장된 캡처 타일을 찾을 수 없습니다: ${meta.key}. 이 회차를 다시 시도하세요.`);
    let bmp;
    try {
      bmp = await createImageBitmap(blob);
      ctx.drawImage(bmp, 0, 0);
    } catch (e) {
      throw new Error(`저장된 캡처 타일을 복원하지 못했습니다: ${meta.key}: ${String((e && e.message) || e)}`);
    } finally {
      if (bmp) bmp.close();
    }
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const tile = { meta, canvas, ctx, flushed: false };
  job.activeTiles.set(index, tile);
  return tile;
}

// 타일을 PNG Blob으로 IndexedDB에 저장하고 메모리에서 해제한다.
async function flushTile(job, index) {
  const tile = job.activeTiles.get(index);
  if (!tile || tile.flushed) return;
  // 인코딩·저장이 모두 성공한 뒤에만 flushed 로 표시한다.
  // 도중에 실패하면 flushed=false 로 남겨 재시도/종료 단계에서 다시 저장하도록 하고,
  // 오류를 위로 전파해 불완전한 캡처가 성공으로 마무리되지 않게 한다.
  const blob = await tile.canvas.convertToBlob({ type: 'image/png' });
  await SCOStore.putBlob(tile.meta.key, blob);
  job.tileMeta[index] = { ...tile.meta, byteSize: blob.size };
  tile.flushed = true;
  job.activeTiles.delete(index); // 캔버스 참조 해제 → 메모리 회수
}

// 이미 다 그려진(coveredY 아래로 완전히 들어온) 타일을 즉시 flush한다.
async function flushReadyTiles(job) {
  const ready = [];
  for (const [index, tile] of job.activeTiles) {
    const storedEnd = tile.meta.storedStart + tile.meta.storedHeight;
    if (storedEnd <= job.coveredY + 0.5) ready.push(index);
  }
  ready.sort((a, b) => a - b);
  for (const index of ready) await flushTile(job, index);
}

async function beginCapture(msg, tab) {
  // 같은 탭에 미완료 job이 남아 있으면 그 타일부터 정리한다.
  if (jobs.has(tab.id)) await abortCapture(tab.id);

  const totalW = Math.max(1, Math.min(Math.round(Number(msg.totalW) || 1), 32000));
  const totalH = Math.max(1, Math.min(Math.round(Number(msg.totalH) || 1), 2000000));
  const overlap = Math.min(TILE_OVERLAP, Math.floor(totalH / 4));
  // 타일 1장이 목표 바이트를 넘지 않도록 core 높이를 정한다 (256~4096px).
  const budgetCore = Math.floor(TILE_TARGET_BYTES / Math.max(4, totalW * 4)) - overlap * 2;
  const tileCoreH = Math.max(256, Math.min(4096, budgetCore || 256));
  const captureId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  jobs.set(tab.id, {
    captureId,
    tabId: tab.id,
    windowId: tab.windowId,
    totalW,
    totalH,
    tileCoreH,
    overlap,
    activeTiles: new Map(),  // index → { meta, canvas, ctx }
    tileMeta: [],            // index → 저장 완료된 타일 메타
    coveredY: 0,             // 지금까지 그려진 최대 y
    meta: {
      pageUrl: msg.pageUrl || tab.url || '',
      pageTitle: msg.pageTitle || tab.title || '',
      chapterTitle: msg.chapterTitle || '',
      chapterKey: String(msg.chapterKey || ''),
      workId: String(msg.workId || ''),
      siteId: msg.siteId || 'generic',
      runId: msg.runId || '',
      dpr: Number(msg.dpr) || 1,
      part: Number(msg.part) || 1
    }
  });
  return { ok: true, captureId, tileCoreH };
}

async function captureSegment(msg, tab) {
  const job = jobs.get(tab.id);
  if (!job) throw new Error('캡처 세션이 없습니다. 서비스 워커가 재시작되었을 수 있으니 이 회차를 다시 시도하세요.');

  // captureVisibleTab은 지정 tabId가 아니라 '현재 활성 탭'을 촬영한다.
  // 사용자가 실수로 탭을 바꿔도 다른 화면이 섞이지 않도록 캡처 탭을 다시 활성화하고,
  // 활성화가 확인되지 않으면 엉뚱한 탭을 찍지 않도록 캡처를 중단한다(fail-closed).
  const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (!active.length || active[0].id !== tab.id) {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((r) => setTimeout(r, 150));
    const recheck = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (!recheck.length || recheck[0].id !== tab.id) {
      throw new Error('캡처 대상 탭을 활성화하지 못해 캡처를 중단했습니다. 대상 탭을 앞으로 두고 다시 시도하세요.');
    }
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const sx = Math.max(0, Math.min(Math.round(msg.srcX), bitmap.width - 1));
    const sy = Math.max(0, Math.min(Math.round(msg.srcY), bitmap.height - 1));
    const sw = Math.max(1, Math.min(Math.round(msg.srcW), bitmap.width - sx));
    const sh = Math.max(1, Math.min(Math.round(msg.srcH), bitmap.height - sy));
    const dstX = Math.max(0, Math.round(msg.dstX || 0));
    const dstY = Math.max(0, Math.round(msg.dstY || 0));
    const dstEnd = Math.min(job.totalH, dstY + sh);

    // 이 조각이 걸치는 타일 범위를 계산해 각 타일의 해당 부분에만 그린다.
    const first = Math.max(0, Math.floor((dstY - job.overlap) / job.tileCoreH));
    const last = Math.min(Math.ceil(job.totalH / job.tileCoreH) - 1,
      Math.floor((dstEnd + job.overlap - 1) / job.tileCoreH));

    for (let index = first; index <= last; index++) {
      const tile = await ensureTile(job, index);
      const tileStart = tile.meta.storedStart;
      const tileEnd = tileStart + tile.meta.storedHeight;
      const iy0 = Math.max(dstY, tileStart);
      const iy1 = Math.min(dstEnd, tileEnd);
      if (iy1 <= iy0) continue;
      const partH = iy1 - iy0;
      const sourceY = sy + (iy0 - dstY);
      tile.ctx.drawImage(bitmap, sx, sourceY, sw, partH, dstX, iy0 - tileStart, sw, partH);
    }

    job.coveredY = Math.max(job.coveredY, dstEnd);
    await flushReadyTiles(job);

    // 페이지 넘김 캡처용 지문(해시): 이전 장과 같으면 콘텐츠 스크립트가 마지막 페이지로 판단.
    let hash;
    if (msg.wantHash) {
      const hc = new OffscreenCanvas(32, 32);
      const hctx = hc.getContext('2d', { willReadFrequently: true });
      hctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, 32, 32);
      const d = hctx.getImageData(0, 0, 32, 32).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 4) {
        h ^= d[i]; h = Math.imul(h, 16777619);
        h ^= d[i + 1]; h = Math.imul(h, 16777619);
        h ^= d[i + 2]; h = Math.imul(h, 16777619);
      }
      hash = (h >>> 0).toString(36);
    }
    return { ok: true, hash, coveredY: job.coveredY };
  } finally {
    bitmap.close();
  }
}

async function endCapture(msg, tab) {
  const job = jobs.get(tab.id);
  if (!job) throw new Error('캡처 세션이 없습니다.');

  // 이 캡처가 쓴 모든 타일 키(저장 완료 + 아직 활성)를 모아 실패 시 롤백에 쓴다.
  const allJobKeys = () => new Set([
    ...job.tileMeta.filter(Boolean).map((t) => t.key),
    ...[...job.activeTiles.values()].map((t) => t.meta.key)
  ]);

  let item, removed;
  try {
    // 실제로 사용된 높이만 확정 (페이지 넘김 캡처는 예상보다 짧을 수 있다).
    // 단, 실제로 그려진 영역(coveredY)을 넘어서는 usedH는 신뢰하지 않는다(존재하지 않는 타일 요구 방지).
    let finalH = Math.max(1, Math.min(job.totalH, Math.round(Number(msg.usedH) || job.coveredY || job.totalH)));
    if (job.coveredY > 0) finalH = Math.min(finalH, job.coveredY);

    // 남은 활성 타일을 모두 저장. 실패하면 예외가 전파돼 아래 catch에서 롤백된다.
    for (const index of [...job.activeTiles.keys()].sort((a, b) => a - b)) await flushTile(job, index);

    // finalH 아래로 잘려 쓰이지 않는 타일의 Blob을 IndexedDB에서 제거.
    const removeKeys = [];
    for (let i = 0; i < job.tileMeta.length; i++) {
      const t = job.tileMeta[i];
      if (t && t.coreStart >= finalH) removeKeys.push(t.key);
    }
    if (removeKeys.length) await SCOStore.deleteKeys(removeKeys).catch(() => {});

    // finalH를 덮는 타일 0..N-1이 빠짐없이 저장돼 있는지 검증. 하나라도 없으면 등록하지 않는다.
    const expectedCount = Math.max(1, Math.ceil(finalH / job.tileCoreH));
    const tiles = [];
    for (let i = 0; i < expectedCount; i++) {
      const t = job.tileMeta[i];
      if (!t || t.coreStart >= finalH) throw new Error(`캡처가 불완전합니다(타일 ${i} 누락). 이 회차를 다시 시도하세요.`);
      if (!(await SCOStore.hasKey(t.key))) throw new Error(`캡처 타일이 저장되지 않았습니다(${t.key}). 이 회차를 다시 시도하세요.`);
      tiles.push({
        ...t,
        coreHeight: Math.max(1, Math.min(t.coreHeight, finalH - t.coreStart)),
        validStoredHeight: Math.max(1, Math.min(t.storedHeight, finalH - t.storedStart))
      });
    }

    item = {
      id: job.captureId,
      storageMode: 'tiles-v1',
      tiles,
      width: job.totalW,
      height: finalH,
      capturedAt: new Date().toISOString(),
      ...job.meta
    };

    const st = await chrome.storage.local.get('captureIndex');
    let index = Array.isArray(st.captureIndex) ? st.captureIndex : [];
    index.unshift(indexEntry(item));
    removed = index.slice(MAX_CAPTURE_ITEMS);
    index = index.slice(0, MAX_CAPTURE_ITEMS);

    await chrome.storage.local.set({
      captureIndex: index,
      ['capture_' + item.id]: item,
      lastCapture: item // 팝업 "마지막 캡처 열기" 호환용 (타일 메타만 저장 — 대용량 아님)
    });
  } catch (e) {
    // 실패: 이 캡처가 쓴 타일을 모두 정리(롤백)한 뒤 job을 폐기하고 오류를 전파한다.
    await SCOStore.deleteKeys([...allJobKeys()]).catch(() => {});
    jobs.delete(tab.id);
    throw e;
  }

  // 성공적으로 durable 저장·등록된 뒤에만 job을 제거한다.
  jobs.delete(tab.id);

  // 이 시점부터는 새 캡처가 이미 durable하게 저장된 뒤이므로, 이후 단계(밀려난 예전 캡처
  // 정리, 뷰어 열기)에서 실패가 나도 "캡처 실패"로 보고하지 않는다.
  for (const old of removed) {
    await deleteCaptureData(old.id).catch((e) => console.warn('[SCO] 예전 캡처 정리 실패', old.id, e));
  }

  if (msg.openViewer !== false) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') }).catch((e) => console.warn('[SCO] 뷰어 열기 실패', e));
  }
  return { ok: true, captureId: item.id, item: indexEntry(item) };
}

// 인덱스에는 화면 목록에 필요한 가벼운 메타만 담는다 (타일 데이터는 IndexedDB에).
function indexEntry(item) {
  return {
    id: item.id,
    capturedAt: item.capturedAt,
    pageUrl: item.pageUrl, // 일괄 다운로드의 도메인+작품번호 자동 묶음에 사용
    pageTitle: item.pageTitle,
    chapterTitle: item.chapterTitle,
    chapterKey: item.chapterKey,
    workId: item.workId,
    siteId: item.siteId,
    runId: item.runId,
    part: item.part,
    width: item.width,
    height: item.height,
    storageMode: item.storageMode,
    tileCount: item.tiles ? item.tiles.length : 0
  };
}

async function abortCapture(tabId) {
  if (tabId == null) return { ok: true };
  const job = jobs.get(tabId);
  jobs.delete(tabId);
  if (job) {
    const keys = [
      ...job.tileMeta.filter(Boolean).map((t) => t.key),
      ...[...job.activeTiles.values()].map((t) => t.meta.key)
    ];
    await SCOStore.deleteKeys(keys).catch(() => {});
  }
  return { ok: true };
}

// 캡처 하나의 저장 데이터(타일 Blob + storage 항목)를 모두 제거.
async function deleteCaptureData(id) {
  const key = 'capture_' + id;
  const data = await chrome.storage.local.get(key);
  const cap = data[key];
  if (cap && Array.isArray(cap.tiles)) {
    await SCOStore.deleteKeys(cap.tiles.map((t) => t.key)).catch(() => {});
  }
  await chrome.storage.local.remove([key, 'ocrCache_' + id, 'visionState_' + id]);
}

// ---------- 텍스트 바로 저장 (뷰어의 저장 위치 설정 반영) ----------
async function saveText(msg) {
  const bytes = new TextEncoder().encode('﻿' + (msg.text || ''));
  const dataUrl = 'data:text/plain;charset=utf-8;base64,' + arrayBufferToBase64(bytes.buffer);
  // 뷰어와 동일한 저장 위치 설정 적용 (하위 폴더 + Save As 대화상자)
  const cfg = await chrome.storage.local.get(['saveSubfolder', 'saveAsDialog']);
  let fname = msg.filename || 'text.txt';
  const sub = String(cfg.saveSubfolder || '').trim()
    .replace(/[<>:"|?*]/g, '_').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (sub) fname = sub + '/' + fname;
  const id = await chrome.downloads.download({
    url: dataUrl,
    filename: fname,
    conflictAction: 'uniquify',
    saveAs: !!cfg.saveAsDialog
  });
  const result = await waitForDownload(id);
  if (!result.ok) throw new Error(result.error);
  return result;
}

async function waitForDownload(id) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(async () => {
      const [item] = await chrome.downloads.search({ id });
      if (item && item.state === 'complete') {
        clearInterval(timer); resolve({ ok: true, path: item.filename });
      } else if (item && item.state === 'interrupted') {
        clearInterval(timer); resolve({ ok: false, error: '다운로드 중단됨: ' + (item.error || '원인 불명') });
      } else if (Date.now() - t0 > 15000) {
        // 저장 대화상자 응답 대기 등으로 완료 확인이 늦어질 뿐 실패는 아닐 수 있으나,
        // 실제로 완료됐는지 확인되지 않은 상태를 성공(ok:true)으로 보고하면 저장되지
        // 않은 파일을 저장된 것으로 오인시킬 수 있다. 미확인 상태를 그대로 전달한다.
        clearInterval(timer);
        resolve({ ok: false, unknown: true, error: '저장 완료를 확인하지 못했습니다(시간 초과). 다운로드 항목을 직접 확인하세요.' });
      }
    }, 300);
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
