const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

// Read-only access to the Claude desktop app's session store.
//
// The transcript cannot tell a hand rename from the app's own auto-title - both arrive as
// `custom-title` records. The app's store can: it keeps one JSON file per session carrying a
// `titleSource` of 'user' (someone typed the name in the app UI) or 'auto' (the app named it).
// That marker is the only reliable signal on disk that a human named a session.
//
// Every read here is best-effort. A missing store is the normal state on Linux, on Windows, and on
// any machine that has only ever run the CLI, so it reads as "no signal" rather than as an error.

const isSessionFile = (name) => name.startsWith('local_') && name.endsWith('.json');

// Returns entry names of dir, or an empty list for anything unreadable - a store that isn't there,
// a permissions error, a file where a directory was expected.
function names(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// Reads one session file. Anything that isn't a JSON object - a half-written file, an array, a
// file the app has since changed the shape of - reads as null and is skipped.
function readRecord(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

// Walks the store's two directory levels and yields each session record it can parse. Lazy, so a
// caller looking for one session stops the walk as soon as it finds it.
function* records() {
  const root = paths.appStoreDir();
  for (const outer of names(root)) {
    const outerDir = path.join(root, outer);
    for (const inner of names(outerDir)) {
      const innerDir = path.join(outerDir, inner);
      for (const name of names(innerDir)) {
        if (!isSessionFile(name)) continue;
        const record = readRecord(path.join(innerDir, name));
        if (record) yield record;
      }
    }
  }
}

// A matching record with no titleSource field at all reads as 'auto': older app builds wrote it
// that way, and a rename has always been recorded explicitly, so absence means the app named it.
const sourceOf = (record) => (record.titleSource === 'user' ? 'user' : 'auto');

// 'user' when the session was renamed in the app UI, 'auto' when the app named it itself, null when
// the store has no file for this session or can't be read.
//
// The store is keyed by the app's own session id, not ours, so the tree gets walked looking for a
// matching cliSessionId. It stops at the first match; a full miss is one pass over a few hundred
// small files, which is why anything asking about many sessions uses userRenamedIds instead.
function titleSourceFor(cliSessionId) {
  if (!cliSessionId) return null;
  for (const record of records()) {
    if (record.cliSessionId === cliSessionId) return sourceOf(record);
  }
  return null;
}

// Every session the user renamed in the app, in one pass. `list` would otherwise walk the whole
// store once per row it prints - seconds of file reads for a listing that should be instant.
// An absent store yields an empty set, so callers need no special case for it.
function userRenamedIds() {
  const ids = new Set();
  for (const record of records()) {
    if (typeof record.cliSessionId === 'string' && record.titleSource === 'user') ids.add(record.cliSessionId);
  }
  return ids;
}

// The whole store in one pass, for callers that need to compare it against our own view of every
// session rather than ask about one. `daemonSessionId` is the app's own id for the session (the
// `sessionId` field of the file, eg 'local_...'), which is what the app's session-rename API is
// keyed by; `cliSessionId` is the transcript id everything else here works in. A record with no
// string cliSessionId can't be matched to a transcript, so it isn't an entry. Best-effort like
// every other read: an absent or unreadable store yields an empty list.
function entries() {
  const out = [];
  for (const record of records()) {
    if (typeof record.cliSessionId !== 'string') continue;
    out.push({
      daemonSessionId: record.sessionId,
      cliSessionId: record.cliSessionId,
      title: typeof record.title === 'string' ? record.title : null,
      titleSource: sourceOf(record),
    });
  }
  return out;
}

module.exports = { titleSourceFor, userRenamedIds, entries };
