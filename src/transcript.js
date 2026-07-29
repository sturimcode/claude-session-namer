const fs = require('node:fs');

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function readEntries(file) {
  const out = [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (isObject(v)) out.push(v);
    } catch { /* skip */ }
  }
  return out;
}

// Last custom-title wins; an ai-title (the app's own auto-title) is only used when no custom-title exists
function titleInfo(entries) {
  let custom = null;
  let ai = null;
  for (const e of entries) {
    if (!isObject(e)) continue;
    if (e.type === 'custom-title' && typeof e.customTitle === 'string') custom = e.customTitle;
    else if (e.type === 'ai-title' && typeof e.aiTitle === 'string') ai = e.aiTitle;
  }
  if (custom !== null) return { title: custom, source: 'custom' };
  if (ai !== null) return { title: ai, source: 'ai' };
  return { title: null, source: null };
}

const currentTitle = (entries) => titleInfo(entries).title;

function userText(entry) {
  if (!isObject(entry)) return null;
  if (entry.type !== 'user' || entry.isSidechain || entry.isMeta) return null;
  const c = entry.message && entry.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    const texts = c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text);
    if (texts.length) text = texts.join('\n');
  }
  if (text === null || text.trim() === '') return null;
  return text;
}

function assistantText(entry) {
  if (!isObject(entry)) return null;
  if (entry.type !== 'assistant' || entry.isSidechain || entry.isMeta) return null;
  const c = entry.message && entry.message.content;
  if (!Array.isArray(c)) return null;
  const texts = c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text);
  return texts.length ? texts.join('\n') : null;
}

const countUserTurns = (entries) => entries.filter((e) => userText(e) !== null).length;

function firstUserText(entries) {
  for (const e of entries) { const s = userText(e); if (s !== null) return s; }
  return null;
}

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.…]+$/, '').trim();

function isVagueTitle(title, firstText) {
  if (!title) return true;
  const t = norm(title);
  if (!t || t === 'new session') return true;
  if (!firstText) return false;
  return norm(firstText).startsWith(t);
}

function buildExcerpt(entries, maxChars = 4000) {
  const turns = [];
  for (const e of entries) {
    const u = userText(e); if (u !== null) { turns.push(['User', u]); continue; }
    const a = assistantText(e); if (a !== null) turns.push(['Assistant', a]);
  }
  const clip = ([role, text]) => `${role}: ${text.length > 300 ? text.slice(0, 300) + '…' : text}`;
  // First 4 turns + last 8 turns, joined until cap. The tail is budgeted first so the
  // most recent turns always survive, however small the cap.
  const head = turns.slice(0, 4).map(clip);
  const tailTurns = turns.slice(4).slice(-8);
  const tail = tailTurns.length ? ['…', ...tailTurns.map(clip)] : [];
  const size = (parts) => parts.reduce((n, p) => n + p.length + 1, 0);
  // Drop the oldest tail turns (keeping the leading ellipsis) until the tail fits on its own
  while (tail.length > 1 && size(tail) > maxChars) tail.splice(1, 1);
  const headBudget = maxChars - size(tail);
  let out = '';
  for (const p of head) {
    if (out.length + p.length + 1 > headBudget) break;
    out += (out ? '\n' : '') + p;
  }
  for (const p of tail) {
    if (out.length + p.length + 1 > maxChars) break;
    out += (out ? '\n' : '') + p;
  }
  return out;
}

module.exports = { readEntries, titleInfo, currentTitle, userText, assistantText, countUserTurns, firstUserText, isVagueTitle, buildExcerpt };
