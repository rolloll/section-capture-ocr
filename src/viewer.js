// 뷰어 페이지: 캡처 이미지 표시, PNG/JPG 저장, OCR 실행, TXT 저장.

const $ = (id) => document.getElementById(id);
let capture = null;      // 현재 표시 중인 캡처
let captureIndex = [];   // 저장된 캡처 목록 (최신순)
let ocrDone = false;
// 현재 텍스트의 출처 — 파일명 접미사용
// 'local'(로컬 OCR, 접미사 없음) | 'fixed'(로컬+AI 교정, _fix) | 'vision'(AI 비전 OCR, _AI)
let textSource = 'local';
let rawOcrText = '';      // 후처리 전 OCR 원문 (비교용)
let rawView = false;      // 현재 원문을 표시 중인지
let correctedCache = '';  // 원문 보기 중 잠시 보관하는 교정본
let lastVision = null;    // 최근 비전 OCR 상태 (실패 타일 재실행용)
let previewObjectUrls = []; // 타일 미리보기용 objectURL (표시 갱신 시 해제)

// OCR/AI교정/AI비전OCR/실패타일 재실행이 진행되는 동안 캡처 전환·삭제를 막는 잠금.
// (이전에는 이 보호가 없어, 실행 중 다른 캡처로 전환하면 결과가 엉뚱한 캡처의
// OCR 캐시/비전 상태에 저장되거나, 진행 중이던 비전 OCR이 null 참조로 죽어
// 이미 인식한 타일과 API 비용이 통째로 날아가는 문제가 있었다.)
let busyOp = false;
function setBusyOp(v) {
  busyOp = v;
  const capSel = $('capSel'), capDel = $('capDel'), capDelAll = $('capDelAll');
  if (capSel) capSel.disabled = v;
  if (capDel) capDel.disabled = v;
  if (capDelAll) capDelAll.disabled = v;
}

// 실제 존재하는 API 모델만 사용한다. 가격(USD/1M tokens)은 추정치 — 공식 콘솔에서 확인.
// Sonnet 5는 2026-08-31까지 도입가($2/$10), 이후 정가($3/$15).
const SONNET5_INTRO = new Date() < new Date('2026-09-01T00:00:00Z');
const AI_MODELS = {
  anthropic: [
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — 빠름/저렴', inC: 1, outC: 5 },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — 권장', inC: SONNET5_INTRO ? 2 : 3, outC: SONNET5_INTRO ? 10 : 15 },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — 고정밀', inC: 5, outC: 25 }
  ],
  openai: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini — 빠름/저렴', inC: 0.15, outC: 0.6 },
    { id: 'gpt-4o', label: 'GPT-4o — 고정밀', inC: 2.5, outC: 10 }
  ]
};

function selectedModel() {
  const list = AI_MODELS[$('aiProvider').value] || [];
  return list.find((m) => m.id === $('aiModel').value) || list[0];
}

function populateModelSelect(preferId) {
  const list = AI_MODELS[$('aiProvider').value] || [];
  const sel = $('aiModel');
  sel.innerHTML = '';
  for (const m of list) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    sel.appendChild(o);
  }
  if (preferId && list.some((m) => m.id === preferId)) sel.value = preferId;
  updateCostEstimate();
}

// 대략적 비용 추정: 중국어는 1자≈1토큰, 비전은 타일당 입력 약 1300토큰으로 계산
function updateCostEstimate() {
  const el = $('aiCost');
  if (!el) return;
  const m = selectedModel();
  if (!m) { el.textContent = ''; return; }
  const chars = ($('ocrText').value || '').length ||
    Math.round(((capture && capture.height) || 8000) / 28) * 30; // 텍스트가 없으면 이미지 높이로 추정
  const textUsd = (chars * m.inC + chars * m.outC) / 1e6;
  const tiles = Math.max(1, Math.ceil(((capture && capture.height) || 1300) / 1300));
  const visionUsd = (tiles * 1300 * m.inC + chars * m.outC) / 1e6;
  const fmt = (usd) => `$${usd.toFixed(3)}(약 ${Math.max(1, Math.round(usd * 1400))}원)`;
  el.textContent = `예상 비용(추정): AI 교정 ≈ ${fmt(textUsd)} · AI 비전 OCR ≈ ${fmt(visionUsd)} — ${m.id}`;
}

// OCR 원문 기록 + 비교 UI 상태 갱신
function setRawText(t) {
  rawOcrText = (t || '').trim();
  rawView = false;
  correctedCache = '';
  const ta = $('ocrText');
  ta.readOnly = false;
  $('toggleRaw').textContent = '🔁 원문 보기';
  $('toggleRaw').disabled = !rawOcrText;
  if ($('compareRaw')) $('compareRaw').disabled = !rawOcrText;
  if ($('ocrRaw')) $('ocrRaw').value = rawOcrText; // 나란히 비교 창 동기화
}

// ---------- 캡처별 OCR 결과 캐시 (재실행 없이 지난 결과 복원) ----------
async function cacheOcrResult(capId) {
  if (!capId) return;
  await chrome.storage.local.set({
    ['ocrCache_' + capId]: {
      text: $('ocrText').value, raw: rawOcrText, source: textSource, at: Date.now()
    }
  });
}

async function restoreOcrCache(capId) {
  if (!capId) return false;
  const key = 'ocrCache_' + capId;
  const o = await chrome.storage.local.get(key);
  if (capId !== (capture && capture.id)) return false; // 그 사이 다른 캡처로 전환됨 — 늦은 덮어쓰기 방지
  const c = o[key];
  if (!c || !c.text) return false;
  textSource = c.source || 'local';
  setRawText(c.raw || c.text);
  $('ocrText').value = c.text;
  ocrDone = true; // 복원된 결과도 이후 수동 편집이 캐시에 반영되도록 (fix)
  const has = c.text.trim().length > 0;
  $('saveTxt').disabled = !has;
  $('copyTxt').disabled = !has;
  const when = c.at ? new Date(c.at).toLocaleString('ko-KR') : '';
  setStatus(`💾 이 캡처의 지난 OCR 결과를 불러왔습니다 (${when}). 다시 인식하려면 OCR 버튼을 누르세요.`);
  return true;
}

// ---------- 교정 규칙 (공통[언어별] + 작품별 프로필) ----------
// 공통 규칙은 언어별로 나눠 저장한다: 中文 / 한국어 / English.
// OCR 언어로 선택된 언어의 공통 규칙만 적용되므로, 언어 간 오적용이 없다.
const GLOBAL_LANGS = ['chi', 'kor', 'eng'];
const GLOBAL_LANG_LABEL = { chi: '中文(간체)', kor: '한국어', eng: 'English' };

const DEFAULT_GLOBAL_RULES_CHI = `# 중국어 공통 혼동 — 한 줄에 하나씩 「잘못=올바름」. #은 주석.
吧了=吃了
吧的=吃的
吧药=吃药
吧得=吃得
委届=委屈
芳动=劳动
秀动=劳动
束行了=就行了
融行了=就行了
糖桨=糖浆
污染移语=污言秽语
欲言又目=欲言又止
一雷三分地=一亩三分地
不三不淡=不咸不淡
党得=觉得
皇么=怎么
尾么了=怎么了
枇杷吝=枇杷膏
枇杷高=枇杷膏
话异=诡异
府异=讶异
震颜=震颤
碎有裂=碎裂
甚全竞得=甚至觉得
干兆=干净
狂不及防=猝不及防
鸣咽=呜咽
糟糙=糟糕
震耳欲仪=震耳欲聋
后知后党=后知后觉
心神不于=心神不宁
电辟下=电劈下
突元地=突兀地
牌斜着=歪斜着
亨熬=煎熬
粳糕=糟糕
澳散=溃散
厅烦=麻烦
虹缩=蜷缩
贱缩=蜷缩
晓缩=蜷缩
发拌=发抖
冬巧=乖巧
投盐=撒盐
目信=自信
咬死牙冠=咬死牙关
被村舍=被夺舍
帮弯=掰弯
去而所=去厕所
自我凑迟=自我凌迟
心头募地=心头蓦地
心头莫地=心头蓦地`;

const DEFAULT_GLOBAL_RULES_KOR = `# 한국어 공통 혼동 — 한 줄에 하나씩 「잘못=올바름」. #은 주석.
굴주린=굶주린
굴주림=굶주림
지굿지긋=지긋지긋
이령게=이렇게
않겠는개=않겠는가
하시만=하지만
나았시만=나았지만
삐둘어=삐뚤어
순가락=숟가락
젖가락=젓가락
맡며느리=맏며느리
나뉘주었=나눠주었
나뉘 먹=나눠 먹
소카=조카
낮선=낯선
아홈=아홉
한못=한몫
가몸=가뭄
굽어 죽을=굶어 죽을
위로금소차=위로금조차
질게 드리=짙게 드리
이욕고=이윽고
동그렇게=동그랗게
고개소차=고개조차
몸소리가 필요=몸조리가 필요
씩우려면=씌우려면
식은따=식은땀
후날=훗날
황사들=황자들
병품=병풍
흰싸=휩싸
눈썸=눈썹
실폐=실례
뮤사=묘사
오삭해=오싹해
넘몰=넘볼
얄본다=얕본다
신봇감=신붓감
흠첫=흠칫
암전하기=얌전하기
정신이 벅 들어=정신이 번쩍 들어
두럽다=두렵다
꾸찾었다=꾸짖었다
붐어져=뿜어져
톨보마=돌보마
숫구쳐=솟구쳐
느켰다=느꼈다
이욱고=이윽고
이음고=이윽고
어펄 수=어쩔 수
까다롬고=까다롭고
도작했=도착했
마중 나을=마중 나올
이령듯=이렇듯`;

const DEFAULT_GLOBAL_RULES_ENG = `# English 공통 혼동 — 한 줄에 하나씩 「wrong=right」. #은 주석.`;

const DEFAULT_GLOBAL_BY_LANG = {
  chi: DEFAULT_GLOBAL_RULES_CHI,
  kor: DEFAULT_GLOBAL_RULES_KOR,
  eng: DEFAULT_GLOBAL_RULES_ENG
};

// 첫 실행 시 만들어지는 예시 프로필 (사용법 안내용 — 자유롭게 수정/삭제)
const EXAMPLE_PROFILE_RULES = `# 이 작품에서만 적용되는 규칙 (주로 인명)
贺人尘=贺尘
人尘哥=尘哥
贺侍=贺尘
咒侍=贺尘
咒尘=贺尘
锅尘=贺尘
锅侍=贺尘`;

const rulesState = {
  globalByLang: { ...DEFAULT_GLOBAL_BY_LANG }, // { chi, kor, eng } 언어별 공통 규칙
  editingLang: 'chi',                           // 공통 규칙 편집 중인 언어
  profiles: [],
  currentId: ''
};

function parseRules(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      if (i < 1) return null;
      return [l.slice(0, i), l.slice(i + 1)];
    })
    .filter(Boolean);
}

function applyRules(text, rules) {
  for (const [from, to] of rules) text = text.split(from).join(to);
  return text;
}

const currentProfile = () =>
  rulesState.profiles.find((p) => p.id === rulesState.currentId) || null;

// 현재 표시 중인 캡처(capture.pageUrl)에 맞는 작품별 규칙 프로필을 찾아 rulesState.currentId를
// 갱신한다. 이전에는 initRules()에서 최초 1회만 이 매칭을 수행하고 캡처 전환 시 다시
// 평가하지 않아서, 서로 다른 소설의 캡처를 섞어 두면 계속 처음 캡처의 프로필(교정 규칙·
// 용어집)이 다른 소설에도 잘못 적용됐다. 캡처를 바꿀 때마다 다시 호출해야 한다.
// 식별자로 판별이 안 되면(제너릭 사이트 등) 현재 선택을 그대로 유지한다.
function autoSelectProfileForCapture() {
  const url = (capture && capture.pageUrl) || '';
  if (!url) return;
  const hit = rulesState.profiles.find((p) => profileMatchesUrl(p, url));
  if (hit) { rulesState.currentId = hit.id; return; }
  const match = guessMatchFromUrl(url);
  if (!match) return; // 판별 불가 — 마지막 선택 유지
  const existing = rulesState.profiles.find((p) => p.match === match);
  if (existing) { rulesState.currentId = existing.id; return; }
  // 처음 보는 작품 식별자 → 프로필 자동 생성
  const title = ((capture && capture.pageTitle) || '').trim();
  const p = {
    id: 'p' + Date.now(),
    name: title ? title.slice(0, 40) : match,
    match,
    rules: '# 이 작품에서만 적용되는 규칙 (주로 인명)\n'
  };
  rulesState.profiles.push(p);
  rulesState.currentId = p.id;
  persistRules();
  setStatus(`새 작품 프로필이 자동 생성되었습니다: "${p.name}" (${match})`);
}

// ---------- 용어집 (원문↔교정 표기, 작품별, 이 기기에 저장) ----------
const glossaryState = new Map(); // profileId -> [{s, t}]
const GLOSS_SOURCE_HDR = ['원문', '원본', 'source', 'from', '중국어', '원어', '잘못', 'wrong', 'ocr'];
const GLOSS_TARGET_HDR = ['교정', '번역', '한국어', '표기', 'target', 'to', 'correct', '올바름', '정답'];

function currentGlossary() {
  return glossaryState.get(rulesState.currentId) || [];
}

async function loadGlossaryFor(id) {
  if (!id) return [];
  if (glossaryState.has(id)) return glossaryState.get(id);
  const key = 'ocrGlossary_' + id;
  const o = await chrome.storage.local.get(key);
  const list = Array.isArray(o[key]) ? o[key] : [];
  glossaryState.set(id, list);
  return list;
}

async function saveGlossaryFor(id, list) {
  if (!id) return;
  glossaryState.set(id, list);
  await chrome.storage.local.set({ ['ocrGlossary_' + id]: list });
}

function renderGlossStat() {
  const el = $('glossStat');
  if (!el) return;
  const prof = currentProfile();
  if (!prof) { el.textContent = '용어집은 작품을 선택해야 사용할 수 있습니다. 위에서 작품을 고르세요.'; return; }
  const g = currentGlossary();
  el.textContent = g.length
    ? `📗 용어집 ${g.length}개 항목이 「${prof.name}」에 적용 중입니다. (예: ${g.slice(0, 3).map((e) => `${e.s}→${e.t}`).join(', ')}${g.length > 3 ? ' …' : ''})`
    : '용어집이 비어 있습니다. 표의 두 열(원문·교정 표기)을 가져오면 이 작품에 자동 적용됩니다.';
}

// 한 셀이 원문/교정 헤더 후보인지 판정.
// 짧고 흔한 영어 별칭(to·from·source·target·ocr)은 부분일치로 하면 일반 낱말
// (Tokyo·Stone·Fromage 등)을 헤더로 오인하므로 '정확 일치'만 인정한다.
// 나머지(원문·중국어·correct 등)는 'correction' 같은 파생형을 잡도록 부분일치를 유지.
const GLOSS_EXACT_HDR = new Set(['to', 'from', 'source', 'target', 'ocr']);
function headerMatch(v, aliases) {
  const w = String(v || '').trim().toLowerCase();
  if (!w) return false;
  return aliases.some((h) => {
    const a = h.toLowerCase();
    return GLOSS_EXACT_HDR.has(a) ? w === a : w.includes(a);
  });
}
function isSourceHeader(v) { return headerMatch(v, GLOSS_SOURCE_HDR); }
function isTargetHeader(v) { return headerMatch(v, GLOSS_TARGET_HDR); }
function isAnyHeader(v) { return isSourceHeader(v) || isTargetHeader(v); }

// 표 rows에서 원문/교정 두 열을 골라 [{s,t}]로 변환.
// allowHeaderless=true(단일 CSV/TSV)면 헤더가 없을 때 1·2열을 사용하고,
// 아니면(XLSX 시트) 첫 10~20행에서 원문/교정 헤더쌍을 탐색해 그 아래부터만 추출한다.
function glossaryFromRows(rows, allowHeaderless) {
  if (!rows || !rows.length) return [];
  let srcCol = -1, tgtCol = -1, headerRow = -1;
  const scan = Math.min(rows.length, 20); // 첫 20행 안에서 헤더 탐색
  for (let i = 0; i < scan; i++) {
    const cells = rows[i] || [];
    let s = -1, t = -1;
    for (let c = 0; c < cells.length; c++) {
      if (s < 0 && isSourceHeader(cells[c])) s = c;
      else if (t < 0 && isTargetHeader(cells[c])) t = c;
    }
    if (s >= 0 && t >= 0) { srcCol = s; tgtCol = t; headerRow = i; break; }
  }
  let start;
  if (headerRow >= 0) { start = headerRow + 1; }        // 헤더 발견 → 그 다음 행부터
  else if (allowHeaderless) { srcCol = 0; tgtCol = 1; start = 0; } // CSV/TSV 헤더 없음 허용
  else return [];                                        // XLSX 시트에 헤더 없으면 건너뜀

  const out = [];
  const seen = new Set();
  for (let i = start; i < rows.length; i++) {
    const from = String((rows[i] || [])[srcCol] || '').trim();
    const to = String((rows[i] || [])[tgtCol] || '').trim();
    if (!from || !to || from === to || seen.has(from)) continue;
    if (isAnyHeader(from) || isAnyHeader(to)) continue;  // 반복 헤더 행 제외
    if (from.length > 20 || to.length > 30) continue;    // 안내문·문장 행 제외
    seen.add(from);
    out.push({ s: from, t: to });
  }
  return out;
}

// 주어진 용어집 목록으로 치환 (긴 원문부터 치환해 부분일치 문제를 줄인다)
function applyGlossaryWith(text, gloss) {
  if (!gloss || !gloss.length) return text;
  const sorted = [...gloss].sort((a, b) => b.s.length - a.s.length);
  for (const { s, t } of sorted) text = text.split(s).join(t);
  return text;
}
// 용어집 적용: 현재 선택된 작품 기준 (단일 캡처 경로용)
function applyGlossary(text) {
  return applyGlossaryWith(text, currentGlossary());
}

// 현재 OCR 언어 선택에 해당하는 공통 규칙 언어 목록. 아무것도 안 켜졌으면 전부 적용.
function activeGlobalLangs() {
  const langs = [];
  if ($('langChi') && $('langChi').checked) langs.push('chi');
  if ($('langKor') && $('langKor').checked) langs.push('kor');
  if ($('langEng') && $('langEng').checked) langs.push('eng');
  return langs.length ? langs : GLOBAL_LANGS.slice();
}

// 선택 언어의 공통 규칙 → 주어진 작품 규칙 순서로 합친다
function effectiveRulesForProfile(prof) {
  const rules = [];
  for (const lang of activeGlobalLangs()) {
    rules.push(...parseRules(rulesState.globalByLang[lang] || ''));
  }
  if (prof) rules.push(...parseRules(prof.rules));
  return rules;
}
// 현재 선택된 작품 기준 (단일 캡처 경로용)
function effectiveRules() { return effectiveRulesForProfile(currentProfile()); }

// 규칙은 chrome.storage.sync에 저장 → 같은 Google 계정으로 로그인한
// 모든 기기에서 자동 동기화된다. (항목당 8KB 제한이 있어 작품별로 나눠 저장)
// 동기화 저장 실패 시 로컬에라도 저장해 데이터 유실을 막는다.
async function persistRules() {
  const items = {
    ocrRulesGlobalLang: rulesState.globalByLang, // 언어별 공통 규칙
    ocrLastProfile: rulesState.currentId
  };
  for (const p of rulesState.profiles) items['ocrProfile_' + p.id] = p;
  try {
    await chrome.storage.sync.set(items);
    // 삭제된 프로필의 동기화 키 정리
    const all = await chrome.storage.sync.get(null);
    const stale = Object.keys(all).filter(
      (k) => k.startsWith('ocrProfile_') && !rulesState.profiles.some((p) => 'ocrProfile_' + p.id === k)
    );
    if (stale.length) await chrome.storage.sync.remove(stale);
  } catch (e) {
    await chrome.storage.local.set({
      ocrRulesGlobalLang: rulesState.globalByLang,
      ocrProfiles: rulesState.profiles,
      ocrLastProfile: rulesState.currentId
    });
    setStatus('⚠️ 동기화 저장 실패(이 기기에는 저장됨): ' + (e && e.message ? e.message : e));
  }
}

function renderProfileSelect() {
  const sel = $('profileSel');
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '(작품 선택 안 함)';
  sel.appendChild(none);
  for (const p of rulesState.profiles) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    sel.appendChild(o);
  }
  sel.value = rulesState.currentId;
}

function loadProfileToUI() {
  const prof = currentProfile();
  $('rulesProfile').disabled = !prof;
  $('profileMatch').disabled = !prof;
  $('rulesProfile').value = prof ? prof.rules : '';
  $('profileMatch').value = prof ? prof.match : '';
  $('rulesProfile').placeholder = prof
    ? '' : '위에서 작품을 선택하거나 「새 작품」을 눌러 추가하세요.';
  if (prof) loadGlossaryFor(prof.id).then(renderGlossStat);
  else renderGlossStat();
  // 인물 사전
  const nl = $('namesList');
  if (nl) {
    nl.disabled = !prof;
    nl.value = prof && Array.isArray(prof.names) ? prof.names.join('\n') : '';
  }
}

// 인물 사전 헬퍼: 현재 작품의 이름 배열
function currentNames() {
  const prof = currentProfile();
  return prof && Array.isArray(prof.names) ? prof.names : [];
}
// 새 이름들을 현재 작품 사전에 병합 (중복 제외). 반환: 실제 추가된 수
function mergeNames(list) {
  const prof = currentProfile();
  if (!prof) return 0;
  if (!Array.isArray(prof.names)) prof.names = [];
  const have = new Set(prof.names);
  let added = 0;
  for (const n of list) {
    const name = String(n || '').trim();
    if (name && !have.has(name)) { prof.names.push(name); have.add(name); added++; }
  }
  if (added) {
    if ($('namesList')) $('namesList').value = prof.names.join('\n');
    persistRules();
  }
  return added;
}

// URL에서 사이트·작품 식별자를 구조적으로 뽑는다 (jjwxc 데스크톱/모바일, qidian/qdmm, kakao).
function workIdentityFromUrl(url) {
  const u = String(url || '');
  let m;
  if (/jjwxc\.net/i.test(u)) {
    m = /[?&]novelid=(\d+)/i.exec(u) || /\/book2?\/(\d+)/i.exec(u); // 데스크톱 novelid= + 모바일 /book2/ 경로
    if (m) return { siteId: 'jjwxc', workId: m[1] };
  }
  if (/(qidian\.com|qdmm\.com)/i.test(u)) {
    m = /\/(?:book|info|chapter)\/(\d+)/i.exec(u) || /[?&]bookId=(\d+)/i.exec(u);
    if (m) return { siteId: 'qidian', workId: m[1] };
  }
  if (/page\.kakao\.com/i.test(u)) {
    m = /\/content\/(\d+)/i.exec(u) || /\/(\d{5,})/.exec(u);
    if (m) return { siteId: 'kakao', workId: m[1] };
  }
  return null;
}

// 프로필 매칭용 구조 키 "site:workId". 판별 불가 시 ''.
function profileKeyFromUrl(url) {
  const id = workIdentityFromUrl(url);
  return id && id.workId ? `${id.siteId}:${id.workId}` : '';
}

// 하위호환 매칭: 새 구조 키(site:id)면 정확 일치, 옛 매치 문자열(novelid= 등)이면 URL 부분일치.
function profileMatchesUrl(p, url) {
  if (!p || !p.match) return false;
  if (p.match.includes(':')) return profileKeyFromUrl(url) === p.match;
  return String(url || '').includes(p.match);
}

// 새 프로필이 저장할 작품 식별자. 이제 사이트별 구조 키를 쓴다.
function guessMatchFromUrl(url) {
  return profileKeyFromUrl(url);
}

// 예전 단일 공통 규칙 문자열을 언어별로 분리한다 (한국어 마커 기준).
function splitLegacyGlobal(text) {
  const lines = String(text || '').split(/\r?\n/);
  const korIdx = lines.findIndex((l) => /한국어\s*공통/.test(l));
  if (korIdx < 0) return { chi: text, kor: '', eng: '' };
  return {
    chi: lines.slice(0, korIdx).join('\n').trim(),
    kor: lines.slice(korIdx + 1).join('\n').trim(),
    eng: ''
  };
}

async function initRules() {
  // 1순위: 동기화 저장소 (여러 기기 공유) → 없으면 예전 로컬 저장분 이전
  const syncData = await chrome.storage.sync.get(null);
  let byLang = (syncData.ocrRulesGlobalLang && typeof syncData.ocrRulesGlobalLang === 'object')
    ? syncData.ocrRulesGlobalLang : null;
  let legacyGlobal = typeof syncData.ocrRulesGlobal === 'string' ? syncData.ocrRulesGlobal : null;
  let profiles = Object.keys(syncData)
    .filter((k) => k.startsWith('ocrProfile_'))
    .map((k) => syncData[k])
    .filter((p) => p && p.id && typeof p.rules === 'string');
  let lastProfile = syncData.ocrLastProfile;

  if (!byLang && legacyGlobal === null && profiles.length === 0) {
    const old = await chrome.storage.local.get(['ocrRulesGlobalLang', 'ocrRulesGlobal', 'ocrProfiles', 'ocrLastProfile']);
    if (old.ocrRulesGlobalLang && typeof old.ocrRulesGlobalLang === 'object') byLang = old.ocrRulesGlobalLang;
    if (typeof old.ocrRulesGlobal === 'string') legacyGlobal = old.ocrRulesGlobal;
    if (Array.isArray(old.ocrProfiles)) profiles = old.ocrProfiles;
    lastProfile = old.ocrLastProfile;
  }

  if (byLang) {
    rulesState.globalByLang = {
      chi: typeof byLang.chi === 'string' ? byLang.chi : DEFAULT_GLOBAL_RULES_CHI,
      kor: typeof byLang.kor === 'string' ? byLang.kor : DEFAULT_GLOBAL_RULES_KOR,
      eng: typeof byLang.eng === 'string' ? byLang.eng : DEFAULT_GLOBAL_RULES_ENG
    };
  } else if (legacyGlobal !== null) {
    rulesState.globalByLang = splitLegacyGlobal(legacyGlobal); // 예전 단일 규칙 → 언어별로 이전
  } else {
    rulesState.globalByLang = { ...DEFAULT_GLOBAL_BY_LANG };
  }
  if (profiles.length) {
    rulesState.profiles = profiles;
  } else {
    // 완전 첫 실행: 예시 프로필 하나 생성
    rulesState.profiles = [{
      id: 'p' + Date.now(),
      name: '예시 작품',
      match: 'novelid=8650107',
      rules: EXAMPLE_PROFILE_RULES
    }];
  }
  const st = { ocrLastProfile: lastProfile };

  // 자동 선택: 캡처 페이지 URL에 식별자가 포함된 프로필 → 없으면 자동 생성/마지막 사용
  autoSelectProfileForCapture();
  if (!rulesState.currentId && st.ocrLastProfile && rulesState.profiles.some((p) => p.id === st.ocrLastProfile)) {
    rulesState.currentId = st.ocrLastProfile;
  }
  persistRules(); // 이전(로컬)에서 불러온 경우에도 동기화 저장소에 올려 둔다

  // 공통 규칙 언어 선택 드롭다운 채우기 + 현재 언어 규칙 표시
  const gl = $('globalLang');
  gl.innerHTML = '';
  for (const lang of GLOBAL_LANGS) {
    const o = document.createElement('option');
    o.value = lang;
    o.textContent = GLOBAL_LANG_LABEL[lang];
    gl.appendChild(o);
  }
  // 기본 편집 언어: 현재 OCR 언어 선택 중 첫 번째
  rulesState.editingLang = activeGlobalLangs()[0] || 'chi';
  gl.value = rulesState.editingLang;
  $('rulesGlobal').value = rulesState.globalByLang[rulesState.editingLang] || '';

  renderProfileSelect();
  loadProfileToUI();

  gl.addEventListener('change', () => {
    // 언어 전환 전에 현재 편집 내용을 보존
    rulesState.globalByLang[rulesState.editingLang] = $('rulesGlobal').value;
    rulesState.editingLang = gl.value;
    $('rulesGlobal').value = rulesState.globalByLang[rulesState.editingLang] || '';
  });
  $('rulesGlobal').addEventListener('input', () => {
    rulesState.globalByLang[rulesState.editingLang] = $('rulesGlobal').value;
  });
  $('rulesGlobal').addEventListener('change', persistRules);
  $('rulesProfile').addEventListener('input', () => {
    const prof = currentProfile();
    if (prof) prof.rules = $('rulesProfile').value;
  });
  $('rulesProfile').addEventListener('change', persistRules);
  $('profileMatch').addEventListener('input', () => {
    const prof = currentProfile();
    if (prof) prof.match = $('profileMatch').value.trim();
  });
  $('profileMatch').addEventListener('change', persistRules);

  $('profileSel').addEventListener('change', () => {
    rulesState.currentId = $('profileSel').value;
    loadProfileToUI();
    persistRules();
  });

  $('profileNew').addEventListener('click', () => {
    const name = prompt('작품 이름을 입력하세요 (예: 소설 제목):');
    if (!name || !name.trim()) return;
    const p = {
      id: 'p' + Date.now(),
      name: name.trim(),
      match: guessMatchFromUrl(capture && capture.pageUrl),
      rules: '# 이 작품에서만 적용되는 규칙 (주로 인명)\n'
    };
    rulesState.profiles.push(p);
    rulesState.currentId = p.id;
    renderProfileSelect();
    loadProfileToUI();
    persistRules();
    setStatus(p.match
      ? `작품 "${p.name}" 추가됨 — URL 식별자(${p.match})가 자동 등록되어 이 작품 캡처 시 자동 선택됩니다.`
      : `작품 "${p.name}" 추가됨.`);
  });

  $('profileDel').addEventListener('click', () => {
    const prof = currentProfile();
    if (!prof) return;
    if (!confirm(`작품 "${prof.name}"의 규칙과 용어집을 삭제할까요?`)) return;
    const delId = prof.id;
    rulesState.profiles = rulesState.profiles.filter((p) => p.id !== delId);
    rulesState.currentId = '';
    glossaryState.delete(delId);
    chrome.storage.local.remove('ocrGlossary_' + delId);
    renderProfileSelect();
    loadProfileToUI();
    persistRules();
  });

  $('exportRules').addEventListener('click', exportRules);
  $('importRules').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', importRules);

  // 용어집 가져오기/내보내기/비우기
  $('glossImport').addEventListener('click', () => {
    if (!currentProfile()) { setStatus('용어집은 작품을 선택한 뒤 사용할 수 있습니다.'); return; }
    $('glossFile').click();
  });
  $('glossFile').addEventListener('change', importGlossaryFile);
  $('glossImportSheet').addEventListener('click', importGlossaryFromSheet);
  $('glossExportXlsx').addEventListener('click', () => exportGlossary('xlsx'));
  $('glossExportCsv').addEventListener('click', () => exportGlossary('csv'));

  // 인물 사전
  $('namesList').addEventListener('input', () => {
    const prof = currentProfile();
    if (!prof) return;
    prof.names = $('namesList').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  });
  $('namesList').addEventListener('change', persistRules);
  $('namesCollect').addEventListener('click', () => {
    if (!currentProfile()) { setStatus('인물 사전은 작품을 선택한 뒤 사용할 수 있습니다.'); return; }
    const t = ($('ocrText').value || '').trim();
    if (!t) { setStatus('먼저 OCR을 실행하세요. 그 결과에서 인물 이름을 수집합니다.'); return; }
    const added = mergeNames(collectNames(t).map((c) => c.name));
    setStatus(added ? `인물 ${added}명을 사전에 추가했습니다.` : '새로 추가할 인물 후보를 찾지 못했습니다.');
  });
  $('glossClear').addEventListener('click', async () => {
    const prof = currentProfile();
    if (!prof) return;
    if (!currentGlossary().length) { setStatus('용어집이 이미 비어 있습니다.'); return; }
    if (!confirm(`「${prof.name}」의 용어집을 비울까요?`)) return;
    await saveGlossaryFor(prof.id, []);
    renderGlossStat();
    setStatus('용어집을 비웠습니다.');
  });
}

// ---------- 용어집 파일 가져오기 / 내보내기 ----------
// 추출된 [{s,t}]를 현재 작품 용어집에 병합 저장
async function mergeIncomingGlossary(incoming, sourceLabel) {
  const prof = currentProfile();
  if (!prof) throw new Error('작품을 먼저 선택하세요.');
  if (!incoming.length) throw new Error('원문/교정 두 열을 찾지 못했거나 항목이 없습니다.');
  const map = new Map(currentGlossary().map((x) => [x.s, x.t]));
  for (const { s, t } of incoming) map.set(s, t);
  const merged = [...map].map(([s, t]) => ({ s, t }));
  await saveGlossaryFor(prof.id, merged);
  renderGlossStat();
  setStatus(`용어집 가져오기 완료 — ${incoming.length}개 반영, 현재 ${merged.length}개 (「${prof.name}」${sourceLabel ? ', ' + sourceLabel : ''})`);
}

async function importGlossaryFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !currentProfile()) return;
  try {
    let incoming = [];
    if (/\.xlsx$/i.test(file.name)) {
      // 모든 시트에서 원문/교정 헤더가 있는 시트만 추출·병합 (권고: XLSX는 항상 헤더 필수)
      const sheets = await SCOXlsx.parseXlsxSheets(await file.arrayBuffer());
      const seen = new Set();
      for (const rows of sheets) {
        for (const g of glossaryFromRows(rows, false)) { // allowHeaderless=false
          if (!seen.has(g.s)) { seen.add(g.s); incoming.push(g); }
        }
      }
      if (!incoming.length) throw new Error('원문/교정 헤더가 있는 시트를 찾지 못했습니다. 첫 행(또는 상단 몇 행)에 "원문"·"교정" 같은 머리글을 넣어 주세요.');
    } else {
      const text = await file.text();
      const delim = /\.tsv$/i.test(file.name) || (text.includes('\t') && !text.includes(',')) ? '\t' : ',';
      incoming = glossaryFromRows(SCOXlsx.parseDelimited(text, delim), true); // CSV/TSV 헤더 없어도 허용
    }
    await mergeIncomingGlossary(incoming, file.name);
  } catch (err) {
    setStatus('용어집 가져오기 실패: ' + (err && err.message ? err.message : err));
  }
}

// Google Sheets 공개 링크에서 CSV로 읽어온다 (링크 공유가 '보기 가능'이어야 함)
async function importGlossaryFromSheet() {
  if (!currentProfile()) { setStatus('용어집은 작품을 선택한 뒤 사용할 수 있습니다.'); return; }
  const url = prompt(
    'Google Sheets 링크를 붙여넣으세요.\n(공유 설정이 "링크가 있는 모든 사용자 — 뷰어"여야 읽을 수 있습니다)\n' +
    '첫 행(또는 상단 몇 행)에 원문·교정 머리글이 있어야 합니다.', '');
  if (url === null) return;
  const idm = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(url);
  if (!idm) { setStatus('올바른 Google Sheets 링크가 아닙니다.'); return; }
  const gidm = /[#&?]gid=(\d+)/.exec(url);
  const exportUrl = `https://docs.google.com/spreadsheets/d/${idm[1]}/export?format=csv` +
    (gidm ? `&gid=${gidm[1]}` : '');
  try {
    setStatus('Google Sheets에서 불러오는 중…');
    const r = await fetch(exportUrl, { credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' — 시트가 공개(링크 공유)되어 있는지 확인하세요.');
    const text = await r.text();
    if (/^\s*<(!doctype|html)/i.test(text)) {
      throw new Error('CSV 대신 로그인 페이지가 반환되었습니다. 시트 공유를 "링크가 있는 모든 사용자"로 바꿔 주세요.');
    }
    const incoming = glossaryFromRows(SCOXlsx.parseDelimited(text, ','), true);
    await mergeIncomingGlossary(incoming, 'Google Sheets');
  } catch (err) {
    setStatus('Google Sheets 가져오기 실패: ' + (err && err.message ? err.message : err));
  }
}

function exportGlossary(fmt) {
  const prof = currentProfile();
  if (!prof) { setStatus('용어집은 작품을 선택한 뒤 사용할 수 있습니다.'); return; }
  const g = currentGlossary();
  if (!g.length) { setStatus('내보낼 용어집이 비어 있습니다.'); return; }
  const rows = [['원문', '교정'], ...g.map((e) => [e.s, e.t])];
  const safeName = (prof.name || 'glossary').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  if (fmt === 'xlsx') {
    downloadBlob(new Blob([SCOXlsx.makeXlsx(rows)],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `glossary_${safeName}.xlsx`);
  } else {
    const csv = rows.map((r) => r.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\r\n');
    downloadBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `glossary_${safeName}.csv`);
  }
  setStatus(`용어집을 내보냈습니다 (${g.length}개, ${fmt.toUpperCase()}).`);
}

// ---------- 규칙 내보내기 / 가져오기 ----------
function exportRules() {
  persistRules();
  const data = {
    type: 'sco-rules',
    version: 2,
    exportedAt: new Date().toISOString(),
    globalByLang: rulesState.globalByLang, // 언어별 공통 규칙
    profiles: rulesState.profiles.map((p) => ({ name: p.name, match: p.match, rules: p.rules }))
  };
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const filename = `ocr-rules_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename);
  setStatus(`교정 규칙을 내보냈습니다 (공통 + 작품 ${rulesState.profiles.length}개) — ${filename}`);
}

// 두 규칙 텍스트 병합: 기존에 없는 줄만 뒤에 추가 (기존 규칙은 절대 지우지 않음)
function mergeRuleText(base, incoming) {
  const baseLines = new Set(
    String(base).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  );
  const add = String(incoming).split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !baseLines.has(l));
  return add.length ? String(base).replace(/\s*$/, '') + '\n' + add.join('\n') : String(base);
}

async function importRules(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // 같은 파일을 다시 선택해도 동작하도록 초기화
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.type !== 'sco-rules' || !Array.isArray(data.profiles)) {
      throw new Error('이 확장에서 내보낸 규칙 파일(JSON)이 아닙니다.');
    }
    // 공통 규칙 병합: 신형(globalByLang) 우선, 구형(단일 global 문자열)은 언어별로 분리해 병합
    if (data.globalByLang && typeof data.globalByLang === 'object') {
      for (const lang of GLOBAL_LANGS) {
        if (typeof data.globalByLang[lang] === 'string') {
          rulesState.globalByLang[lang] = mergeRuleText(rulesState.globalByLang[lang] || '', data.globalByLang[lang]);
        }
      }
    } else if (typeof data.global === 'string') {
      const split = splitLegacyGlobal(data.global);
      for (const lang of GLOBAL_LANGS) {
        if (split[lang]) rulesState.globalByLang[lang] = mergeRuleText(rulesState.globalByLang[lang] || '', split[lang]);
      }
    }
    let added = 0, merged = 0;
    for (const imp of data.profiles) {
      if (!imp || typeof imp.rules !== 'string') continue;
      const exist = rulesState.profiles.find(
        (p) => (imp.match && p.match === imp.match) || p.name === imp.name
      );
      if (exist) {
        exist.rules = mergeRuleText(exist.rules, imp.rules);
        if (imp.match && !exist.match) exist.match = imp.match;
        merged++;
      } else {
        rulesState.profiles.push({
          id: 'p' + Date.now() + Math.random().toString(36).slice(2, 6),
          name: String(imp.name || '가져온 작품'),
          match: String(imp.match || ''),
          rules: imp.rules
        });
        added++;
      }
    }
    persistRules();
    $('rulesGlobal').value = rulesState.globalByLang[rulesState.editingLang] || '';
    renderProfileSelect();
    loadProfileToUI();
    setStatus(`규칙 가져오기 완료 — 새 작품 ${added}개 추가, 기존 작품 ${merged}개 병합`);
  } catch (err) {
    setStatus('규칙 가져오기 실패: ' + (err && err.message ? err.message : err));
  }
}

init();

// 캡처한 페이지의 도메인/제목으로 OCR 언어를 자동 판별한다.
// 반환: ['kor'] | ['chi_sim'] | null(판별 불가)
function detectLangsForCapture(cap) {
  const url = ((cap && cap.pageUrl) || '').toLowerCase();
  const title = (cap && cap.pageTitle) || '';
  let host = '';
  try { host = new URL(url).hostname; } catch (_) {}

  const korHosts = [
    'page.kakao.com', 'kakao.com', 'naver.com', 'series.naver.com',
    'ridibooks.com', 'ridi.com', 'munpia.com', 'joara.com', 'novelpia.com',
    'kakaoent.com', 'watcha.com', 'yes24.com', 'aladin.co.kr', 'kyobobook.co.kr'
  ];
  const chiHosts = [
    'jjwxc.net', 'qidian.com', 'zongheng.com', 'hongxiu.com', '17k.com',
    'fanqienovel.com', 'weread.qq.com', 'faloo.com', 'po18.tw', 'czbooks.net',
    'uukanshu.com', 'biquge', 'qimao.com', 'xiaoshuo'
  ];
  if (host) {
    if (korHosts.some((h) => host === h || host.endsWith('.' + h)) || host.endsWith('.kr')) return ['kor'];
    if (chiHosts.some((h) => host === h || host.endsWith('.' + h) || host.includes(h)) ||
        host.endsWith('.cn') || host.endsWith('.tw')) return ['chi_sim'];
  }
  // 도메인으로 알 수 없으면 페이지 제목의 문자 구성으로 판별
  const hangul = (title.match(/[가-힣]/g) || []).length;
  const han = (title.match(/[一-鿿]/g) || []).length;
  if (hangul >= 2 && hangul > han) return ['kor'];
  if (han >= 2 && han > hangul) return ['chi_sim'];
  return null;
}

// 자동 판별 결과를 언어 체크박스에 반영. 판별 실패 시 아무것도 바꾸지 않는다.
function applyAutoLangs(cap) {
  const det = detectLangsForCapture(cap);
  if (!det) return false;
  $('langChi').checked = det.includes('chi_sim');
  $('langKor').checked = det.includes('kor');
  $('langEng').checked = det.includes('eng');
  return true;
}

async function fetchCaptureById(id) {
  const o = await chrome.storage.local.get('capture_' + id);
  return o['capture_' + id] || null;
}

// ==========================================================================
// 저장 계층 추상화 — IndexedDB 타일(tiles-v1)과 구버전 단일 dataURL을 함께 지원.
// 캡처는 완성 타일을 IndexedDB에 즉시 저장하므로 전체 장문 이미지를 메모리에
// 통째로 올리지 않는다. 표시·저장·OCR·AI 비전은 필요한 타일만 그때그때 불러온다.
// ==========================================================================
function isTiled(cap) {
  return !!(cap && cap.storageMode === 'tiles-v1' && Array.isArray(cap.tiles));
}

function clearPreviewUrls() {
  for (const url of previewObjectUrls) URL.revokeObjectURL(url);
  previewObjectUrls = [];
}

async function tileBlob(tile) {
  if (!globalThis.SCOStore) throw new Error('타일 저장소 모듈(tile-store.js)을 불러오지 못했습니다.');
  const blob = await SCOStore.getBlob(tile.key);
  if (!blob) throw new Error(`캡처 타일이 없습니다: ${tile.key}`);
  return blob;
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('이미지 Blob 생성에 실패했습니다.')),
    type, quality
  ));
}

// 타일 캡처를 하나의 캔버스로 합성한다. 캔버스 크기 한계를 넘으면 null.
// (겹침 영역을 잘라내고 core 영역만 이어 붙여 이음새 없는 전체 이미지를 만든다.)
async function composeTiledToCanvas(cap) {
  if (cap.width > 32767 || cap.height > 32767 || cap.width * cap.height > 100e6) return null;
  const canvas = document.createElement('canvas');
  canvas.width = cap.width;
  canvas.height = cap.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const tile of [...cap.tiles].sort((a, b) => a.index - b.index)) {
    const blob = await tileBlob(tile);
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      ctx.drawImage(img, 0, tile.cropTop || 0, tile.width, tile.coreHeight,
        0, tile.coreStart, tile.width, tile.coreHeight);
    } finally { URL.revokeObjectURL(url); }
  }
  return canvas;
}

// ---------- PNG/JPG 내보내기 ----------
// core 타일 한 장을 겹침 영역 제거 후 PNG/JPG Blob으로.
async function coreTileBlob(tile, fmt) {
  const blob = await tileBlob(tile);
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = tile.width;
    canvas.height = tile.coreHeight;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, tile.cropTop || 0, tile.width, tile.coreHeight, 0, 0, tile.width, tile.coreHeight);
    const q = Math.min(100, Math.max(10, Number($('jpgQuality').value) || 92)) / 100;
    return canvasBlob(canvas, fmt === 'jpg' ? 'image/jpeg' : 'image/png', fmt === 'jpg' ? q : undefined);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function composeTiledCapture(cap, fmt) {
  const canvas = await composeTiledToCanvas(cap);
  if (!canvas) return null;
  const q = Math.min(100, Math.max(10, Number($('jpgQuality').value) || 92)) / 100;
  return canvasBlob(canvas, fmt === 'jpg' ? 'image/jpeg' : 'image/png', fmt === 'jpg' ? q : undefined);
}

// 캡처를 PNG/JPG 파일 목록으로 변환.
// 매우 큰 타일 캡처는 전체 합성 대신 core 타일별 파일로 내보내 메모리 폭증을 막는다.
async function imageBlobsFor(cap, fmt) {
  if (isTiled(cap)) {
    const composed = await composeTiledCapture(cap, fmt);
    if (composed) return [{ blob: composed, suffix: '' }];
    const out = [];
    const tiles = [...cap.tiles].sort((a, b) => a.index - b.index);
    for (let i = 0; i < tiles.length; i++) {
      out.push({ blob: await coreTileBlob(tiles[i], fmt), suffix: `_tile${String(i + 1).padStart(3, '0')}` });
    }
    return out;
  }
  if (!cap.dataUrl) throw new Error('이미지 데이터가 없습니다.');
  if (fmt === 'png') return [{ blob: await (await fetch(cap.dataUrl)).blob(), suffix: '' }];
  const img = await loadImage(cap.dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  const q = Math.min(100, Math.max(10, Number($('jpgQuality').value) || 92)) / 100;
  return [{ blob: await canvasBlob(canvas, 'image/jpeg', q), suffix: '' }];
}

// ---------- OCR용 조각 로딩 (타일 단위 순차 처리) ----------
function capturePartDescriptors(cap, overlapContext = 64) {
  if (isTiled(cap)) {
    return [...cap.tiles].sort((a, b) => a.index - b.index).map((meta) => ({ type: 'tile', meta, overlapContext }));
  }
  if (cap.dataUrl) return [{ type: 'legacy', dataUrl: cap.dataUrl, overlapContext: 0 }];
  throw new Error('OCR할 이미지 데이터가 없습니다.');
}

async function loadCapturePart(desc) {
  let url = '';
  if (desc.type === 'tile') {
    const blob = await tileBlob(desc.meta);
    url = URL.createObjectURL(blob);
  }
  const img = await loadImage(desc.type === 'tile' ? url : desc.dataUrl);
  if (desc.type === 'tile') {
    const validBottom = Math.min(img.height, Number(desc.meta.validStoredHeight || img.height));
    const top = Math.max(0, (desc.meta.cropTop || 0) - desc.overlapContext);
    const bottom = Math.min(validBottom, (desc.meta.cropTop || 0) + desc.meta.coreHeight + desc.overlapContext);
    return { img, url, top, height: Math.max(1, bottom - top), meta: desc.meta };
  }
  return { img, url: '', top: 0, height: img.height, meta: null };
}

// 인접 조각 경계에서 겹쳐 인식된 문장을 한 번만 남기고 이어 붙인다.
function mergeTextOverlap(left, right) {
  left = String(left || '').replace(/\s+$/, '');
  right = String(right || '').replace(/^\s+/, '');
  if (!left) return right;
  if (!right) return left;
  const a = left.split('\n');
  const b = right.split('\n');
  const max = Math.min(12, a.length, b.length);
  for (let n = max; n >= 1; n--) {
    const aa = a.slice(-n).map((x) => x.trim()).join('\n');
    const bb = b.slice(0, n).map((x) => x.trim()).join('\n');
    if (aa.length >= 2 && aa === bb) return a.concat(b.slice(n)).join('\n');
  }
  const norm = (x) => x.replace(/\s+/g, '');
  const an = norm(left), bn = norm(right);
  for (let n = Math.min(100, an.length, bn.length); n >= 8; n--) {
    if (an.slice(-n) === bn.slice(0, n)) {
      if (b[0] && norm(b[0]).length <= n) return a.concat(b.slice(1)).join('\n');
      // 겹치는 부분이 right의 첫 줄 일부만 차지하는 경우(흔한 경우): 이전에는 여기서
      // 그냥 포기하고 아래의 left+'\n'+right로 떨어져, 감지해 놓고도 겹친 글자를
      // 그대로 중복 출력했다. n자만큼을 right 앞에서 잘라내고 나머지만 이어붙인다.
      const cut = rawCutForNormLen(right, n);
      const remainder = right.slice(cut).replace(/^\s+/, '');
      return remainder ? left + '\n' + remainder : left;
    }
  }
  return left + '\n' + right;
}

// str의 앞에서부터 공백을 제외한 문자를 n개 셀 때까지의 원본(raw) 문자열 인덱스를 구한다.
// (norm()이 공백을 모두 제거하므로, 정규화된 길이 n을 원본 문자열 위치로 되돌리는 데 필요)
function rawCutForNormLen(str, n) {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (!/\s/.test(str[i])) count++;
    if (count >= n) return i + 1;
  }
  return str.length;
}

async function showCapture(c) {
  clearPreviewUrls();
  const img = $('capturedImg');
  const stack = $('tileStack');
  img.style.display = 'none';
  img.removeAttribute('src');
  stack.style.display = 'none';
  stack.innerHTML = '';

  if (isTiled(c)) {
    // 타일을 세로로 이어 붙여 표시한다. 각 타일은 겹침(overlap)을 포함해 저장돼 있으므로
    // viewport 로 core 영역만 보이도록 잘라내고 나머지는 위로 밀어 감춘다.
    stack.style.display = 'flex';
    const availableW = Math.max(200, $('previewWrap').clientWidth - 18);
    const scale = Math.min(1, availableW / c.width);
    for (const tile of [...c.tiles].sort((a, b) => a.index - b.index)) {
      const blob = await tileBlob(tile);
      const url = URL.createObjectURL(blob);
      previewObjectUrls.push(url);
      const viewport = document.createElement('div');
      viewport.className = 'tile-viewport';
      viewport.style.width = Math.max(1, Math.round(tile.width * scale)) + 'px';
      viewport.style.height = Math.max(1, Math.round(tile.coreHeight * scale)) + 'px';
      const partImg = document.createElement('img');
      partImg.src = url;
      partImg.loading = tile.index < 2 ? 'eager' : 'lazy';
      partImg.style.width = Math.max(1, Math.round(tile.width * scale)) + 'px';
      partImg.style.height = 'auto';
      partImg.style.transform = `translateY(${-Math.round((tile.cropTop || 0) * scale)}px)`;
      viewport.appendChild(partImg);
      stack.appendChild(viewport);
    }
  } else if (c.dataUrl) {
    img.src = c.dataUrl;
    img.style.display = 'block';
  } else {
    throw new Error('캡처 이미지 데이터가 없습니다.');
  }

  const when = c.capturedAt ? new Date(c.capturedAt).toLocaleString('ko-KR') : '';
  $('meta').textContent =
    `${c.width}×${c.height}px · ${when}` +
    (c.part > 1 ? ` · ${c.part}부` : '') +
    ((c.chapterTitle || c.pageTitle) ? ` · ${c.chapterTitle || c.pageTitle}` : '') +
    (isTiled(c) ? ` · 저메모리 타일 ${c.tiles.length}개` : '');
}

// showCapture()는 타일이 누락된 경우 등 throw할 수 있다. 호출부(초기화·캡처
// 전환·삭제)에서 그대로 두면 그 뒤에 이어지는 버튼 이벤트 연결까지 통째로
// 건너뛰어 버튼이 하나도 동작하지 않는 상태가 된다. 항상 이 래퍼로 호출해
// 실패해도 나머지 초기화가 계속되고 사용자에게 원인이 보이게 한다.
async function showCaptureSafe(c) {
  try {
    await showCapture(c);
    return true;
  } catch (e) {
    console.error(e);
    setStatus('이미지를 표시하지 못했습니다: ' + (e && e.message ? e.message : e));
    return false;
  }
}

function renderCaptureSelect() {
  const sel = $('capSel');
  sel.innerHTML = '';
  if (!captureIndex.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '(현재 캡처)';
    sel.appendChild(o);
    sel.disabled = true;
    $('capDel').disabled = true;
    $('capDelAll').disabled = true;
    $('runOcrAll').disabled = true;
    return;
  }
  const pad = (n) => String(n).padStart(2, '0');
  captureIndex.forEach((e, i) => {
    const o = document.createElement('option');
    o.value = e.id;
    const d = new Date(e.capturedAt);
    o.textContent =
      `${captureIndex.length - i}. ${pad(d.getMonth() + 1)}/${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
      (e.part > 1 ? ` (${e.part}부)` : '') +
      ((e.chapterTitle || e.pageTitle) ? ' — ' + String(e.chapterTitle || e.pageTitle).slice(0, 26) : '');
    sel.appendChild(o);
  });
  sel.value = capture && capture.id ? capture.id : captureIndex[0].id;
  renderBatchList(); // 목록이 바뀌면 일괄 다운로드 체크리스트도 갱신
}

// ---------- 일괄 다운로드 ----------
// v2.18.0 이전에 저장된 캡처는 captureIndex(가벼운 목록)에 pageUrl이 없어(당시
// indexEntry()가 저장하지 않았음) 자동 묶음 판별이 안 된다. 확장을 새로고침해도
// 이미 저장된 captureIndex 배열은 그대로 남아 있으므로(새 캡처가 생길 때만 새 형식으로
// 추가됨), 최초 1회 각 캡처의 전체 데이터(capture_<id> — pageUrl은 처음부터 늘
// 저장돼 있었음)에서 값을 읽어와 인덱스를 보정하고 저장소에 다시 쓴다.
async function migrateCaptureIndexPageUrl() {
  const missing = captureIndex.filter((e) => !e.pageUrl);
  if (!missing.length) return;
  const fulls = await Promise.all(missing.map((e) => fetchCaptureById(e.id).catch(() => null)));
  let changed = false;
  missing.forEach((e, i) => {
    const full = fulls[i];
    if (full && full.pageUrl) { e.pageUrl = full.pageUrl; changed = true; }
  });
  if (changed) await chrome.storage.local.set({ captureIndex });
}

// 같은 도메인 + 같은 작품(콘텐츠) 번호인 캡처를 묶기 위한 키. 둘 다 식별되지 않으면
// null(그룹화 안 함) — workId가 비어 있는 캡처(연속 캡처가 아닌 일반 드래그/요소 선택)는
// URL을 다시 읽어(fnIdsFromUrl) 보완한다.
function batchGroupKey(entry) {
  const url = entry.pageUrl || '';
  // 같은 작품이 서브도메인(www./m.)만 달라도 한 그룹으로 묶이도록 사이트 '계열'로 정규화한다.
  const identity = workIdentityFromUrl(url);
  if (identity && identity.workId) return identity.siteId + '|' + identity.workId;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return null; }
  const workId = entry.workId || fnIdsFromUrl(url).workId;
  if (!host || !workId) return null;
  let fam = host;
  if (host.endsWith('jjwxc.net')) fam = 'jjwxc';
  else if (host.endsWith('qidian.com') || host.endsWith('qdmm.com')) fam = 'qidian';
  else if (host.endsWith('page.kakao.com')) fam = 'kakao';
  return fam + '|' + workId;
}

// 그룹 헤더 체크박스 ↔ 하위 항목 체크박스 상태를 동기화하기 위해 렌더링할 때마다 갱신.
let batchGroupControls = [];

function renderBatchList() {
  const box = $('batchList');
  if (!box) return;
  box.innerHTML = '';
  batchGroupControls = [];
  const pad = (n) => String(n).padStart(2, '0');

  const makeItemRow = (e, i) => {
    const d = new Date(e.capturedAt);
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 2px;cursor:pointer';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = e.id;
    cb.className = 'batch-item-cb'; // 그룹 헤더 체크박스와 구분(선택 항목 조회 시 헤더는 제외)
    const span = document.createElement('span');
    span.textContent =
      `${captureIndex.length - i}. ${pad(d.getMonth() + 1)}/${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}` +
      (e.part > 1 ? ` (${e.part}부)` : '') +
      ((e.chapterTitle || e.pageTitle) ? ' — ' + String(e.chapterTitle || e.pageTitle).slice(0, 34) : '');
    row.appendChild(cb);
    row.appendChild(span);
    return { row, cb };
  };

  // 그룹 키별로 색인을 먼저 모은다.
  const groups = new Map();
  captureIndex.forEach((e, i) => {
    const key = batchGroupKey(e);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });

  const rendered = new Set();
  captureIndex.forEach((e, i) => {
    if (rendered.has(i)) return;
    const key = batchGroupKey(e);
    const idxs = key ? groups.get(key) : null;

    if (idxs && idxs.length > 1) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'border:1px solid #2c3444;border-radius:6px;margin:3px 0;padding:2px 4px;background:#171c26';
      const headerRow = document.createElement('label');
      headerRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 2px;cursor:pointer;font-weight:600;color:#c3cbd8';
      const groupCb = document.createElement('input');
      groupCb.type = 'checkbox';
      const first = e;
      const label = String(first.pageTitle || first.chapterTitle || key.split('|')[0]).slice(0, 30);
      const headerSpan = document.createElement('span');
      headerSpan.textContent = `📁 ${label} — 묶음 ${idxs.length}개 (전체 선택)`;
      headerRow.append(groupCb, headerSpan);
      wrap.appendChild(headerRow);

      const itemCbs = [];
      idxs.forEach((gi) => {
        rendered.add(gi);
        const { row, cb } = makeItemRow(captureIndex[gi], gi);
        row.style.paddingLeft = '22px';
        itemCbs.push(cb);
        wrap.appendChild(row);
      });

      const syncGroupHeader = () => {
        const total = itemCbs.length;
        const checkedCount = itemCbs.filter((c) => c.checked).length;
        groupCb.checked = checkedCount === total;
        groupCb.indeterminate = checkedCount > 0 && checkedCount < total;
      };
      itemCbs.forEach((c) => c.addEventListener('change', syncGroupHeader));
      groupCb.addEventListener('change', () => {
        itemCbs.forEach((c) => { c.checked = groupCb.checked; });
        groupCb.indeterminate = false;
      });
      syncGroupHeader();
      batchGroupControls.push({ groupCb, itemCbs, sync: syncGroupHeader });

      box.appendChild(wrap);
    } else {
      rendered.add(i);
      box.appendChild(makeItemRow(e, i).row);
    }
  });
}

// TXT/이미지 저장 위치 설정 (다운로드 폴더 기준)
const saveSettings = { subfolder: '', saveAs: false };

// 하위 폴더를 파일명 앞에 붙인다 (다운로드 폴더 기준 상대 경로). 금지문자는 _로 치환.
function withSubfolder(filename) {
  let sub = (saveSettings.subfolder || '').trim()
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  return sub ? sub + '/' + filename : filename;
}

// 통합 저장: 하위 폴더 적용 + 선택 시 Save As 대화상자.
// opts.forceSaveAs=false 로 일괄 저장에서는 대화상자를 강제로 끈다.
function contentDownload(blob, filename, opts = {}) {
  const url = URL.createObjectURL(blob);
  const saveAs = opts.forceSaveAs === false ? false : !!saveSettings.saveAs;
  chrome.downloads.download(
    { url, filename: withSubfolder(filename), conflictAction: 'uniquify', saveAs },
    () => { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  );
}

// 일괄 저장용 (파일마다 대화상자가 뜨지 않도록 Save As 강제 해제, 하위 폴더는 적용)
function downloadFile(blob, filename) {
  contentDownload(blob, filename, { forceSaveAs: false });
}

async function runBatchDownload() {
  const checked = new Set(
    [...document.querySelectorAll('#batchList .batch-item-cb:checked')].map((c) => c.value)
  );
  if (!checked.size) { setStatus('다운로드할 캡처를 체크하세요.'); return; }
  const wantImg = $('batchImg').checked;
  const merge = $('batchMerge').checked;   // 병합 선택 시 텍스트 OCR 자동 포함
  const wantTxt = $('batchTxt').checked || merge;
  if (!wantImg && !wantTxt) { setStatus('이미지/텍스트 중 하나 이상을 선택하세요.'); return; }
  const fmt = $('batchImgFmt').value;
  const entries = [...captureIndex].reverse().filter((e) => checked.has(e.id)); // 캡처 순서대로

  const btn = $('batchGo');
  btn.disabled = true;
  let worker = null;
  const tileInfo = { i: 0, n: 1, prefix: '', base: 0, span: 1 / entries.length };
  try {
    let opts = null;
    if (wantTxt) {
      opts = readOcrOptions();
      if (!opts) return;
      if (!(await preflightEngine())) return;
      setStatus('OCR 엔진 로딩 중…');
      worker = await createOcrWorker(opts.langs, opts.block, tileInfo);
    }
    const mergedParts = [];
    let firstBase = '';
    for (let k = 0; k < entries.length; k++) {
      const cap = await fetchCaptureById(entries[k].id);
      if (!cap) continue;
      // 일괄 다운로드의 OCR은 항상 순수 로컬 OCR이라(AI 교정·비전 없음), 전역 textSource가
      // 다른 값(이전 단일 캡처 세션의 상태)이어도 그게 섞여 들어가지 않도록 'local'을 명시한다.
      const base = defaultBaseFor(cap, 'local');
      if (!firstBase) firstBase = base;
      setStatus(`일괄 다운로드 중… (${k + 1}/${entries.length}) ${base}`);
      if (wantImg) {
        const files = await imageBlobsFor(cap, fmt);
        for (const f of files) downloadFile(f.blob, `${base}${f.suffix}.${fmt}`);
      }
      if (wantTxt) {
        tileInfo.prefix = `[${k + 1}/${entries.length}] `;
        tileInfo.base = k / entries.length;
        const r = await ocrOneImage(worker, cap, opts.prep, tileInfo);
        const text = await postprocessTextForCapture(r.text, opts.annot, cap); // 캡처별 작품 규칙/용어집
        if (merge) {
          const label = cap.chapterTitle || (cap.part > 1 ? `${cap.part}부` : `${k + 1}번째 캡처`);
          mergedParts.push(`────────── ${label} ──────────\n\n${text}`);
        } else {
          downloadFile(new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' }), `${base}.txt`);
        }
      }
    }
    if (merge && mergedParts.length) {
      downloadFile(
        new Blob(['﻿' + mergedParts.join('\n\n')], { type: 'text/plain;charset=utf-8' }),
        `${firstBase}_merged.txt`
      );
    }
    persistRules();
    setStatus(`일괄 다운로드 완료 — 캡처 ${entries.length}개` +
      (merge ? ' (병합 TXT 1개)' : wantImg && wantTxt ? ' (이미지+텍스트)' : wantImg ? ' (이미지)' : ' (텍스트)'));
  } catch (e) {
    console.error(e);
    setStatus('일괄 다운로드 실패: ' + (e && e.message ? e.message : e));
  } finally {
    setProgress(null);
    btn.disabled = false;
    if (worker) { try { await worker.terminate(); } catch (_) {} }
  }
}

async function deleteCurrentCapture() {
  if (busyOp) return;
  if (!capture || !capture.id || !captureIndex.length) return;
  if (!confirm('현재 표시된 캡처를 삭제할까요?')) return;
  const id = capture.id;
  captureIndex = captureIndex.filter((e) => e.id !== id);
  if (isTiled(capture)) await SCOStore.deleteKeys(capture.tiles.map((t) => t.key)).catch(() => {});
  await chrome.storage.local.remove(['capture_' + id, 'ocrCache_' + id, 'visionState_' + id]);
  // 삭제한 것이 lastCapture면 지워서 새로고침 후 되살아나지 않게 한다 (fix 14)
  const { lastCapture } = await chrome.storage.local.get('lastCapture');
  if (lastCapture && lastCapture.id === id) await chrome.storage.local.remove('lastCapture');
  await chrome.storage.local.set({ captureIndex });
  if (captureIndex.length) {
    capture = await fetchCaptureById(captureIndex[0].id);
    renderCaptureSelect();
    if (capture) {
      await showCaptureSafe(capture);
      await restoreVisionState(capture.id);
      autoSelectProfileForCapture();
      renderProfileSelect();
      loadProfileToUI();
      updateFnPreview();
      if (!(await restoreOcrCache(capture.id))) { setRawText(''); $('ocrText').value = ''; }
    }
  } else {
    location.reload();
  }
}

async function deleteAllCaptures() {
  if (busyOp) return;
  if (!captureIndex.length) return;
  if (!confirm(`저장된 캡처 ${captureIndex.length}개를 모두 삭제할까요?`)) return;
  // IndexedDB 타일 정리: 각 캡처의 타일 키를 모아 한 번에 삭제.
  const tileKeys = [];
  for (const e of captureIndex) {
    const cap = await fetchCaptureById(e.id);
    if (cap && Array.isArray(cap.tiles)) tileKeys.push(...cap.tiles.map((t) => t.key));
  }
  if (tileKeys.length) await SCOStore.deleteKeys(tileKeys).catch(() => {});
  await chrome.storage.local.remove(
    captureIndex.map((e) => 'capture_' + e.id)
      .concat(captureIndex.map((e) => 'ocrCache_' + e.id))
      .concat(captureIndex.map((e) => 'visionState_' + e.id))
      .concat(['lastCapture'])
  );
  await chrome.storage.local.set({ captureIndex: [] });
  location.reload();
}

async function init() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  const st = await chrome.storage.local.get(['captureIndex', 'lastCapture']);
  captureIndex = Array.isArray(st.captureIndex) ? st.captureIndex : [];
  await migrateCaptureIndexPageUrl(); // v2.18.0 이전 캡처는 인덱스에 pageUrl이 없어 자동 묶음 판별이 안 됨 — 1회 보정
  if (captureIndex.length) {
    capture = await fetchCaptureById(captureIndex[0].id);
  }
  if (!capture && st.lastCapture && (st.lastCapture.dataUrl || isTiled(st.lastCapture))) {
    capture = st.lastCapture; // 구버전 dataURL / 타일 메타 호환
  }
  if (!capture || (!capture.dataUrl && !isTiled(capture))) {
    $('empty').style.display = 'block';
    return;
  }
  $('main').style.display = '';
  renderCaptureSelect();
  await showCaptureSafe(capture);
  await restoreOcrCache(capture.id);        // 이 캡처의 지난 OCR 결과가 있으면 자동 복원
  await restoreVisionState(capture.id);     // 비전 재실행 상태 복원 (fix 6)

  $('capSel').addEventListener('change', async () => {
    if (busyOp) return; // capSel 자체가 disabled 되지만 방어적으로 한 번 더 확인
    const c = await fetchCaptureById($('capSel').value);
    if (c) {
      capture = c;
      await showCaptureSafe(c);
      await restoreVisionState(c.id); // 비전 재실행 상태 복원 (fix 6)
      // 캡처를 바꿀 때마다 작품별 규칙 프로필도 다시 매칭한다 (여러 소설을 섞어 봐도
      // 항상 그 소설의 규칙/용어집이 적용되도록).
      autoSelectProfileForCapture();
      renderProfileSelect();
      loadProfileToUI();
      updateFnPreview();
      const restored = await restoreOcrCache(c.id); // 지난 OCR 결과 있으면 복원
      if (!restored) {
        setRawText('');
        $('ocrText').value = '';
        $('saveTxt').disabled = true;
        $('copyTxt').disabled = true;
        if (applyAutoLangs(c)) {
          setStatus(`캡처한 페이지 기준으로 OCR 언어가 자동 선택되었습니다 (${$('langKor').checked ? '한국어' : '中文'}).`);
        }
      }
    }
  });
  $('capDel').addEventListener('click', deleteCurrentCapture);
  $('capDelAll').addEventListener('click', deleteAllCaptures);
  $('runOcrAll').addEventListener('click', runOcrAll);

  // 일괄 다운로드
  renderBatchList();
  $('batchAll').addEventListener('click', () => {
    document.querySelectorAll('#batchList input[type=checkbox]').forEach((c) => { c.checked = true; });
    batchGroupControls.forEach((g) => g.sync()); // 그룹 헤더의 indeterminate 상태 재계산
  });
  $('batchNone').addEventListener('click', () => {
    document.querySelectorAll('#batchList input[type=checkbox]').forEach((c) => { c.checked = false; });
    batchGroupControls.forEach((g) => g.sync());
  });
  $('batchGo').addEventListener('click', runBatchDownload);
  $('batchOcrSelected').addEventListener('click', runOcrSelected);

  // 지난번에 선택했던 OCR 언어/옵션 복원
  const { ocrLangs, ocrOpts } = await chrome.storage.local.get(['ocrLangs', 'ocrOpts']);
  if (Array.isArray(ocrLangs)) {
    $('langChi').checked = ocrLangs.includes('chi_sim');
    $('langKor').checked = ocrLangs.includes('kor');
    $('langEng').checked = ocrLangs.includes('eng');
  }
  // 캡처한 페이지(도메인/제목) 기준 언어 자동 선택 — 판별되면 저장된 선택보다 우선
  if (applyAutoLangs(capture)) {
    setStatus(`캡처한 페이지 기준으로 OCR 언어가 자동 선택되었습니다 (${$('langKor').checked ? '한국어' : '中文'}).`);
  }
  if (ocrOpts) {
    $('optPrep').checked = ocrOpts.prep !== false;
    $('optBlock').checked = ocrOpts.block !== false;
    $('optAnnot').checked = ocrOpts.annot !== false;
    $('optPunct').checked = ocrOpts.punct !== false;
  }
  await initRules();
  $('applyRules').addEventListener('click', () => {
    persistRules();
    let t = removeWatermarks($('ocrText').value);
    if ($('optAnnot').checked) t = cleanBrokenAnnotations(t);
    t = applyRules(t, effectiveRules());
    t = applyGlossary(t);
    if ($('optPunct').checked) t = normalizePunct(t);
    $('ocrText').value = t;
    const has = t.trim().length > 0;
    $('saveTxt').disabled = !has;
    $('copyTxt').disabled = !has;
    const prof = currentProfile();
    setStatus(prof ? `교정 규칙 적용됨 (공통 + "${prof.name}")` : '교정 규칙 적용됨 (공통 규칙만)');
  });
  $('analyzeNames').addEventListener('click', showNameSuggestions);

  // AI 교정 설정 복원 + 실행 버튼
  const { aiProvider, aiKey, aiModel } = await chrome.storage.local.get(['aiProvider', 'aiKey', 'aiModel']);
  if (aiProvider) $('aiProvider').value = aiProvider;
  if (aiKey) $('aiKey').value = aiKey;
  populateModelSelect(aiModel);
  $('aiProvider').addEventListener('change', () => {
    populateModelSelect();
    chrome.storage.local.set({ aiProvider: $('aiProvider').value, aiModel: $('aiModel').value });
  });
  $('aiModel').addEventListener('change', () => {
    chrome.storage.local.set({ aiModel: $('aiModel').value });
    updateCostEstimate();
  });
  $('runAi').addEventListener('click', runAiCorrect);
  $('runVision').addEventListener('click', runAiVisionOcr);

  // TXT/이미지 저장 위치 설정 복원 + 변경 저장
  const { saveSubfolder, saveAsDialog } = await chrome.storage.local.get(['saveSubfolder', 'saveAsDialog']);
  if (typeof saveSubfolder === 'string') { saveSettings.subfolder = saveSubfolder; $('saveSubfolder').value = saveSubfolder; }
  saveSettings.saveAs = !!saveAsDialog;
  $('saveAsDialog').checked = saveSettings.saveAs;
  $('saveSubfolder').addEventListener('input', () => {
    saveSettings.subfolder = $('saveSubfolder').value;
    chrome.storage.local.set({ saveSubfolder: saveSettings.subfolder });
  });
  $('saveAsDialog').addEventListener('change', () => {
    saveSettings.saveAs = $('saveAsDialog').checked;
    chrome.storage.local.set({ saveAsDialog: saveSettings.saveAs });
  });

  await initFileNameSettings(); // 파일 이름 순서 설정 (이미지·OCR·일괄다운로드·텍스트 바로 저장 공통)

  // OCR 원문 ↔ 교정본 비교 토글
  $('toggleRaw').addEventListener('click', () => {
    const ta = $('ocrText');
    if (!rawView) {
      correctedCache = ta.value;
      ta.value = rawOcrText;
      ta.readOnly = true;
      rawView = true;
      $('toggleRaw').textContent = '🔁 교정본 보기';
      setStatus('OCR 원문(후처리 전)을 표시 중 — 읽기 전용입니다.');
    } else {
      ta.value = correctedCache;
      ta.readOnly = false;
      rawView = false;
      $('toggleRaw').textContent = '🔁 원문 보기';
      setStatus('교정본을 표시 중입니다.');
    }
  });

  // ⇔ 나란히 비교: 오른쪽에 OCR 원문 창을 띄운다
  $('compareRaw').addEventListener('click', () => {
    const pane = $('ocrRaw');
    const on = pane.style.display === 'none';
    if (on) {
      pane.value = rawOcrText;
      pane.style.display = '';
      $('compareRaw').textContent = '✖ 비교 닫기';
      setStatus('왼쪽=교정본(편집 가능), 오른쪽=OCR 원문. 나란히 비교 중입니다.');
    } else {
      pane.style.display = 'none';
      $('compareRaw').textContent = '⇔ 나란히 비교';
    }
  });

  // 실패 타일 재실행 버튼
  $('retryVisionTiles').addEventListener('click', retryFailedVisionTiles);

  // 중단 지점 재개 / 실패 화 재실행 버튼
  const { contSession: cs, lastChapterRun: lr } =
    await chrome.storage.local.get(['contSession', 'lastChapterRun']);
  if (cs && cs.active && cs.paused && cs.expectUrl) {
    const b = $('runResume');
    b.style.display = '';
    b.addEventListener('click', async () => {
      await chrome.storage.local.set({ contSession: { ...cs, paused: false, startedAt: Date.now() } });
      chrome.tabs.create({ url: cs.expectUrl });
    });
  }
  if (lr && Array.isArray(lr.failed) && lr.failed.length) {
    const b = $('runRetryFailed');
    b.style.display = '';
    b.textContent = `⟲ 실패 화 재실행 (${lr.failed.length})`;
    b.title = lr.failed.map((f) => f.label || f.url).join('\n');
    b.addEventListener('click', async () => {
      const urls = lr.failed.map((f) => f.url).filter(Boolean);
      if (!urls.length) return;
      await chrome.storage.local.set({
        contSession: {
          active: true, paused: false, startedAt: Date.now(),
          siteId: lr.siteId, expectUrl: urls[0], queue: urls.slice(1),
          clipX: lr.clipX, clipY: lr.clipY, clipW: lr.clipW,
          part: 1, remaining: urls.length, failed: []
        }
      });
      await chrome.storage.local.remove('lastChapterRun');
      chrome.tabs.create({ url: urls[0] });
    });
  }

  $('savePng').addEventListener('click', () => saveImage('png'));
  $('saveJpg').addEventListener('click', () => saveImage('jpg'));
  $('runOcr').addEventListener('click', runOcr);
  $('saveTxt').addEventListener('click', saveTxt);
  $('copyTxt').addEventListener('click', copyTxt);
  let editCacheTimer = null;
  $('ocrText').addEventListener('input', () => {
    const has = $('ocrText').value.trim().length > 0;
    $('saveTxt').disabled = !has;
    $('copyTxt').disabled = !has;
    if (rawView) return; // 원문 보기 중(읽기전용)에는 캐시하지 않음
    clearTimeout(editCacheTimer); // 수동 편집도 캐시에 반영 (fix 9, 디바운스)
    editCacheTimer = setTimeout(() => { if (ocrDone) cacheOcrResult(capture && capture.id); }, 1200);
  });
}

// ---------- 파일 이름 구성(설정 가능) ----------
// 사용자가 「⚙️ 설정」에서 등록한 도메인→줄임말 매핑. 정확히 일치하는 호스트가 없으면
// 상위 도메인(예: "jjwxc.net" 등록 시 "m.jjwxc.net"에도 적용)까지 확인한다.
let siteTagOverrides = {};
function fnSiteTagOverride(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
  if (siteTagOverrides[host]) return siteTagOverrides[host];
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const suf = parts.slice(i).join('.');
    if (siteTagOverrides[suf]) return siteTagOverrides[suf];
  }
  return '';
}

// 사이트 태그: 사용자 설정이 있으면 그것을 최우선으로 쓰고, 없으면 내장 규칙을 쓴다.
// 내장: 카카오페이지 kk / jjwxc 데스크톱 jj / jjwxc 모바일 mjj / 起点(qidian·qdmm) qd / 기타 호스트명
function fnSiteTag(url) {
  url = url || '';
  const override = fnSiteTagOverride(url);
  if (override) return override;
  if (/jjwxc\.net/i.test(url)) {
    if (/[?&]novelid=\d+/.test(url)) return 'jj';
    if (/\/(?:book2|vip)\/\d+\/\d+/.test(url)) return 'mjj';
  }
  if (/(?:qdmm|qidian)\.com/i.test(url)) return 'qd';
  if (/page\.kakao\.com/i.test(url)) return 'kk';
  try { return (new URL(url).hostname.replace(/^www\./, '').split('.')[0] || 'cap').slice(0, 8); }
  catch (_) { return 'cap'; }
}

// URL만으로 소설(작품)번호·화번호를 추정한다. 일반 드래그/요소 선택 캡처는 챕터
// 메타데이터(cap.workId/cap.chapterKey)를 따로 저장하지 않으므로(화 단위 연속 캡처만
// 저장함), 그 값이 비어 있을 때 URL 재해석으로 보완해야 한다 — 예전 idTagFromUrl()이
// 항상 URL을 다시 읽어 만들던 방식과 동등하게 맞춘 것.
function fnIdsFromUrl(url) {
  url = url || '';
  const n = /[?&]novelid=(\d+)/.exec(url), c = /[?&]chapterid=(\d+)/.exec(url);
  if (n) return { workId: n[1], chapterKey: c ? c[1] : '' };
  const m = /\/(?:book2|vip)\/(\d+)\/(\d+)/.exec(url);
  if (m) return { workId: m[1], chapterKey: m[2] };
  const q = /(?:qdmm|qidian)\.com\/chapter\/(\d+)\/(\d+)/.exec(url);
  if (q) return { workId: q[1], chapterKey: q[2] };
  const k = /page\.kakao\.com\/content\/(\d+)(?:\/viewer\/(\d+))?/.exec(url);
  if (k) return { workId: k[1], chapterKey: k[2] || '' };
  return { workId: '', chapterKey: '' };
}

const FN_TOKENS = {
  site: { label: '사이트', get: (i) => i.site },
  workId: { label: '소설(작품)번호', get: (i) => i.workId || '' },
  chapterKey: { label: '화(챕터)번호', get: (i) => i.chapterKey || '' },
  date: { label: '날짜(YYMMDD)', get: (i) => i.dateOnly },
  datetime: { label: '날짜+시간(YYMMDD_HHMM)', get: (i) => i.dateTime },
  part: { label: '부번호(part)', get: (i) => (i.part && i.part > 1 ? 'p' + i.part : '') },
  // 텍스트 출처 구분: 로컬 OCR만 = 없음 / 로컬+AI 교정 = fix / AI 비전 OCR = AI.
  // v2.16.0에서 파일명을 토큰 순서 설정으로 바꾸면서 이 접미사가 항상 맨 뒤에
  // 고정으로만 붙고 순서 설정에는 나타나지 않았는데, 이제 다른 토큰과 똑같이
  // 순서를 정할 수 있는 항목으로 되돌린다.
  source: { label: '텍스트 출처(_fix/_AI)', get: (i) => i.source || '' }
};
const FN_DEFAULT_SLOTS = ['site', 'workId', 'date', 'chapterKey', 'part', 'source'];
let fileNameSlots = FN_DEFAULT_SLOTS.slice();

// 캡처(또는 현재 페이지) 정보 → 토큰 계산에 쓸 info 객체.
// source: 'local'(접미사 없음) | 'fixed'(_fix) | 'vision'(_AI). 생략하면 현재 세션의
// 전역 textSource를 쓴다 — 단, 일괄 다운로드처럼 항상 로컬 OCR만 쓰는 경로는 무관한
// 전역 상태가 섞여 들어가지 않도록 호출부에서 명시적으로 'local'을 넘긴다.
function fnInfoFromCapture(cap, source) {
  const d = cap && cap.capturedAt ? new Date(cap.capturedAt) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateOnly = `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const urlIds = fnIdsFromUrl(cap && cap.pageUrl);
  const src = source !== undefined ? source : textSource;
  return {
    site: fnSiteTag(cap && cap.pageUrl),
    workId: (cap && cap.workId) || urlIds.workId,
    chapterKey: (cap && cap.chapterKey) || urlIds.chapterKey,
    dateOnly,
    dateTime: `${dateOnly}_${pad(d.getHours())}${pad(d.getMinutes())}`,
    part: (cap && cap.part) || 1,
    source: src === 'vision' ? 'AI' : src === 'fixed' ? 'fix' : ''
  };
}

// slots(순서가 있는 토큰 id 배열) + info → 실제 파일명 문자열. 중복/미지정(none) 토큰은 건너뛴다.
function fnBuild(info, slots) {
  const list = Array.isArray(slots) && slots.length ? slots : FN_DEFAULT_SLOTS;
  const seen = new Set();
  const parts = [];
  for (const key of list) {
    if (!key || key === 'none' || seen.has(key)) continue;
    seen.add(key);
    const tok = FN_TOKENS[key];
    const v = tok && tok.get(info);
    if (v) parts.push(v);
  }
  return parts.join('_') || 'cap';
}

// 파일 기본명(설정된 순서 적용). source를 생략하면 현재 세션의 textSource를 쓴다.
function defaultBaseFor(cap, source) {
  return fnBuild(fnInfoFromCapture(cap, source), fileNameSlots);
}

// 사이트 태그 사용자 설정 목록을 그린다 (도메인 → 줄임말 매핑, 삭제 버튼 포함).
function renderSiteTagList() {
  const box = $('siteTagList');
  if (!box) return;
  box.innerHTML = '';
  const hosts = Object.keys(siteTagOverrides);
  if (!hosts.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:11px;color:#9aa6b8';
    empty.textContent = '등록된 사용자 설정이 없습니다 (기본: jjwxc.net→jj, m.jjwxc.net(book2/vip)→mjj, qidian/qdmm→qd, page.kakao.com→kk, 그 외 호스트명)';
    box.appendChild(empty);
    return;
  }
  hosts.forEach((host) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px';
    const txt = document.createElement('span');
    txt.textContent = `${host} → ${siteTagOverrides[host]}`;
    txt.style.cssText = 'font-family:monospace;flex:1';
    const del = document.createElement('button');
    del.textContent = '삭제';
    del.className = 'gray';
    del.style.cssText = 'padding:3px 8px;font-size:11px';
    del.addEventListener('click', () => {
      delete siteTagOverrides[host];
      chrome.storage.local.set({ siteTagOverrides });
      renderSiteTagList();
      updateFnPreview();
    });
    row.append(txt, del);
    box.appendChild(row);
  });
}

// 설정 패널의 파일 이름 순서 드롭다운 5개 + 사이트 태그 사용자 설정을 그리고,
// 저장된 설정을 불러와 반영한다.
async function initFileNameSettings() {
  const box = $('fnSlots');
  if (!box) return;
  const st = await chrome.storage.local.get(['fileNameConfig', 'siteTagOverrides']);
  if (Array.isArray(st.fileNameConfig) && st.fileNameConfig.length) fileNameSlots = st.fileNameConfig.slice();
  if (st.siteTagOverrides && typeof st.siteTagOverrides === 'object') siteTagOverrides = { ...st.siteTagOverrides };
  renderSiteTagList();
  const domainInput = $('siteTagDomain'), valueInput = $('siteTagValue'), addBtn = $('siteTagAdd');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const host = (domainInput.value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      const tag = (valueInput.value || '').trim().replace(/[^a-z0-9_-]/gi, '').slice(0, 12);
      if (!host || !tag) { setStatus('도메인과 태그를 모두 입력하세요.'); return; }
      siteTagOverrides[host] = tag;
      chrome.storage.local.set({ siteTagOverrides });
      domainInput.value = ''; valueInput.value = '';
      renderSiteTagList();
      updateFnPreview();
    });
  }
  box.innerHTML = '';
  const selects = [];
  for (let i = 0; i < 6; i++) {
    const sel = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = 'none'; noneOpt.textContent = '(없음)';
    sel.appendChild(noneOpt);
    for (const key of Object.keys(FN_TOKENS)) {
      const o = document.createElement('option');
      o.value = key; o.textContent = FN_TOKENS[key].label;
      sel.appendChild(o);
    }
    sel.value = fileNameSlots[i] || 'none';
    sel.addEventListener('change', () => {
      fileNameSlots = selects.map((s) => s.value);
      chrome.storage.local.set({ fileNameConfig: fileNameSlots });
      updateFnPreview();
    });
    selects.push(sel);
    box.appendChild(sel);
  }
  updateFnPreview();
}

function updateFnPreview() {
  const el = $('fnPreview');
  if (!el) return;
  const sample = capture
    ? fnInfoFromCapture(capture, textSource)
    : { site: 'mjj', workId: '8650107', chapterKey: '20', dateOnly: '260715', dateTime: '260715_1030', part: 2, source: 'fix' };
  el.textContent = fnBuild(sample, fileNameSlots) + '.txt';
}

// 저장 직전에 파일 이름을 물어본다. 기본값은 기존 자동 이름.
// 취소하면 null을 반환해 저장을 중단한다.
function askFilename(ext, defBase) {
  const def = defBase || defaultBaseFor(capture);
  let name = prompt(`저장할 파일 이름을 입력하세요 (확장자 .${ext} 자동 추가)`, def);
  if (name === null) return null; // 취소
  name = name.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\.(png|jpe?g|txt)$/i, '');
  if (!name) name = def;
  return `${name}.${ext}`;
}

// 설정 파일(규칙 JSON 등) 저장용 — 위치 설정과 무관하게 다운로드 폴더 루트에 저장
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, conflictAction: 'uniquify' }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}

// ---------- 이미지 저장 ----------
async function saveImage(format) {
  const filename = askFilename(format);
  if (filename === null) return; // 사용자가 취소
  try {
    // 타일/구버전 모두 imageBlobsFor 로 처리. 초대형 타일 캡처는 합성 대신
    // 타일별 파일로 나뉘어 반환되므로 파일명에 접미사를 붙여 저장한다.
    const files = await imageBlobsFor(capture, format);
    if (files.length === 1) {
      contentDownload(files[0].blob, filename);
    } else {
      const dot = filename.lastIndexOf('.');
      const base = dot > 0 ? filename.slice(0, dot) : filename;
      const ext = dot > 0 ? filename.slice(dot) : '.' + format;
      for (const f of files) contentDownload(f.blob, `${base}${f.suffix}${ext}`, { forceSaveAs: false });
      setStatus(`매우 큰 캡처라 타일 ${files.length}장으로 나눠 저장했습니다.`);
    }
  } catch (e) {
    console.error(e);
    setStatus('이미지 저장 실패: ' + (e && e.message ? e.message : e));
  }
}

// ---------- OCR ----------
function setStatus(text) { $('status').textContent = text; }
function setProgress(ratio) {
  const bar = $('progressBar');
  if (ratio == null) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  bar.firstElementChild.style.width = Math.round(ratio * 100) + '%';
}

// 이미지를 <img>로 로드
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 불러올 수 없습니다.'));
    img.src = src;
  });
}

// 캔버스를 회색조로 바꾸고 명암 대비를 정규화한다.
// 획이 조밀한 한자는 흑백 이진화 시 가는 획이 뭉개져 오인식이 급증하므로,
// 안티앨리어싱이 살아 있는 회색조를 유지한다 (LSTM 엔진에 최적).
// 어두운 배경(다크 테마)은 자동으로 반전해 "밝은 배경 + 어두운 글자"로 만든다.
function preprocessCanvas(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const p = imgData.data;
  const n = canvas.width * canvas.height;
  const gray = new Uint8Array(n);
  const hist = new Uint32Array(256);
  let lumaSum = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const g = (p[j] * 299 + p[j + 1] * 587 + p[j + 2] * 114) / 1000 | 0;
    gray[i] = g;
    hist[g]++;
    lumaSum += g;
  }
  // 평균 밝기가 어두우면 다크 테마 → 반전
  const invert = lumaSum / n < 128;
  if (invert) {
    hist.fill(0);
    for (let i = 0; i < n; i++) {
      gray[i] = 255 - gray[i];
      hist[gray[i]]++;
    }
  }
  // 명암 대비 정규화: 2%/98% 지점을 0/255로 선형 확장
  let lo = 0, hi = 255, acc = 0;
  const loCut = n * 0.02, hiCut = n * 0.98;
  for (let t = 0; t < 256; t++) {
    acc += hist[t];
    if (acc <= loCut) lo = t;
    if (acc <= hiCut) hi = t;
  }
  if (hi <= lo) { lo = 0; hi = 255; }
  const range = hi - lo;
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    let v = ((gray[i] - lo) * 255 / range) | 0;
    if (v < 0) v = 0; else if (v > 255) v = 255;
    p[j] = p[j + 1] = p[j + 2] = v;
    p[j + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
}

// 긴 이미지를 세로 구간으로 나눈다. 글줄을 자르지 않도록
// 목표 지점 주변에서 "잉크가 가장 적은 행"(문단 사이 여백)을 찾아 자른다.
function planCuts(img, tileH) {
  if (img.height <= tileH * 1.3) return [[0, img.height]];

  const P = 160; // 가로만 축소한 저해상도 프로브로 행별 잉크량 측정
  const probe = document.createElement('canvas');
  probe.width = P;
  probe.height = img.height;
  const pc = probe.getContext('2d', { willReadFrequently: true });
  pc.drawImage(img, 0, 0, P, img.height);
  const d = pc.getImageData(0, 0, P, img.height).data;

  // 배경 밝기 = 히스토그램 최빈값
  const hist = new Uint32Array(256);
  const total = P * img.height;
  for (let i = 0; i < total; i++) {
    const j = i * 4;
    hist[(d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000 | 0]++;
  }
  let bg = 0, mx = 0;
  for (let t = 0; t < 256; t++) if (hist[t] > mx) { mx = hist[t]; bg = t; }

  const activity = new Uint32Array(img.height);
  for (let y = 0; y < img.height; y++) {
    let a = 0;
    for (let x = 0; x < P; x++) {
      const j = (y * P + x) * 4;
      const g = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000 | 0;
      if (Math.abs(g - bg) > 40) a++;
    }
    activity[y] = a;
  }

  // 절단선은 반드시 "연속으로 잉크가 없는 여백 구간"의 중앙에 둔다.
  // 글줄 한가운데를 자르면 잘린 글자들이 통째로 오인식되기 때문.
  const lowThr = Math.max(1, Math.round(P * 0.01));
  const cuts = [];
  let y0 = 0;
  while (y0 < img.height) {
    const target = y0 + tileH;
    if (target >= img.height - tileH * 0.3) { cuts.push([y0, img.height]); break; }

    const from = Math.max(y0 + Math.floor(tileH / 2), target - 500);
    const to = Math.min(img.height - 2, target + 500);
    let best = -1, bestDist = Infinity, runStart = -1;
    for (let y = from; y <= to + 1; y++) {
      const low = y <= to && activity[y] <= lowThr;
      if (low && runStart < 0) runStart = y;
      if (!low && runStart >= 0) {
        const runLen = y - runStart;
        if (runLen >= 3) { // 3행 이상 이어지는 여백만 신뢰
          const center = runStart + (runLen >> 1);
          const dist = Math.abs(center - target);
          if (dist < bestDist) { bestDist = dist; best = center; }
        }
        runStart = -1;
      }
    }
    if (best < 0) { // 여백 구간을 못 찾으면 잉크가 가장 적은 행에서 자른다
      let bestA = Infinity;
      for (let y = from; y <= to; y++) {
        if (activity[y] < bestA) { bestA = activity[y]; best = y; }
      }
    }
    cuts.push([y0, best]);
    y0 = best;
  }
  return cuts;
}

// OCR 옵션(언어/보정)을 읽고 저장. 언어 미선택이면 null.
function readOcrOptions() {
  const langs = [];
  if ($('langChi').checked) langs.push('chi_sim'); // 주 사용 언어를 앞에 둔다
  if ($('langKor').checked) langs.push('kor');
  if ($('langEng').checked) langs.push('eng');
  if (langs.length === 0) {
    setStatus('언어를 하나 이상 선택해 주세요.');
    return null;
  }
  const prep = $('optPrep').checked;
  const block = $('optBlock').checked;
  const annot = $('optAnnot').checked;
  const punct = $('optPunct').checked;
  chrome.storage.local.set({ ocrLangs: langs, ocrOpts: { prep, block, annot, punct } });
  return { langs, prep, block, annot, punct };
}

// 엔진 파일 접근 가능 여부 사전 점검
async function preflightEngine() {
  try {
    const r = await fetch(chrome.runtime.getURL('lib/worker.min.js'));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return true;
  } catch (e) {
    setStatus('OCR 엔진 파일(lib/worker.min.js)을 읽을 수 없습니다. chrome://extensions에서 확장을 새로고침한 뒤 이 탭을 닫고 다시 열어 주세요.');
    return false;
  }
}

// 진행 표시 공유 객체: base/span은 일괄 OCR에서 이미지별 진행 구간을 나눌 때 사용
async function createOcrWorker(langs, block, tileInfo) {
  const worker = await Tesseract.createWorker(langs, 1, {
    workerPath: chrome.runtime.getURL('lib/worker.min.js'),
    corePath: chrome.runtime.getURL('lib/'),
    langPath: chrome.runtime.getURL('tessdata/'),
    workerBlobURL: false, // 확장 CSP에서는 Blob worker의 importScripts가 차단됨
    gzip: true,
    cacheMethod: 'none',  // 언어 데이터를 항상 확장 내 최신 파일에서 로드
    logger: (m) => {
      if (m.status === 'recognizing text') {
        const overall = (tileInfo.i + m.progress) / tileInfo.n;
        const seg = tileInfo.n > 1 ? ` (${tileInfo.i + 1}/${tileInfo.n} 구간)` : '';
        setStatus(`${tileInfo.prefix}텍스트 인식 중${seg}… ${Math.round(overall * 100)}%`);
        setProgress(tileInfo.base + overall * tileInfo.span);
      } else if (m.status) {
        setStatus(tileInfo.prefix + m.status + '…');
      }
    }
  });
  await worker.setParameters({
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
    ...(block ? { tessedit_pageseg_mode: '6' } : {})
  });
  return worker;
}

// 캡처 이미지 1장 인식 (전처리 + 구간 분할 포함). 후처리는 하지 않는다.
// 캡처 한 장을 인식한다. 타일 캡처는 각 타일을 하나씩 불러와 처리하므로
// OCR 중에도 전체 장문 이미지를 메모리에 동시에 올리지 않는다.
// 타일 경계는 겹침(overlapContext)을 포함해 인식한 뒤 mergeTextOverlap 으로 중복 문장을 합친다.
async function ocrOneImage(worker, cap, prep, tileInfo) {
  const descriptors = capturePartDescriptors(cap, 72);

  // 확대 배율: 화면 배율(dpr)이 낮을수록 크게 확대해서 글자를 키운다.
  // Tesseract는 글자 높이 30px 이상에서 정확도가 크게 오른다.
  const dpr = cap.dpr || 1;
  let baseScale = prep ? Math.min(4, Math.max(2, 3.5 / dpr)) : 1;
  baseScale = Math.max(1, Math.min(baseScale, 6000 / Math.max(1, cap.width || 1))); // 폭 안전 한도
  const sourceTileH = Math.max(180, Math.floor(4000 / baseScale));
  // 진행률 표시용 예상 구간 수
  tileInfo.n = Math.max(1, descriptors.reduce((sum, d) => {
    const h = d.type === 'tile' ? (d.meta.coreHeight + d.overlapContext * 2) : (cap.height || sourceTileH);
    return sum + Math.max(1, Math.ceil(h / sourceTileH));
  }, 0));

  let text = '', confSum = 0, confLen = 0, taskIndex = 0;
  const PAD = 32; // 글자가 가장자리에 닿으면 끝 글자를 누락하므로 흰 여백을 두른다
  for (const desc of descriptors) {
    const part = await loadCapturePart(desc);
    let partText = '';
    try {
      // 이 조각(타일 또는 전체 이미지)의 유효 영역만 소스 캔버스로 뽑아낸다.
      const source = document.createElement('canvas');
      source.width = part.img.width;
      source.height = part.height;
      const sctx = source.getContext('2d');
      sctx.fillStyle = '#fff'; sctx.fillRect(0, 0, source.width, source.height);
      sctx.drawImage(part.img, 0, part.top, part.img.width, part.height, 0, 0, source.width, source.height);

      const scale = Math.max(1, Math.min(baseScale, 6000 / source.width));
      const cuts = planCuts(source, Math.max(180, Math.floor(4000 / scale)));
      for (const [a, b] of cuts) {
        tileInfo.i = Math.min(taskIndex++, tileInfo.n - 1);
        const tile = document.createElement('canvas');
        tile.width = Math.max(1, Math.round(source.width * scale));
        tile.height = Math.max(1, Math.round((b - a) * scale));
        const tctx = tile.getContext('2d');
        tctx.imageSmoothingEnabled = true;
        tctx.imageSmoothingQuality = 'high';
        tctx.fillStyle = '#ffffff';
        tctx.fillRect(0, 0, tile.width, tile.height);
        tctx.drawImage(source, 0, a, source.width, b - a, 0, 0, tile.width, tile.height);
        if (prep) preprocessCanvas(tile); // 전처리(반전 포함) 후에 여백을 둘러야 테두리가 검게 반전되지 않는다

        const padded = document.createElement('canvas');
        padded.width = tile.width + PAD * 2;
        padded.height = tile.height + PAD * 2;
        const pctx = padded.getContext('2d');
        pctx.fillStyle = '#ffffff';
        pctx.fillRect(0, 0, padded.width, padded.height);
        pctx.drawImage(tile, PAD, PAD);

        const { data } = await worker.recognize(padded);
        const t = (data.text || '').trim();
        if (t) {
          // 같은 소스(타일/이미지) 안의 인접 cut은 이미지가 겹치지 않는다. 여기서 병합하면
          // 경계의 정당한 반복 줄(같은 대사·구분선 등)이 삭제되므로 줄바꿈으로만 잇는다.
          partText = partText ? partText + '\n' + t : t;
          confSum += (data.confidence || 0) * t.length;
          confLen += t.length;
        }
        tile.width = tile.height = padded.width = padded.height = 1; // 메모리 회수
      }
      source.width = source.height = 1;
    } finally {
      if (part.url) URL.revokeObjectURL(part.url);
    }
    // 서로 다른 저장 타일은 overlapContext만큼 이미지가 겹치므로 경계 중복은 병합으로 제거한다.
    text = mergeTextOverlap(text, partText);
  }
  return { text, confSum, confLen };
}

// 문장부호 통일: 영어에도 있는 부호는 반각(ASCII)으로, 중국어 고유 부호(。、《》 등)는 유지
function normalizePunct(text) {
  return text
    // 전각 ASCII 영역(！ ？ ： ； （） ％ 등) → 반각. 。、《》【】는 이 영역 밖이라 유지됨
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/　/g, ' ')   // 전각 공백
    .replace(/…+/g, '...')
    .replace(/\.{4,}/g, '...');
}

// jjwxc 본문 뒤에 딸려 들어온 댓글/영양액 UI 영역을 잘라낸다.
// 마커가 텍스트 후반부에서 발견될 때만 자른다 (본문 오탐 방지).
function cleanJjwxcTail(text) {
  const markers = ['浅水炸弹', '深水鱼雷', '瓶营养液', '营养液规则', '评论主题',
                   '交流灌水', '不看TA的评论', '完结评分', '喷糖功能', '发布负分评论',
                   '插入书签', '作者有话说', '霸王票', '点晋江币', '← 上一章', '上一章下一章'];
  let cut = -1;
  for (const m of markers) {
    const i = text.indexOf(m);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  if (cut > text.length * 0.5) {
    const lineStart = text.lastIndexOf('\n', cut);
    return text.slice(0, lineStart > 0 ? lineStart : cut).replace(/\s+$/, '');
  }
  return text;
}

// 공통 후처리: 공백 정리 → 워터마크 제거 → 댓글 영역 제거 → 괄호 주석 정리 → 교정 규칙 → 부호 통일
function postprocessText(text, annot) {
  text = cleanCjkSpaces((text || '').trim());
  text = removeWatermarks(text);
  text = cleanJjwxcTail(text);
  if (annot) text = cleanBrokenAnnotations(text);
  text = applyRules(text, effectiveRules());
  text = applyGlossary(text); // 용어집(원문↔교정 표기) 적용
  if ($('optPunct').checked) text = normalizePunct(text);
  return text;
}

// 특정 캡처가 속한 작품 프로필을 찾는다(부수효과 없음 — 배치 처리용).
function findProfileForCapture(cap) {
  const url = (cap && cap.pageUrl) || '';
  if (!url) return null;
  const hit = rulesState.profiles.find((p) => profileMatchesUrl(p, url));
  if (hit) return hit;
  const match = guessMatchFromUrl(url);
  if (!match) return null;
  return rulesState.profiles.find((p) => p.match === match) || null;
}

// 캡처마다 '그 캡처가 속한 작품'의 규칙·용어집으로 후처리한다. 여러 작품의 캡처를 함께
// 일괄 처리할 때, 전역 선택 작품(A)의 규칙/용어집이 다른 작품(B) 캡처에 잘못 적용되는
// 오염을 막는다. 프로필을 못 찾으면 공통 규칙만 적용한다(작품별 치환은 생략).
async function postprocessTextForCapture(text, annot, cap) {
  const prof = findProfileForCapture(cap);
  const gloss = prof ? await loadGlossaryFor(prof.id) : [];
  text = cleanCjkSpaces((text || '').trim());
  text = removeWatermarks(text);
  text = cleanJjwxcTail(text);
  if (annot) text = cleanBrokenAnnotations(text);
  text = applyRules(text, effectiveRulesForProfile(prof));
  text = applyGlossaryWith(text, gloss);
  if ($('optPunct').checked) text = normalizePunct(text);
  return text;
}

function finishOcrOutput(text, confSum, confLen, label, collect = true) {
  $('ocrText').value = text;
  ocrDone = true;
  textSource = 'local'; // 로컬 OCR 결과
  const has = text.trim().length > 0;
  $('saveTxt').disabled = !has;
  $('copyTxt').disabled = !has;
  const conf = confLen ? Math.round(confSum / confLen) : 0;
  setStatus(has
    ? `${label} — ${text.length}자 인식 (신뢰도 ${conf}%)`
    : `${label} — 인식된 텍스트가 없습니다. 이미지가 선명한지 확인해 보세요.`);
  // 여러 작품이 섞일 수 있는 일괄 OCR에서는 이름을 현재 작품에 잘못 병합하지 않도록 collect=false.
  if (has && collect) autoCollectNames(text);
}

// OCR 시 인물 자동 수집 (옵션 켜져 있고 작품이 선택된 경우)
function autoCollectNames(text) {
  if (!$('namesAuto') || !$('namesAuto').checked) return;
  if (!currentProfile()) return;
  const added = mergeNames(collectNames(text).map((c) => c.name));
  if (added) {
    const cur = $('status').textContent || '';
    setStatus((cur ? cur + ' · ' : '') + `👤 인물 ${added}명 자동 추가`);
  }
}

// 현재 표시 중인 캡처 1장 OCR
async function runOcr() {
  const opts = readOcrOptions();
  if (!opts) return;
  const btn = $('runOcr'), btnAll = $('runOcrAll');
  btn.disabled = true; btnAll.disabled = true;
  setBusyOp(true);
  setStatus('OCR 엔진 로딩 중…');
  setProgress(0);
  if (!(await preflightEngine())) { setProgress(null); btn.disabled = false; btnAll.disabled = false; setBusyOp(false); return; }

  let worker = null;
  const tileInfo = { i: 0, n: 1, prefix: '', base: 0, span: 1 };
  try {
    worker = await createOcrWorker(opts.langs, opts.block, tileInfo);
    const r = await ocrOneImage(worker, capture, opts.prep, tileInfo);
    const text = postprocessText(r.text, opts.annot);
    setRawText(r.text);
    persistRules();
    finishOcrOutput(text, r.confSum, r.confLen, '완료');
    cacheOcrResult(capture && capture.id);
  } catch (e) {
    console.error(e);
    setStatus('OCR 실패: ' + (e && e.message ? e.message : e));
  } finally {
    setProgress(null);
    btn.disabled = false;
    btnAll.disabled = captureIndex.length === 0;
    setBusyOp(false);
    if (worker) { try { await worker.terminate(); } catch (_) {} }
  }
}

// 저장된 모든 캡처를 캡처된 순서(오래된 것부터)로 OCR해서 하나로 합친다
// entries(오래된 것부터 정렬된 캡처 목록 항목 배열)를 순서대로 OCR해서 하나로 합친다.
// runOcrAll(전체)과 runOcrSelected(체크한 것만)가 공유하는 본체.
async function runOcrOnEntries(entries, completeLabel) {
  const opts = readOcrOptions();
  if (!opts) return;
  if (!entries.length) { setStatus('OCR할 캡처가 없습니다.'); return; }

  const btns = [$('runOcr'), $('runOcrAll'), $('batchOcrSelected')].filter(Boolean);
  btns.forEach((b) => { b.disabled = true; });
  setBusyOp(true);
  setStatus('OCR 엔진 로딩 중…');
  setProgress(0);
  if (!(await preflightEngine())) {
    setProgress(null);
    btns.forEach((b) => { b.disabled = false; });
    setBusyOp(false);
    return;
  }

  let worker = null;
  const tileInfo = { i: 0, n: 1, prefix: '', base: 0, span: 1 / entries.length };
  try {
    worker = await createOcrWorker(opts.langs, opts.block, tileInfo);
    const out = [];
    const rawParts = [];
    let confSum = 0, confLen = 0;
    for (let k = 0; k < entries.length; k++) {
      const cap = await fetchCaptureById(entries[k].id);
      if (!cap) continue;
      tileInfo.prefix = `[${k + 1}/${entries.length}] `;
      tileInfo.base = k / entries.length;
      const r = await ocrOneImage(worker, cap, opts.prep, tileInfo);
      const t = await postprocessTextForCapture(r.text, opts.annot, cap); // 캡처별 작품 규칙/용어집
      if (t) out.push(t);
      if (r.text) rawParts.push(r.text.trim());
      confSum += r.confSum;
      confLen += r.confLen;
    }
    setRawText(rawParts.join('\n\n'));
    persistRules();
    finishOcrOutput(out.join('\n\n'), confSum, confLen, completeLabel(entries.length), false);
  } catch (e) {
    console.error(e);
    setStatus('일괄 OCR 실패: ' + (e && e.message ? e.message : e));
  } finally {
    setProgress(null);
    btns.forEach((b) => { b.disabled = false; });
    setBusyOp(false);
    if (worker) { try { await worker.terminate(); } catch (_) {} }
  }
}

// 저장된 모든 캡처를 캡처된 순서(오래된 것부터)로 OCR해서 하나로 합친다
async function runOcrAll() {
  const opts = readOcrOptions();
  if (!opts) return;
  const entries = [...captureIndex].reverse(); // index는 최신순 → 캡처 순서로 뒤집기
  if (entries.length <= 1) { runOcr(); return; }
  if (!confirm(`저장된 캡처 ${entries.length}개를 순서대로 모두 OCR할까요?\n(캡처 수에 비례해 시간이 걸립니다)`)) return;
  await runOcrOnEntries(entries, (n) => `전체 완료 (캡처 ${n}개)`);
}

// 「📦 일괄 다운로드」 체크박스에서 선택한 캡처만 순서대로 OCR해서 하나로 합친다.
// 파일로 바로 저장하지는 않고(기존 일괄 다운로드의 텍스트 저장과 별개), ②번 텍스트
// 칸에 결과를 채워 검토·수정 후 직접 TXT로 저장할 수 있게 한다.
async function runOcrSelected() {
  const checkedIds = [...document.querySelectorAll('#batchList .batch-item-cb:checked')].map((c) => c.value);
  if (!checkedIds.length) {
    setStatus('먼저 아래 「📦 일괄 다운로드」 목록에서 OCR할 캡처를 체크하세요.');
    return;
  }
  const idSet = new Set(checkedIds);
  const entries = [...captureIndex].reverse().filter((e) => idSet.has(e.id)); // 오래된 것부터
  if (!confirm(`선택한 캡처 ${entries.length}개를 순서대로 OCR해서 ②번 텍스트 칸에 합칠까요?`)) return;
  await runOcrOnEntries(entries, (n) => `선택 항목 완료 (캡처 ${n}개)`);
}

// ---------- 인명 오인식 자동 감지 ----------
// 자주 나오는 2~3자 한자 조합을 세고, 한 글자만 다른 변형끼리 묶어서
// "소수 변형 → 다수 변형" 교정 규칙 후보를 만든다.
// (같은 인명이 여러 형태로 오인식되는 패턴을 잡는 용도)
// ---------- 인물 사전 자동 수집 ----------
// 흔한 중국어 성씨 (2~3자 이름의 첫 글자 앵커로 사용)
const CN_SURNAMES = new Set(('王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾' +
  '肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛' +
  '闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严赖覃洪武莫孔沈慕容欧阳司马上官').split(''));
// 이름이 아닌 흔한 중국어 2~3자 조합 (오수집 방지)
const CN_STOP = new Set(['什么', '怎么', '这么', '那么', '一个', '自己', '知道', '时候', '现在',
  '可能', '没有', '因为', '所以', '如果', '不是', '就是', '这样', '那样', '一下', '一样', '起来',
  '出来', '过来', '进来', '回来', '这个', '那个', '他们', '我们', '你们', '还是', '已经', '看到',
  '觉得', '东西', '事情', '样子', '这些', '那些', '不过', '只是', '有点', '一点', '有些']);
// 한국어 조사·흔한 어미 (토큰 끝에서 제거)
const KO_JOSA = ['으로서', '으로써', '에게서', '이라고', '라고', '에게', '한테', '께서', '이야', '으로',
  '에서', '까지', '부터', '보다', '이랑', '처럼', '만큼', '조차', '마저', '은', '는', '이', '가', '을',
  '를', '의', '에', '와', '과', '도', '만', '고', '님', '아', '야', '씨'];
const KO_STOP = new Set(['그리고', '하지만', '그러나', '그래서', '그런데', '이것', '저것', '그것',
  '여기', '거기', '저기', '자신', '순간', '사람', '생각', '모습', '목소리', '얼굴', '마음', '자기',
  '지금', '오늘', '내일', '어제', '조금', '정말', '가장', '모두', '다시', '아직', '이미', '결국']);

// 텍스트에서 인물 이름 후보를 빈도 기반으로 추출한다.
function collectNames(text) {
  const cand = new Map(); // name -> score
  const add = (n, s) => cand.set(n, (cand.get(n) || 0) + s);

  // --- 중국어: 성씨로 시작하는 2~3자 + 고빈도 2자 ---
  const chars = Array.from(text);
  const isHan = (c) => c >= '一' && c <= '鿿';
  const freq2 = new Map(), freq3 = new Map();
  for (let i = 0; i < chars.length; i++) {
    if (isHan(chars[i]) && isHan(chars[i + 1])) {
      const g2 = chars[i] + chars[i + 1];
      freq2.set(g2, (freq2.get(g2) || 0) + 1);
      if (isHan(chars[i + 2])) {
        const g3 = g2 + chars[i + 2];
        freq3.set(g3, (freq3.get(g3) || 0) + 1);
      }
    }
  }
  for (const [g, c] of freq2) {
    if (c < 3 || CN_STOP.has(g)) continue;
    if (CN_SURNAMES.has(g[0])) add(g, c * 3);        // 성씨 앵커 → 강한 신호
    else if (c >= 6) add(g, c);                       // 성씨 아니어도 매우 잦으면 후보
  }
  for (const [g, c] of freq3) {
    if (c < 3) continue;
    if (CN_SURNAMES.has(g[0])) add(g, c * 3);
  }

  // --- 한국어: 공백 토큰에서 조사 제거 후 고빈도 ---
  const kfreq = new Map();
  for (const raw of text.split(/[^가-힣]+/)) {
    if (!raw) continue;
    let tok = raw;
    for (const j of KO_JOSA) { if (tok.length - j.length >= 2 && tok.endsWith(j)) { tok = tok.slice(0, -j.length); break; } }
    if (tok.length < 2 || tok.length > 4 || KO_STOP.has(tok)) continue;
    kfreq.set(tok, (kfreq.get(tok) || 0) + 1);
  }
  for (const [t, c] of kfreq) if (c >= 4) add(t, c);

  return [...cand.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, score]) => ({ name, score }))
    .slice(0, 40);
}

function analyzeNameVariants(text) {
  const counts = new Map();
  const chars = Array.from(text);
  const isCjk = (c) => c >= '一' && c <= '鿿';
  for (const len of [2, 3]) {
    for (let i = 0; i + len <= chars.length; i++) {
      let ok = true;
      for (let k = 0; k < len; k++) if (!isCjk(chars[i + k])) { ok = false; break; }
      if (!ok) continue;
      const seq = chars.slice(i, i + len).join('');
      counts.set(seq, (counts.get(seq) || 0) + 1);
    }
  }
  // 3회 이상 등장한 조합만 대상으로
  const frequent = [...counts.entries()].filter(([, c]) => c >= 3);
  const suggestions = [];
  for (const [minor, minorCnt] of frequent) {
    let best = null;
    for (const [major, majorCnt] of frequent) {
      if (major === minor || major.length !== minor.length) continue;
      // 정확히 한 글자만 다른가?
      let diff = 0;
      for (let k = 0; k < minor.length; k++) if (minor[k] !== major[k]) diff++;
      if (diff !== 1) continue;
      // 다수 변형이 소수 변형의 2배 이상일 때만 후보로
      if (majorCnt >= minorCnt * 2 && majorCnt >= 5) {
        if (!best || majorCnt > best.cnt) best = { seq: major, cnt: majorCnt };
      }
    }
    if (best) suggestions.push({ from: minor, to: best.seq, fromCnt: minorCnt, toCnt: best.cnt });
  }
  // 같은 from에 대해 가장 강한 후보만, 빈도순 정렬
  suggestions.sort((a, b) => b.toCnt - a.toCnt || b.fromCnt - a.fromCnt);
  return suggestions.slice(0, 20);
}

function showNameSuggestions() {
  const box = $('nameSuggest');
  box.innerHTML = '';
  const text = $('ocrText').value;
  if (!text.trim()) {
    box.textContent = '분석할 텍스트가 없습니다. 먼저 OCR을 실행하세요.';
    box.style.cssText = 'font-size:12px;color:#9aa6b8;margin-top:8px';
    return;
  }
  const sug = analyzeNameVariants(text);
  if (sug.length === 0) {
    box.textContent = '오인식 변형 후보를 찾지 못했습니다. (같은 표기가 충분히 반복될 때 감지됩니다)';
    box.style.cssText = 'font-size:12px;color:#9aa6b8;margin-top:8px';
    return;
  }
  const info = document.createElement('div');
  info.textContent = '아래 후보를 눌러 작품별 규칙에 추가하세요 (숫자는 등장 횟수):';
  info.style.cssText = 'font-size:12px;color:#c3cbd8;margin:4px 0 6px';
  box.appendChild(info);
  for (const s of sug) {
    const b = document.createElement('button');
    b.className = 'gray';
    b.style.cssText = 'margin:0 6px 6px 0;font-weight:400;font-size:12px;padding:5px 10px';
    b.textContent = `${s.from}(${s.fromCnt}) → ${s.to}(${s.toCnt}) ➕`;
    b.addEventListener('click', () => {
      const prof = currentProfile();
      const line = `${s.from}=${s.to}`;
      let where;
      if (prof) {
        prof.rules = prof.rules.replace(/\s*$/, '') + '\n' + line;
        $('rulesProfile').value = prof.rules;
        where = prof.name;
      } else {
        // 인명은 한자이므로 중국어 공통 규칙에 추가
        const lang = 'chi';
        rulesState.globalByLang[lang] = (rulesState.globalByLang[lang] || '').replace(/\s*$/, '') + '\n' + line;
        if (rulesState.editingLang === lang) $('rulesGlobal').value = rulesState.globalByLang[lang];
        where = `공통·${GLOBAL_LANG_LABEL[lang]}`;
      }
      persistRules();
      $('ocrText').value = applyRules($('ocrText').value, [[s.from, s.to]]);
      b.disabled = true;
      b.textContent = `${s.from} → ${s.to} ✔ 추가됨`;
      setStatus(`규칙 추가 및 적용: ${line} (${where})`);
    });
    box.appendChild(b);
  }
}

// ---------- AI 교정 (OpenAI / Anthropic API) ----------
function chunkText(text, max = 4000) {
  const lines = text.split('\n');
  const chunks = [];
  let cur = '';
  for (const ln of lines) {
    if (cur && cur.length + ln.length + 1 > max) { chunks.push(cur); cur = ln; }
    else cur = cur ? cur + '\n' + ln : ln;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function aiSystemPrompt() {
  let names = '';
  const prof = currentProfile();
  if (prof) {
    const set = new Set(parseRules(prof.rules).map(([, to]) => to));
    currentNames().forEach((n) => set.add(n)); // 인물 사전도 정답 표기로 포함
    if (set.size) names = `\n등장인물/고유명사 (이 표기가 정답): ${[...set].join(', ')}`;
  }
  // 마지막 OCR에 사용한 언어에 맞는 교정 지침을 만든다
  const kor = $('langKor').checked, chi = $('langChi').checked;
  let langDesc, errDesc;
  if (kor && !chi) {
    langDesc = '한국어';
    errDesc = '모양이 비슷한 한글 자모 혼동(예: 기봄→기쁨, 존제→존재, 결을→곁을)과 잘못된 띄어쓰기';
  } else if (kor && chi) {
    langDesc = '중국어와 한국어가 섞인';
    errDesc = '모양이 비슷한 한자/한글 오인식과 잘못된 띄어쓰기';
  } else {
    langDesc = '중국어';
    errDesc = '모양이 비슷한 한자 오인식';
  }
  return `당신은 ${langDesc} 소설 텍스트의 OCR 교정기입니다. 입력은 OCR 결과로, ` +
    `${errDesc}이(가) 섞여 있습니다. 문맥상 잘못된 부분만 최소한으로 교정하세요. ` +
    '문장을 다시 쓰거나 번역하거나 요약하지 말고, 줄바꿈과 문장부호를 그대로 유지하세요. ' +
    '주의: 어색해 보여도 의도된 표현일 수 있는 것들 — 별명·호칭·말장난·유행어·비속어·의성어 — 은 ' +
    '절대 "정상화"하지 마세요 (예: 인물이 장난으로 부르는 호칭을 정식 호칭으로 바꾸지 말 것). ' +
    '확신이 없으면 고치지 말고 그대로 두세요. 교정된 텍스트만 출력하고 다른 말은 하지 마세요.' + names;
}

// API 오류를 한국어 안내로 변환
function friendlyApiError(provider, status, body) {
  const name = provider === 'openai' ? 'OpenAI' : 'Anthropic';
  const site = provider === 'openai'
    ? 'platform.openai.com → Settings → Billing'
    : 'console.anthropic.com → Billing';
  if (/billing_not_active|insufficient_quota|credit balance is too low|purchase credits/i.test(body)) {
    return `${name} 계정에 사용 가능한 크레딧이 없습니다. ${site}에서 결제 수단 등록 후 크레딧을 충전하세요 (최소 $5). ` +
      'ChatGPT Plus/Claude Pro 같은 웹 구독과 API 크레딧은 별개입니다.';
  }
  if (status === 401) return `${name} API 키가 올바르지 않습니다. 키를 다시 확인해 주세요.`;
  if (status === 429) return `${name} 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.`;
  if (status === 529 || status === 503) return `${name} 서버가 혼잡합니다. 잠시 후 다시 시도하세요.`;
  return `${name} API 오류 ${status}: ${String(body).slice(0, 200)}`;
}

// 일부 모델은 temperature/top_p 지정 시 400을 반환하므로, 그런 경우 해당 파라미터를
// 빼고 1회 재시도한다. (temperature:0 유지가 원칙이나, 거부하는 모델은 자동 대응)
async function sendOpenAI(key, body) {
  const doFetch = (b) => fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(b)
  });
  let r = await doFetch(body);
  if (r.status === 400 && 'temperature' in body) {
    const txt = await r.text();
    if (/temperature|top_p|unsupported/i.test(txt)) {
      const b2 = { ...body }; delete b2.temperature;
      r = await doFetch(b2);
    } else throw new Error(friendlyApiError('openai', 400, txt));
  }
  if (!r.ok) throw new Error(friendlyApiError('openai', r.status, await r.text()));
  const j = await r.json();
  const msg = j.choices && j.choices[0] && j.choices[0].message;
  // 구조화된 거부(message.refusal)는 본문 텍스트가 아니므로 오류로 처리한다.
  if (msg && msg.refusal) { const e = new Error(String(msg.refusal)); e.code = 'AI_REFUSAL'; throw e; }
  return (msg && msg.content) || '';
}

async function sendAnthropic(key, body) {
  const doFetch = (b) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(b)
  });
  let r = await doFetch(body);
  if (r.status === 400 && ('temperature' in body || 'top_p' in body)) {
    const txt = await r.text();
    if (/temperature|top_p|top_k/i.test(txt)) {
      const b2 = { ...body }; delete b2.temperature; delete b2.top_p;
      r = await doFetch(b2);
    } else throw new Error(friendlyApiError('anthropic', 400, txt));
  }
  if (!r.ok) throw new Error(friendlyApiError('anthropic', r.status, await r.text()));
  const j = await r.json();
  // stop_reason === 'refusal'은 안전상 생성 거부 — 본문으로 취급하지 않고 오류로 올린다.
  if (j.stop_reason === 'refusal') {
    const e = new Error((j.stop_details && j.stop_details.reason) || 'Anthropic이 요청 처리를 거부했습니다.');
    e.code = 'AI_REFUSAL'; throw e;
  }
  return (j.content || []).map((b) => b.text || '').join('');
}

async function callOpenAI(key, system, user) {
  return sendOpenAI(key, {
    model: selectedModel().id, temperature: 0,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  });
}

// 이 모델들은 sampling 파라미터(temperature/top_p/top_k) 지정 시 400을 반환한다.
// 매 요청마다 예측 가능한 400→재시도를 유발하지 않도록 처음부터 temperature를 넣지 않는다.
// (sendAnthropic의 400 폴백은 그 외 모델을 위한 호환 장치로 남겨 둔다.)
const NO_SAMPLING_MODELS = new Set(['claude-sonnet-5', 'claude-opus-4-8']);
function anthropicSampling(modelId) {
  return NO_SAMPLING_MODELS.has(modelId) ? {} : { temperature: 0 };
}

async function callAnthropic(key, system, user) {
  const model = selectedModel().id;
  return sendAnthropic(key, {
    model, max_tokens: 8192, ...anthropicSampling(model), system,
    messages: [{ role: 'user', content: user }]
  });
}

async function runAiCorrect() {
  const text = $('ocrText').value.trim();
  if (!text) { setStatus('교정할 텍스트가 없습니다. 먼저 OCR을 실행하세요.'); return; }
  const provider = $('aiProvider').value;
  const key = $('aiKey').value.trim();
  if (!key) { setStatus('API 키를 입력해 주세요.'); return; }
  chrome.storage.local.set({ aiProvider: provider, aiKey: key });

  const btn = $('runAi');
  btn.disabled = true;
  setBusyOp(true);
  const system = aiSystemPrompt();
  const chunks = chunkText(text);
  const call = provider === 'openai' ? callOpenAI : callAnthropic;
  try {
    const out = [];
    for (let i = 0; i < chunks.length; i++) {
      setStatus(`AI 교정 중… (${i + 1}/${chunks.length})`);
      setProgress(i / chunks.length);
      out.push((await call(key, system, chunks[i])).trim());
    }
    $('ocrText').value = out.join('\n');
    if (textSource === 'local') textSource = 'fixed'; // 로컬+AI 교정 (_fix), 비전이었으면 _AI 유지
    $('saveTxt').disabled = false;
    $('copyTxt').disabled = false;
    cacheOcrResult(capture && capture.id); // fix: AI 교정 결과도 캐시에 반영
    setStatus(`AI 교정 완료 (${chunks.length}개 구간)`);
  } catch (e) {
    console.error(e);
    setStatus('AI 교정 실패: ' + (e && e.message ? e.message : e));
  } finally {
    setProgress(null);
    btn.disabled = false;
    setBusyOp(false);
  }
}

// ---------- AI 비전 OCR (이미지를 AI가 직접 판독) ----------
// 전사(轉寫) 프롬프트: 재작성·보정·추측을 강하게 금지하고, 알려진 인명을 함께 전달
function visionPrompt() {
  // 프롬프트를 영어로 작성한다.
  // (한국어 프롬프트를 쓰면 모델이 애매한 타일을 한국어로 번역해 버리는 누출이 발생)
  let names = '';
  const prof = currentProfile();
  if (prof) {
    const set = new Set(parseRules(prof.rules).map(([, to]) => to));
    currentNames().forEach((n) => set.add(n)); // 인물 사전도 정답 표기로 포함
    if (set.size) names = `\nKnown proper nouns (use these exact forms): ${[...set].join(', ')}`;
  }
  const kor = $('langKor').checked, chi = $('langChi').checked;
  const langDesc = kor && !chi ? 'Korean' : chi && !kor ? 'Simplified Chinese' : 'the language shown in the image';
  return 'You are a verbatim OCR transcription engine. Transcribe ALL text visible in the image exactly as written, character for character. ' +
    `The text is in ${langDesc}. Your output MUST be in that exact language and script — NEVER translate, localize, or paraphrase into any other language. ` +
    'Strictly forbidden: rewriting, fixing awkward wording, guessing beyond what is visible, omitting, summarizing, adding explanations, using code fences. ' +
    'If a line at the very top or bottom edge of the image is cut in half, skip that line. ' +
    'Preserve line breaks and punctuation. Output the transcription only. If there is no readable text, output nothing.' + names;
}

// 비전 user 지시문 (영어 — 언어 누출 방지)
const VISION_USER = 'Transcribe every readable character verbatim. ' +
  'Output only the original language and script visible in the image; do not translate.';

async function callAnthropicVision(key, b64, system) {
  const model = selectedModel().id;
  return sendAnthropic(key, {
    model, max_tokens: 8192, ...anthropicSampling(model), system,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: VISION_USER }
      ]
    }]
  });
}

async function callOpenAIVision(key, b64, system) {
  return sendOpenAI(key, {
    model: selectedModel().id, temperature: 0,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64, detail: 'high' } },
          { type: 'text', text: VISION_USER }
        ]
      }
    ]
  });
}

// 비전 타일 하나를 JPEG base64로 (확대 적용)
function visionTileB64(img, cut, scale) {
  const tile = document.createElement('canvas');
  tile.width = Math.round(img.width * scale);
  tile.height = Math.max(1, Math.round((cut[1] - cut[0]) * scale));
  const ctx = tile.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, tile.width, tile.height);
  ctx.drawImage(img, 0, cut[0], img.width, cut[1] - cut[0], 0, 0, tile.width, tile.height);
  return tile.toDataURL('image/jpeg', 0.9).split(',')[1];
}
function isVisionRefusal(s) {
  return /죄송합니다|도와드릴 수 없|드릴 수 없습니다|I'?m sorry|I can(?:'t|not)|cannot assist|unable to|无法(?:帮助|协助|识别)|抱歉[，,]/i.test(s);
}
// 구간에 의미 있는 글자가 있는지 '보수적으로' 판정한다.
// 과도한 축소(80×40=3,200px)는 작거나 희소한 글자를 지워 빈 칸으로 오판하므로,
// 해상도를 충분히 유지하고 비배경 비율·명암 표준편차·에지 밀도를 함께 본다.
// 세 지표가 모두 매우 낮을 때만 '확실히 비어 있음'으로 보고 false를 돌려준다.
// (그 외 '불확실'은 내용 있음으로 간주 → 조용히 버리지 않고 복구 실패 마커를 남긴다.)
function tileHasContent(img, cut) {
  const srcH = Math.max(1, cut[1] - cut[0]);
  const W = Math.max(1, Math.min(img.width, 400));
  const H = Math.max(1, Math.min(Math.round(srcH * (W / Math.max(1, img.width))), 1400));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, 0, cut[0], img.width, srcH, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const n = W * H;
  const gray = new Uint8Array(n);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const g = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000 | 0;
    gray[i] = g; hist[g]++; sum += g;
  }
  let bg = 0, mx = 0;
  for (let t = 0; t < 256; t++) if (hist[t] > mx) { mx = hist[t]; bg = t; }
  const mean = sum / n;
  let nonBg = 0, varSum = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(gray[i] - bg) > 24) nonBg++;         // 흐린 회색 글자도 감지하도록 민감하게
    const dv = gray[i] - mean; varSum += dv * dv;
  }
  const nonBgRatio = nonBg / n;
  const stdDev = Math.sqrt(varSum / n);
  let edges = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 1; x < W; x++) if (Math.abs(gray[row + x] - gray[row + x - 1]) > 16) edges++;
  }
  const edgeDensity = edges / n;
  // '조용히 버려도 되는 빈 구간'은 거의 완전히 균일할 때로만 한정한다(무손실 우선).
  // 희소·흐린 글자 한 조각이라도 있으면 content로 보고 복구 실패 마커·재실행 대상이 되게 한다.
  const definitelyBlank = nonBgRatio < 0.00005 && stdDev < 0.6 && edgeDensity < 0.0001;
  return !definitelyBlank;
}
function isVisionKoreanLeak(s) {
  if (!($('langChi').checked && !$('langKor').checked)) return false;
  const hangul = (s.match(/[가-힣]/g) || []).length;
  const han = (s.match(/[一-鿿]/g) || []).length;
  return hangul > 20 && hangul > han;
}

// tileResults를 이어붙여 후처리·표시·캐시 저장.
// 마커(【OCR 복구 실패…】)는 filter(Boolean)에서 살아남아 내용 유실을 드러낸다.
function finalizeVisionOutput(tileCount) {
  // 서로 다른 저장 타일의 경계는 이미지가 겹치므로 병합해 중복 문장을 제거한다.
  // 그러나 같은 타일 안의 인접 구간은 겹치지 않으므로 병합하면 정당한 반복 줄이 사라진다.
  // → 같은 타일 안은 줄바꿈으로만 잇고, 타일이 바뀔 때만 병합한다.
  const results = lastVision.tileResults || [];
  const units = lastVision.units || [];
  let joined = '', prevUnit = null;
  for (let i = 0; i < results.length; i++) {
    const p = results[i];
    if (!p || !p.length) continue;
    const u = units[i] || null;
    if (!joined) {
      joined = p;
    } else if (prevUnit && u && u.tileIndex !== prevUnit.tileIndex) {
      joined = mergeTextOverlap(joined, p); // 타일 경계 — 겹침 제거
    } else {
      joined += '\n' + p;                   // 같은 타일 내부 — 병합 금지
    }
    prevUnit = u || prevUnit;
  }
  setRawText(joined);
  const text = postprocessText(joined.replace(/^```.*$/gm, ''), $('optAnnot').checked);
  persistRules();
  $('ocrText').value = text;
  ocrDone = true;
  textSource = 'vision';
  const has = text.trim().length > 0;
  $('saveTxt').disabled = !has;
  $('copyTxt').disabled = !has;
  // 실패 유형을 구분해 정확히 보고 (fix 4)
  const s = lastVision.stats || {};
  const parts = [`AI 성공 ${s.ai || 0}`];
  if (s.local) parts.push(`로컬 대체 ${s.local}`);
  if (s.recoverFail) parts.push(`⚠️ 복구 실패 ${s.recoverFail}`);
  setStatus(has
    ? `AI 비전 OCR 완료 — ${text.length}자 / ${tileCount}개 구간 (${parts.join(', ')})` +
      (s.recoverFail ? ' — 본문에 【복구 실패】 표시가 있으니 「실패 타일 재실행」을 눌러 주세요.' : '')
    : 'AI 비전 OCR 완료 — 인식된 텍스트가 없습니다.');
  cacheOcrResult(capture && capture.id);
  if (has) autoCollectNames(text);
}

// 비전 재실행 상태를 캡처별로 저장/복원 (fix 6: 새로고침·탭 전환 후에도 유지)
async function saveVisionState() {
  if (!lastVision || !lastVision.capId) return;
  await chrome.storage.local.set({ ['visionState_' + lastVision.capId]: lastVision });
}
// 구간별 상태 배열에서 통계를 계산한다 (로컬 대체/복구 실패를 정확히 구분).
function visionStatsFromState(state, total) {
  const c = { ai: 0, local: 0, recoverFail: 0, total: total || (state ? state.length : 0) };
  for (const s of (state || [])) {
    if (s === 'ai') c.ai++;
    else if (s === 'local') c.local++;
    else if (s === 'unrecovered') c.recoverFail++;
  }
  return c;
}
async function restoreVisionState(capId) {
  lastVision = null;
  if (!capId) { updateRetryTilesButton(); return; }
  const key = 'visionState_' + capId;
  const o = await chrome.storage.local.get(key);
  if (capId !== (capture && capture.id)) return; // 그 사이 다른 캡처로 전환됨 — 늦은 상태 적용 방지
  if (o[key] && Array.isArray(o[key].tileResults)) lastVision = o[key];
  updateRetryTilesButton();
}

function updateRetryTilesButton() {
  const b = $('retryVisionTiles');
  const n = lastVision && lastVision.failedIdx ? lastVision.failedIdx.length : 0;
  const usable = n > 0 && lastVision.capId === (capture && capture.id);
  b.style.display = usable ? '' : 'none';
  if (usable) b.textContent = `⟲ 실패 타일 ${n}개 재실행`;
}

// AI가 실패해 로컬로 대체된 타일만 다시 AI로 인식
async function retryFailedVisionTiles() {
  if (!lastVision || !lastVision.failedIdx || !lastVision.failedIdx.length) return;
  if (lastVision.capId !== (capture && capture.id)) { setStatus('재실행할 캡처가 현재 화면과 다릅니다.'); return; }
  if (!Array.isArray(lastVision.units)) { setStatus('이 캡처의 재실행 정보를 쓸 수 없습니다. AI 비전 OCR을 다시 실행해 주세요.'); return; }
  const key = $('aiKey').value.trim();
  if (!key) { setStatus('API 키를 입력해 주세요.'); return; }
  const btn = $('retryVisionTiles');
  btn.disabled = true;
  setBusyOp(true);
  setProgress(0);
  const call = lastVision.provider === 'openai' ? callOpenAIVision : callAnthropicVision;
  const system = visionPrompt() +
    '\nREMINDER: Output verbatim text in the source language ONLY. Never translate or refuse.';
  try {
    const scale = lastVision.scale;
    const targets = lastVision.failedIdx.slice();
    // 실패 구간을 타일별로 묶어 각 타일을 한 번만 로드한다 (전체 합성 없이 해당 타일만).
    const byTile = new Map();
    for (const idx of targets) {
      const u = lastVision.units[idx];
      if (!u) continue;
      if (!byTile.has(u.tileIndex)) byTile.set(u.tileIndex, []);
      byTile.get(u.tileIndex).push(idx);
    }
    const descByTile = new Map();
    for (const d of capturePartDescriptors(capture, 80)) {
      descByTile.set(d.type === 'tile' ? d.meta.index : -1, d);
    }
    const still = [];
    let ok = 0, done = 0;
    for (const [tileIndex, idxs] of byTile) {
      const desc = descByTile.get(tileIndex);
      if (!desc) { for (const i of idxs) still.push(i); done += idxs.length; continue; }
      const part = await loadCapturePart(desc);
      try {
        const source = document.createElement('canvas');
        source.width = part.img.width; source.height = part.height;
        const sctx = source.getContext('2d');
        sctx.fillStyle = '#fff'; sctx.fillRect(0, 0, source.width, source.height);
        sctx.drawImage(part.img, 0, part.top, part.img.width, part.height, 0, 0, source.width, source.height);
        for (const idx of idxs) {
          const u = lastVision.units[idx];
          done++;
          setStatus(`실패 구간 재실행… (${done}/${targets.length})`);
          setProgress(done / targets.length);
          const b64 = visionTileB64(source, [u.a, u.b], scale);
          let t = '';
          try {
            t = (await call(key, b64, system) || '').trim();
            if (isVisionRefusal(t) || isVisionKoreanLeak(t)) t = '';
          } catch (_) { t = ''; } // 개별 오류 격리 — 나머지 구간은 계속
          if (t) {
            lastVision.tileResults[idx] = t; ok++;
            if (Array.isArray(lastVision.unitState)) lastVision.unitState[idx] = 'ai'; // 재실행 성공
          } else still.push(idx);
        }
        source.width = source.height = 1;
      } finally {
        if (part.url) URL.revokeObjectURL(part.url);
      }
    }
    lastVision.failedIdx = still;
    // 통계는 구간별 상태에서 다시 계산한다(로컬 대체분을 복구 실패로 잘못 집계하지 않도록).
    if (Array.isArray(lastVision.unitState)) {
      lastVision.stats = visionStatsFromState(lastVision.unitState, lastVision.units.length);
    } else {
      const s = lastVision.stats || {};
      s.ai = (s.ai || 0) + ok; s.recoverFail = still.length; s.local = Math.max(0, (s.local || 0) - ok);
      lastVision.stats = s;
    }
    await saveVisionState();
    finalizeVisionOutput(lastVision.units.length);
    updateRetryTilesButton();
    setStatus(still.length
      ? `일부 재실행 완료 — ${ok}개 성공, ${still.length}개는 여전히 실패.`
      : `실패 구간 ${targets.length}개를 모두 AI로 다시 인식했습니다.`);
  } catch (e) {
    setStatus('실패 구간 재실행 오류: ' + (e && e.message ? e.message : e));
  } finally {
    setProgress(null);
    btn.disabled = false;
    setBusyOp(false);
  }
}

async function runAiVisionOcr() {
  const provider = $('aiProvider').value;
  const key = $('aiKey').value.trim();
  if (!key) { setStatus('API 키를 입력해 주세요 (AI 교정 패널).'); return; }
  // 한국어 전용 캡처는 로컬 OCR이 이미 정확하고 비전은 환각을 더할 수 있어 경고
  if ($('langKor') && $('langKor').checked && !($('langChi') && $('langChi').checked)) {
    if (!confirm('한국어처럼 선명한 텍스트는 로컬 OCR + AI 교정(_fix)이 더 정확하고 저렴합니다.\n' +
      'AI 비전 OCR은 인명·문장을 바꾸는 환각이 생길 수 있습니다.\n\n그래도 AI 비전 OCR을 실행할까요?')) return;
  }
  chrome.storage.local.set({ aiProvider: provider, aiKey: key });

  const btn = $('runVision');
  btn.disabled = true;
  setBusyOp(true);
  setStatus('AI 비전 OCR 준비 중…');
  setProgress(0);
  let fbWorker = null; // 버려진 구간 보완용 로컬 OCR 워커 (필요 시 생성)
  const fbInfo = { i: 0, n: 1, prefix: '', base: 0, span: 0 };
  try {
    // 저장된 타일을 하나씩 불러와 처리한다(전체 이미지를 메모리에 합성하지 않음 → 메모리 일정).
    const descriptors = capturePartDescriptors(capture, 80); // 타일 경계 80px 겹침(경계 문장 보호)
    const MAXSIDE = 1500; // API가 긴 변 ~1500px 초과 시 자동 축소 → 그 한도에 맞춰 구간 생성
    const capW = Math.max(1, capture.width || 1000);
    const scale = Math.max(0.5, Math.min(2, MAXSIDE / capW)); // 모든 타일 폭이 같아 배율 일정
    const tileHsrc = Math.max(200, Math.floor(MAXSIDE / scale));
    const call = provider === 'openai' ? callOpenAIVision : callAnthropicVision;
    const system = visionPrompt();

    const units = [];        // { tileIndex, a, b } — 재실행 시 해당 타일만 다시 로드
    const tileResults = [];
    const failedIdx = [];
    const unitState = []; // idx -> 'ai' | 'local' | 'unrecovered' | 'blank' (통계 정확도용)
    // 진행 중에도 부분 결과가 보존되도록 lastVision을 먼저 만든다.
    lastVision = { capId: capture && capture.id, mode: 'stream', scale, provider, units, tileResults, failedIdx, unitState, stats: {} };

    const estTotal = Math.max(1, descriptors.reduce((sum, d) => {
      const h = d.type === 'tile' ? (d.meta.coreHeight + d.overlapContext * 2) : (capture.height || tileHsrc);
      return sum + Math.max(1, Math.ceil(h / tileHsrc));
    }, 0));

    // 현재 source 캔버스의 cut 구간에 대한 로컬 폴백 OCR
    const localOcrCut = async (source, cut) => {
      try {
        if (!fbWorker) {
          const langs = [];
          if ($('langChi').checked) langs.push('chi_sim');
          if ($('langKor').checked) langs.push('kor');
          if ($('langEng').checked) langs.push('eng');
          fbWorker = await createOcrWorker(langs.length ? langs : ['chi_sim'], $('optBlock').checked, fbInfo);
        }
        const canvas = document.createElement('canvas');
        const c2 = canvas.getContext('2d');
        canvas.width = Math.round(source.width * scale);
        canvas.height = Math.max(1, Math.round((cut[1] - cut[0]) * scale));
        c2.fillStyle = '#ffffff'; c2.fillRect(0, 0, canvas.width, canvas.height);
        c2.drawImage(source, 0, cut[0], source.width, cut[1] - cut[0], 0, 0, canvas.width, canvas.height);
        const { data } = await fbWorker.recognize(canvas);
        return (data.text || '').trim();
      } catch (_) { return ''; }
    };

    let processed = 0;
    for (const desc of descriptors) {
      const part = await loadCapturePart(desc);
      try {
        const source = document.createElement('canvas');
        source.width = part.img.width;
        source.height = part.height;
        const sctx = source.getContext('2d');
        sctx.fillStyle = '#fff'; sctx.fillRect(0, 0, source.width, source.height);
        sctx.drawImage(part.img, 0, part.top, part.img.width, part.height, 0, 0, source.width, source.height);

        const cuts = planCuts(source, tileHsrc);
        for (const cut of cuts) {
          const idx = units.length;
          units.push({ tileIndex: desc.type === 'tile' ? desc.meta.index : -1, a: cut[0], b: cut[1] });
          tileResults.push('');
          processed++;
          setStatus(`AI 비전 OCR 중… (${processed}/${estTotal} 구간)`);
          setProgress(Math.min(0.99, (processed - 1) / estTotal));

          const b64 = visionTileB64(source, cut, scale);
          let t = '', hardFail = false; // hardFail = AI 오류/거부/누출 (재실행·마커 대상)
          try {
            t = (await call(key, b64, system) || '').trim();
            if (isVisionRefusal(t)) { t = ''; hardFail = true; }
            else if (t && isVisionKoreanLeak(t)) {
              t = (await call(key, b64, system +
                '\nREMINDER: Output verbatim in the source language ONLY. Never translate.') || '').trim();
              if (isVisionRefusal(t) || isVisionKoreanLeak(t)) { t = ''; hardFail = true; }
            }
          } catch (err) {
            hardFail = true; t = '';
            setStatus(`(${processed}/${estTotal}) AI 오류 — 로컬로 보완 시도: ${(err && err.message || err).toString().slice(0, 60)}`);
          }

          if (t) {
            tileResults[idx] = t; unitState[idx] = 'ai';
          } else {
            const local = await localOcrCut(source, cut);
            if (local) {
              tileResults[idx] = local; failedIdx.push(idx); unitState[idx] = 'local';
            } else if (hardFail || tileHasContent(source, cut)) {
              tileResults[idx] = `【OCR 복구 실패 — 구간 ${idx + 1}. AI 재실행이 필요합니다】`;
              failedIdx.push(idx); unitState[idx] = 'unrecovered';
            } else {
              tileResults[idx] = ''; unitState[idx] = 'blank'; // 확실히 빈 구간만 조용히 비움
            }
          }
          if (processed % 5 === 0) await saveVisionState(); // 중간 체크포인트 — 중단돼도 진행분 보존
        }
        source.width = source.height = 1; // 메모리 회수
      } finally {
        if (part.url) URL.revokeObjectURL(part.url);
      }
    }
    lastVision.stats = visionStatsFromState(unitState, units.length);
    await saveVisionState();
    finalizeVisionOutput(units.length);
    updateRetryTilesButton();
  } catch (e) {
    console.error(e);
    setStatus('AI 비전 OCR 실패: ' + (e && e.message ? e.message : e));
  } finally {
    setProgress(null);
    btn.disabled = false;
    setBusyOp(false);
    if (fbWorker) { try { await fbWorker.terminate(); } catch (_) {} }
  }
}

// jjwxc(晋江文学城) 본문 곳곳에 삽입되는 워터마크 문구를 제거한다.
// OCR 오인식 변형(文→又 등)과 앞뒤에 남는 빈 줄까지 함께 정리한다.
function removeWatermarks(text) {
  return text
    .replace(/@?\s*无限好[文又]\s*[，,、.。]?\s*尽在晋江文学城/g, '')
    .replace(/@\s*无限好[文又]/g, '')
    .replace(/尽在晋江文学城/g, '')
    .replace(/[ \t]+$/gm, '')      // 제거 후 줄 끝에 남은 공백 정리
    .replace(/\n{3,}/g, '\n\n');   // 3줄 이상 연속 빈 줄 → 1줄
}

// 괄호 안이 깨진 한자 주석(기호 뒤범벅)이면 괄호째 제거한다.
// 예: 교교교(@08) → 교교교, 노야(ㅎ※#) → 노야
// 한글/영문 단어가 들어 있는 정상 괄호는 건드리지 않는다.
function cleanBrokenAnnotations(text) {
  return text.replace(/[(（][^()（）]{0,20}[)）]/g, (m) => {
    const inner = m.slice(1, -1);
    const hangulCnt = (inner.match(/[가-힣]/g) || []).length;
    // 한글이 4자 이상이면 의미 있는 설명(역주 등)으로 보고 보존
    if (hangulCnt >= 4) return m;
    if (/[※&#@$%*\\^~|<>=+]/.test(inner)) return '';   // 기호가 섞임 → 깨진 주석
    if (/^[\d\s!?.,:;'"‘’“”·\-]*$/.test(inner)) return ''; // 숫자/구두점뿐
    if (/^[ㄱ-ㅎㅏ-ㅣ\s.,:;\-]*$/.test(inner) && /[ㄱ-ㅎㅏ-ㅣ]/.test(inner)) return ''; // 자모 조각뿐 (예: ㅅㅎ)
    if (!/\s/.test(inner) && /\d/.test(inner) && hangulCnt <= 2 && hangulCnt > 0) return ''; // 한두 글자+숫자 조각 (예: 추5:)
    return m;
  });
}

// Tesseract가 한자 사이에 잘못 끼워 넣는 공백을 제거한다.
// 한자(중국어)와 CJK 문장부호에만 적용 — 한국어는 띄어쓰기가 의미를 가지므로
// 한글(가-힯)은 절대 포함하지 않는다.
function cleanCjkSpaces(text) {
  const han = '[\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3000-\\u303F\\uFF01-\\uFF60]';
  const re = new RegExp(`(${han}) +(?=${han})`, 'g');
  let prev;
  do { prev = text; text = text.replace(re, '$1'); } while (text !== prev);
  return text;
}

// ---------- TXT 저장 / 복사 ----------
function saveTxt() {
  const text = $('ocrText').value;
  if (!text.trim()) return;
  // 텍스트 출처별 접미사(AI 비전 OCR=_AI / 로컬+AI 교정=_fix / 로컬 OCR=없음)는
  // fileNameConfig의 'source' 토큰으로 처리된다 (defaultBaseFor가 현재 textSource를 반영).
  const filename = askFilename('txt', defaultBaseFor(capture));
  if (filename === null) return; // 사용자가 취소
  // 메모장 호환을 위해 UTF-8 BOM을 붙인다.
  const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
  contentDownload(blob, filename);
}

async function copyTxt() {
  const text = $('ocrText').value;
  if (!text.trim()) return;
  await navigator.clipboard.writeText(text);
  setStatus('클립보드에 복사했습니다.');
}
