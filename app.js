// ─────────────────────────────────────────────
//  GLOBALS
// ─────────────────────────────────────────────
const synth = window.speechSynthesis;
let jakub = null;
let chunks = [], curChunk = 0, isPaused = false, isPlaying = false;
let chapters = [];
let bookmarks = [];
let currentFile = null;
let wakeLock = null;

const LS_KEY = 'daredevil_v3';
const rateR  = document.getElementById('rateRange');
const pitchR = document.getElementById('pitchRange');

// ─────────────────────────────────────────────
//  WAKE LOCK – čti i při zamčeném displeji
// ─────────────────────────────────────────────
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    document.getElementById('wakeBadge').style.display = 'inline-block';
    wakeLock.addEventListener('release', () => {
      document.getElementById('wakeBadge').style.display = 'none';
    });
  } catch (e) {
    console.warn('Wake Lock nedostupný:', e.message);
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    await wakeLock.release();
    wakeLock = null;
  }
  document.getElementById('wakeBadge').style.display = 'none';
}

// Znovu získej wake lock po návratu do tabu
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && isPlaying && !wakeLock) {
    await requestWakeLock();
  }
});

// ─────────────────────────────────────────────
//  VOICE – Jakub nebo nejlepší česky
// ─────────────────────────────────────────────
function findJakub() {
  const all = synth.getVoices();
  if (!all.length) return;
  jakub = all.find(v => /jakub/i.test(v.name))
    || all.find(v => v.lang.toLowerCase().startsWith('cs'))
    || all[0];
}
findJakub();
if (synth.onvoiceschanged !== undefined) synth.onvoiceschanged = findJakub;

// ─────────────────────────────────────────────
//  RANGES
// ─────────────────────────────────────────────
rateR.addEventListener('input', () => {
  document.getElementById('rateVal').textContent = parseFloat(rateR.value).toFixed(2) + '×';
  applyParamChange();
});
pitchR.addEventListener('input', () => {
  document.getElementById('pitchVal').textContent = parseFloat(pitchR.value).toFixed(2);
  applyParamChange();
});

function applyParamChange() {
  if (!isPlaying || isPaused) return;
  synth.cancel();
  setTimeout(() => speakChunk(curChunk), 80);
}

// ─────────────────────────────────────────────
//  FILE HANDLING
// ─────────────────────────────────────────────
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

// Drag & drop (desktop)
dropzone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', e => { e.stopPropagation(); dropzone.classList.remove('over'); });
dropzone.addEventListener('drop', e => {
  e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

async function handleFile(file) {
  currentFile = file.name;
  const loading = document.getElementById('loadingMsg');
  loading.style.display = 'block';
  setStatus('Načítám…');
  synth.cancel(); isPlaying = false; isPaused = false;
  try {
    let text = '';
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'pdf')              text = await parsePDF(file);
    else if (ext === 'docx' || ext === 'doc') text = await parseDOCX(file);
    else if (ext === 'epub')        text = await parseEPUB(file);
    else if (ext === 'mobi')        text = await parseMOBI(file);
    else                            text = await file.text();

    text = text.trim();
    if (!text) throw new Error('Soubor neobsahuje čitelný text');

    loading.style.display = 'none';
    dropzone.querySelector('strong').textContent = '✅ ' + file.name;
    initText(text);
  } catch (e) {
    loading.style.display = 'none';
    setStatus('Chyba: ' + e.message, true);
  }
}

// Textarea live input
document.getElementById('pasteArea').addEventListener('input', () => {
  const txt = document.getElementById('pasteArea').value.trim();
  if (txt.length > 10) {
    currentFile = '__paste__';
    initText(txt);
  }
});

function initText(text) {
  document.getElementById('charInfo').textContent = text.length.toLocaleString() + ' znaků';
  chunks   = chunkText(text);
  chapters = detectChapters(text, chunks);
  renderChapters();
  buildReaderView();
  curChunk = 0;
  document.getElementById('chunkInfo').textContent = `0 / ${chunks.length} úseků`;
  ['btnPlay','btnPause','btnStop'].forEach(id => document.getElementById(id).disabled = false);

  const saved = loadProgress();
  if (saved && saved.file === currentFile && saved.chunk > 0) {
    curChunk = Math.min(saved.chunk, chunks.length - 1);
    if (saved.rate)  { rateR.value  = saved.rate;  document.getElementById('rateVal').textContent  = parseFloat(saved.rate).toFixed(2)+'×'; }
    if (saved.pitch) { pitchR.value = saved.pitch; document.getElementById('pitchVal').textContent = parseFloat(saved.pitch).toFixed(2); }
    highlightChunk(curChunk);
    setStatus(`📌 Pokračuj od úseku ${curChunk + 1} — stiskni Přehrát`, false, false, true);
  } else {
    setStatus(`${chunks.length} úseků · ${chapters.length} kapitol`);
  }

  loadBookmarks();
  renderBookmarks();
}

// ─────────────────────────────────────────────
//  PARSERS
// ─────────────────────────────────────────────
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Nelze načíst: ' + src));
    document.head.appendChild(s);
  });
}

async function parsePDF(file) {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
  const lib = window['pdfjs-dist/build/pdf'];
  lib.GlobalWorkerOptions.workerSrc = '';
  const buf = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: buf, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
  let out = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map(s => s.str).join(' ') + '\n\n';
  }
  return out;
}

async function parseDOCX(file) {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js');
  const buf    = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  return result.value;
}

async function parseEPUB(file) {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  let textParts = [];
  let opfPath   = null;

  const containerFile = zip.file('META-INF/container.xml');
  if (containerFile) {
    const cText = await containerFile.async('string');
    const m = cText.match(/full-path="([^"]+\.opf)"/i);
    if (m) opfPath = m[1];
  }
  if (opfPath) {
    const opfText = await zip.file(opfPath).async('string');
    const base    = opfPath.replace(/[^/]+$/, '');
    const idrefs  = [...opfText.matchAll(/<itemref[^>]+idref="([^"]+)"/gi)].map(m => m[1]);
    const items   = {};
    [...opfText.matchAll(/<item[^>]+id="([^"]+)"[^>]+href="([^"]+)"/gi)].forEach(m => { items[m[1]] = m[2]; });
    for (const ref of idrefs) {
      const href = items[ref];
      if (!href) continue;
      const f = zip.file(base + href) || zip.file(href);
      if (!f) continue;
      textParts.push(stripHtml(await f.async('string')));
    }
  }
  if (!textParts.length) {
    const promises = [];
    zip.forEach((path, entry) => {
      if (/\.(html|xhtml|htm)$/i.test(path)) promises.push(entry.async('string').then(stripHtml));
    });
    textParts = await Promise.all(promises);
  }
  return textParts.join('\n\n');
}

function stripHtml(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.innerText || d.textContent || '';
}

async function parseMOBI(file) {
  const buf   = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const dec   = new TextDecoder('utf-8', { fatal: false });
  let text    = '';
  for (let i = 0; i < bytes.length; i += 4096) text += dec.decode(bytes.slice(i, i + 4096));
  text = text.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, ' ').replace(/\s{3,}/g, '\n\n');
  const paragraphs = text.split('\n\n').filter(p => p.trim().length > 30 && /[a-záčďéěíňóřšůúýž]/i.test(p));
  return paragraphs.join('\n\n') || text.slice(2048);
}

// ─────────────────────────────────────────────
//  CHUNKING
// ─────────────────────────────────────────────
function chunkText(text) {
  const sentences = text.match(/[^.!?…\n]+[.!?…\n]+|[^.!?…\n]+$/g) || [text];
  const result = []; let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > 220 && buf.length > 0) { result.push(buf.trim()); buf = s; }
    else buf += s;
  }
  if (buf.trim()) result.push(buf.trim());
  return result.filter(c => c.length > 0);
}

// ─────────────────────────────────────────────
//  CHAPTERS
// ─────────────────────────────────────────────
function detectChapters(text, chunks) {
  const chapPat = /^(kapitola\s+[\divxlc]+|chapter\s+[\divxlc]+|\d+\.\s+[A-ZÁČĎÉĚÍŇÓŘŠŮÚÝŽ].{2,}|[IVXLC]{2,6}\.\s+.{3,}|##?\s+.+)/im;
  const chaps   = [];
  let pos = 0;
  const cPos  = chunks.map(c => { const p = pos; pos += c.length + 1; return p; });
  const lines = text.split('\n');
  let charPos = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 2 && trimmed.length < 120 && chapPat.test(trimmed)) {
      let ci = cPos.findIndex(p => p > charPos) - 1;
      ci = Math.max(0, ci);
      if (!chaps.length || chaps[chaps.length - 1].chunkIndex !== ci)
        chaps.push({ name: trimmed, chunkIndex: ci });
    }
    charPos += line.length + 1;
  }
  return chaps;
}

function renderChapters() {
  const wrap = document.getElementById('chaptersWrap');
  const list = document.getElementById('chapterList');
  if (!chapters.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  list.innerHTML = '';
  chapters.forEach((ch, i) => {
    const div = document.createElement('div');
    div.className = 'chap-item';
    div.innerHTML = `<span class="chap-num">${i + 1}</span><span class="chap-name">${escHtml(ch.name)}</span>`;
    div.addEventListener('click', () => jumpToChunk(ch.chunkIndex));
    list.appendChild(div);
  });
}

function updateActiveChapter(ci) {
  const items = document.querySelectorAll('.chap-item');
  let active  = -1;
  chapters.forEach((ch, i) => { if (ch.chunkIndex <= ci) active = i; });
  items.forEach((el, i) => el.classList.toggle('active-chap', i === active));
}

// ─────────────────────────────────────────────
//  READER VIEW
// ─────────────────────────────────────────────
function buildReaderView() {
  const rv = document.getElementById('readerView');
  rv.style.display = 'block';
  rv.innerHTML = chunks.map((c, i) => `<span class="chunk" id="ck${i}">${escHtml(c)} </span>`).join('');
}

function escHtml(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightChunk(i) {
  document.querySelectorAll('.chunk').forEach(el => el.classList.remove('active'));
  const el = document.getElementById('ck' + i);
  if (el) { el.classList.add('active'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  const pct = chunks.length > 1 ? i / (chunks.length - 1) * 100 : 100;
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('chunkInfo').textContent   = `${i + 1} / ${chunks.length} úseků`;
  updateActiveChapter(i);
}

// ─────────────────────────────────────────────
//  PLAYBACK
// ─────────────────────────────────────────────
function makeUtt(text) {
  const u = new SpeechSynthesisUtterance(text);
  if (jakub) u.voice = jakub;
  u.rate  = parseFloat(rateR.value);
  u.pitch = parseFloat(pitchR.value);
  u.lang  = jakub ? jakub.lang : 'cs-CZ';
  return u;
}

function speakChunk(i) {
  if (!isPlaying || i >= chunks.length) {
    isPlaying = false;
    if (i >= chunks.length) {
      document.getElementById('progressBar').style.width = '100%';
      setStatus('✅ Hotovo!', false, false, true);
      saveProgress();
      releaseWakeLock();
    }
    return;
  }
  curChunk = i;
  highlightChunk(i);
  setStatus(`▶ Úsek ${i + 1} / ${chunks.length}`, false, true);
  saveProgress();

  const utt    = makeUtt(chunks[i]);
  utt.onend    = () => { if (!isPaused && isPlaying) speakChunk(i + 1); };
  utt.onerror  = e  => { if (e.error !== 'interrupted') setStatus('Chyba: ' + e.error, true); };
  synth.speak(utt);
}

function jumpToChunk(idx) {
  synth.cancel();
  curChunk = idx;
  if (isPlaying) setTimeout(() => speakChunk(idx), 80);
  else { highlightChunk(idx); setStatus(`📌 Pozice: ${idx + 1}`); }
}

// ─────────────────────────────────────────────
//  BUTTONS
// ─────────────────────────────────────────────
document.getElementById('btnPlay').addEventListener('click', async () => {
  if (!chunks.length) return;
  synth.cancel(); isPaused = false; isPlaying = true;
  document.getElementById('btnPause').textContent = '⏸';
  await requestWakeLock();
  setTimeout(() => speakChunk(curChunk), 80);
});

document.getElementById('btnPause').addEventListener('click', () => {
  if (!isPlaying) return;
  if (!isPaused) {
    synth.pause(); isPaused = true;
    document.getElementById('btnPause').textContent = '▶';
    setStatus('⏸ Pozastaveno');
    releaseWakeLock();
  } else {
    synth.resume(); isPaused = false;
    document.getElementById('btnPause').textContent = '⏸';
    setStatus('▶ Pokračuji…', false, true);
    requestWakeLock();
  }
});

document.getElementById('btnStop').addEventListener('click', () => {
  synth.cancel(); isPaused = false; isPlaying = false;
  document.getElementById('btnPause').textContent = '⏸';
  setStatus('⏹ Zastaveno');
  saveProgress();
  releaseWakeLock();
});

document.getElementById('btnBookmark').addEventListener('click', () => {
  if (!chunks.length) return;
  const ci = curChunk;
  if (bookmarks.find(b => b.chunkIndex === ci)) { setStatus('Záložka již existuje'); return; }
  bookmarks.push({ chunkIndex: ci, label: `Úsek ${ci + 1}` });
  saveBookmarks(); renderBookmarks();
  setStatus(`🔖 Záložka uložena: Úsek ${ci + 1}`, false, false, true);
});

// ─────────────────────────────────────────────
//  BOOKMARKS
// ─────────────────────────────────────────────
function renderBookmarks() {
  const wrap = document.getElementById('bmWrap');
  const list = document.getElementById('bmList');
  if (!bookmarks.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  list.innerHTML = '';
  bookmarks.forEach((bm, i) => {
    const tag = document.createElement('div');
    tag.className = 'bm-tag';
    tag.innerHTML = `<span>🔖 ${escHtml(bm.label)}</span><span class="bm-del" title="Smazat">×</span>`;
    tag.addEventListener('click', e => {
      if (e.target.classList.contains('bm-del')) {
        bookmarks.splice(i, 1); saveBookmarks(); renderBookmarks();
      } else jumpToChunk(bm.chunkIndex);
    });
    list.appendChild(tag);
  });
}

function saveBookmarks() {
  try { localStorage.setItem('daredevil_bm_' + currentFile, JSON.stringify(bookmarks)); } catch (e) {}
}
function loadBookmarks() {
  try { const d = localStorage.getItem('daredevil_bm_' + currentFile); bookmarks = d ? JSON.parse(d) : []; } catch (e) { bookmarks = []; }
}

// ─────────────────────────────────────────────
//  PROGRESS
// ─────────────────────────────────────────────
function saveProgress() {
  if (!currentFile) return;
  try { localStorage.setItem(LS_KEY, JSON.stringify({ file: currentFile, chunk: curChunk, rate: rateR.value, pitch: pitchR.value })); } catch (e) {}
}
function loadProgress() {
  try { const d = localStorage.getItem(LS_KEY); return d ? JSON.parse(d) : null; } catch (e) { return null; }
}

// ─────────────────────────────────────────────
//  STATUS
// ─────────────────────────────────────────────
function setStatus(msg, err = false, playing = false, ok = false) {
  const s = document.getElementById('status');
  s.textContent = msg;
  s.className   = 'status' + (err ? ' error' : playing ? ' playing' : ok ? ' ok' : '');
}
