// 팝업: 선택 모드를 골라 현재 탭에 선택 오버레이(content.js)를 주입한다.

const errEl = document.getElementById('err');

function showError(msg) {
  errEl.textContent = msg;
  errEl.style.display = 'block';
}

async function startSelection(mode) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      showError('활성 탭을 찾을 수 없습니다.');
      return;
    }
    if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
      showError('이 페이지(브라우저 내부 페이지)에서는 캡처할 수 없습니다. 일반 웹 페이지에서 사용해 주세요.');
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['site-adapters.js', 'content.js']
    });
    await chrome.tabs.sendMessage(tab.id, { type: 'SCO_START_SELECTION', mode });
    window.close();
  } catch (e) {
    showError('시작 실패: ' + (e && e.message ? e.message : e));
  }
}

document.getElementById('dragMode').addEventListener('click', () => startSelection('drag'));
document.getElementById('elementMode').addEventListener('click', () => startSelection('element'));
document.getElementById('textMode').addEventListener('click', () => startSelection('text'));
document.getElementById('pagedMode').addEventListener('click', () => startSelection('paged'));

document.getElementById('openLast').addEventListener('click', async () => {
  const { lastCapture } = await chrome.storage.local.get('lastCapture');
  if (!lastCapture) {
    showError('저장된 캡처가 없습니다. 먼저 영역을 캡처해 주세요.');
    return;
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
  window.close();
});
