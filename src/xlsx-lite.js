// 경량 XLSX/CSV 용어집 파서·생성기 (외부 라이브러리 없음).
// XLSX 읽기: ZIP 파싱 + DecompressionStream('deflate-raw')로 압축 해제.
// XLSX 쓰기: 무압축(stored) ZIP으로 유효한 .xlsx 생성 (deflate 인코더 불필요).
(function (root) {
  'use strict';

  // ---------- CRC32 ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // ---------- ZIP 읽기 ----------
  function readU16(b, o) { return b[o] | (b[o + 1] << 8); }
  function readU32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저는 압축 해제를 지원하지 않습니다.');
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ZIP 중앙 디렉터리를 읽어 { name: Uint8Array } 맵을 만든다.
  async function unzip(buf) {
    const b = new Uint8Array(buf);
    // EOCD 찾기 (뒤에서부터)
    let eocd = -1;
    for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 65536; i--) {
      if (readU32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('올바른 XLSX(zip) 파일이 아닙니다.');
    const cdCount = readU16(b, eocd + 10);
    let p = readU32(b, eocd + 16);
    const files = {};
    for (let n = 0; n < cdCount; n++) {
      if (readU32(b, p) !== 0x02014b50) break;
      const method = readU16(b, p + 10);
      const compSize = readU32(b, p + 20);
      const nameLen = readU16(b, p + 28);
      const extraLen = readU16(b, p + 30);
      const commentLen = readU16(b, p + 32);
      const localOff = readU32(b, p + 42);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
      // 로컬 헤더에서 실제 데이터 위치 계산
      const lNameLen = readU16(b, localOff + 26);
      const lExtraLen = readU16(b, localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = b.subarray(dataStart, dataStart + compSize);
      files[name] = { method, raw };
      p += 46 + nameLen + extraLen + commentLen;
    }
    const out = {};
    for (const name of Object.keys(files)) {
      const f = files[name];
      out[name] = f.method === 0 ? f.raw.slice() : await inflateRaw(f.raw);
    }
    return out;
  }

  // ---------- XLSX 읽기 → 2차원 배열(첫 시트) ----------
  function xmlText(s) {
    return s
      // 숫자 문자 참조: &#27431; (10진), &#x6B27; (16진) — 한자·한글이 이렇게 저장되기도 함
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }
  function colToIndex(ref) {
    const m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return 0;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  // 시트별 rows 배열의 배열을 반환
  async function parseXlsxSheets(buf) {
    const files = await unzip(buf);
    const shared = [];
    const ssName = Object.keys(files).find((n) => /sharedStrings\.xml$/i.test(n));
    if (ssName) {
      const xml = dec.decode(files[ssName]);
      // <si> ... </si> 단위로 텍스트 추출 (<t> 조각 합침)
      const siRe = /<si>([\s\S]*?)<\/si>/g;
      let m;
      while ((m = siRe.exec(xml))) {
        const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => xmlText(x[1]));
        shared.push(parts.join(''));
      }
    }
    // 파일명(sheetN.xml)의 숫자로 정렬한다. 문자열(.sort()) 정렬은 시트가 10개
    // 이상이면 "sheet10"이 "sheet2"보다 앞으로 와 순서가 뒤섞인다.
    const sheetNames = Object.keys(files)
      .filter((n) => /xl\/worksheets\/sheet\d+\.xml$/i.test(n))
      .sort((a, b) => {
        const na = Number((/sheet(\d+)\.xml$/i.exec(a) || [])[1]) || 0;
        const nb = Number((/sheet(\d+)\.xml$/i.exec(b) || [])[1]) || 0;
        return na - nb;
      });
    const parseOne = (xml) => {
      const rows = [];
      const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
      let rm;
      while ((rm = rowRe.exec(xml))) {
        const cells = [];
        const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
        let cm;
        let nextCol = 0; // r= 속성이 없는 셀(위치 기반 저장)의 다음 예상 열
        while ((cm = cellRe.exec(rm[1]))) {
          const attrs = cm[1] || cm[3] || '';
          const body = cm[2] || '';
          const ref = (/r="([^"]+)"/.exec(attrs) || [])[1] || '';
          const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || '';
          let val = '';
          if (type === 's') {
            const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
            val = v != null ? (shared[Number(v)] || '') : '';
          } else if (type === 'inlineStr') {
            val = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => xmlText(x[1])).join('');
          } else {
            const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
            val = v != null ? xmlText(v) : '';
          }
          // r= 속성이 없는 셀(일부 비-Excel 저작 도구가 위치 순서로만 저장)을 항상
          // 0열(A)로 몰아넣으면 이미 채워진 A열 값을 덮어써 버린다. r=이 있으면 그
          // 열을 쓰고, 없으면 지금까지 온 순서대로 다음 열에 채운다.
          const col = ref ? colToIndex(ref) : nextCol;
          cells[col] = val;
          nextCol = col + 1;
        }
        rows.push(cells);
      }
      return rows;
    };
    return sheetNames.map((n) => parseOne(dec.decode(files[n]))); // 시트별 rows 배열의 배열
  }

  // 하위호환: 모든 시트를 합친 단일 rows 배열
  async function parseXlsx(buf) {
    const sheets = await parseXlsxSheets(buf);
    return [].concat(...sheets);
  }

  // ---------- CSV/TSV 읽기 ----------
  function parseDelimited(text, delim) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // ---------- XLSX 쓰기 (무압축 ZIP) ----------
  function xmlEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function colName(i) {
    let s = '';
    i += 1;
    while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  function buildSheetXml(rows) {
    let body = '';
    rows.forEach((cells, r) => {
      let cs = '';
      cells.forEach((val, c) => {
        cs += `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(val)}</t></is></c>`;
      });
      body += `<row r="${r + 1}">${cs}</row>`;
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${body}</sheetData></worksheet>`;
  }

  function zipStored(entries) {
    // entries: [{ name, data(Uint8Array) }]
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const nameBytes = enc.encode(e.name);
      const crc = crc32(e.data);
      const size = e.data.length;
      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);        // version
      dv.setUint16(6, 0, true);         // flags
      dv.setUint16(8, 0, true);         // method: stored
      dv.setUint16(10, 0, true);        // time
      dv.setUint16(12, 0, true);        // date
      dv.setUint32(14, crc, true);
      dv.setUint32(18, size, true);
      dv.setUint32(22, size, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      chunks.push(local, e.data);

      const cen = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);

      offset += local.length + e.data.length;
    }
    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const cdOffset = offset;
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdOffset, true);
    const all = [...chunks, ...central, eocd];
    let total = 0;
    for (const a of all) total += a.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  function makeXlsx(rows) {
    const files = [
      { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>') },
      { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: 'xl/workbook.xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="glossary" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: 'xl/worksheets/sheet1.xml', data: enc.encode(buildSheetXml(rows)) }
    ];
    return zipStored(files);
  }

  root.SCOXlsx = Object.freeze({ parseXlsx, parseXlsxSheets, parseDelimited, makeXlsx });
})(typeof self !== 'undefined' ? self : globalThis);
