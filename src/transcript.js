const fs = require('node:fs');

function readEntries(file) {
  const out = [];
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

function currentTitle(entries) {
  let title = null;
  for (const e of entries) if (e.type === 'custom-title' && typeof e.customTitle === 'string') title = e.customTitle;
  return title;
}

function userText(entry) {
  if (entry.type !== 'user' || entry.isSidechain || entry.isMeta) return null;
  const c = entry.message && entry.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const texts = c.filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text);
    if (texts.length) return texts.join('\n');
  }
  return null;
}

function assistantText(entry) {
  if (entry.type !== 'assistant' || entry.isSidechain) return null;
  const c = entry.message && entry.message.content;
  if (!Array.isArray(c)) return null;
  const texts = c.filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text);
  return texts.length ? texts.join('\n') : null;
}

const countUserTurns = (entries) => entries.filter((e) => userText(e) !== null).length;

function firstUserText(entries) {
  for (const e of entries) { const s = userText(e); if (s !== null) return s; }
  return null;
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').replace(/\.{3}$|…$/g, '').trim();

function isVagueTitle(title, firstText) {
  if (!title || title === 'New session') return true;
  if (!firstText) return false;
  const t = norm(title);
  const f = norm(firstText);
  return t.length > 0 && f.startsWith(t);
}

function buildExcerpt(entries, maxChars = 4000) {
  const turns = [];
  for (const e of entries) {
    const u = userText(e); if (u !== null) { turns.push(['User', u]); continue; }
    const a = assistantText(e); if (a !== null) turns.push(['Assistant', a]);
  }
  const clip = ([role, text]) => `${role}: ${text.length > 300 ? text.slice(0, 300) + '…' : text}`;
  // First 4 turns + last 8 turns, deduped, joined until cap
  const head = turns.slice(0, 4);
  const tail = turns.slice(4).slice(-8);
  const parts = [...head.map(clip), ...(tail.length ? ['…', ...tail.map(clip)] : [])];
  let out = '';
  for (const p of parts) {
    if (out.length + p.length + 1 > maxChars) break;
    out += (out ? '\n' : '') + p;
  }
  return out;
}

module.exports = { readEntries, currentTitle, userText, assistantText, countUserTurns, firstUserText, isVagueTitle, buildExcerpt };
