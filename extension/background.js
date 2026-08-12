// ─── DevCDP background service worker ────────────────────────────────────────
// Owns the tab grouping. One Chrome tab group per DevCDP session, coloured by
// session number, so a developer glancing at the tab strip can see exactly which
// tabs an agent is driving — and which session owns each one (F2).
//
// chrome.tabGroups has no CDP equivalent, which is the whole reason this
// extension exists.

// One colour, matching the in-page border: blue means DevCDP. Sessions used to get
// a colour each, but the in-page indicator reserves green for "your turn" and red
// for an error, and a tab strip disagreeing with the border on what a colour means
// is worse than no colour at all. Sessions are told apart by the group's title.
const GROUP_COLOR = "blue";

// sessionId → groupId. A service worker can be torn down at any time, so this is
// a cache, not the truth; we always re-derive from chrome.tabs when it's empty.
const groups = new Map();

async function findExistingGroup(label) {
  try {
    const found = await chrome.tabGroups.query({ title: label });
    return found.length ? found[0].id : null;
  } catch (_) { return null; }
}

/**
 * Group titles are kept short because Chrome truncates them hard in the tab
 * strip. With one session that means a plain "DevCDP"; concurrent sessions get
 * "DevCDP 2", "DevCDP 3", so ownership is readable at a glance.
 */
function titleFor(session) {
  if (session.groupMode === "single") return "DevCDP";
  return session.sessionNo > 1 ? `DevCDP ${session.sessionNo}` : "DevCDP";
}

async function claim(tabId, session) {
  const { sessionId, sessionNo } = session;
  // In 'single' mode every session shares one group, so key on a constant.
  const key = session.groupMode === "single" ? "__single__" : sessionId;
  const label = titleFor(session);

  let groupId = groups.get(key) ?? await findExistingGroup(label);

  // Validate the cached group still exists — Chrome drops empty groups.
  if (groupId != null) {
    try { await chrome.tabGroups.get(groupId); }
    catch (_) { groupId = null; groups.delete(key); }
  }

  try {
    const opts = groupId != null ? { tabIds: [tabId], groupId } : { tabIds: [tabId] };
    const newGroupId = await chrome.tabs.group(opts);
    groups.set(key, newGroupId);
    await chrome.tabGroups.update(newGroupId, { title: label, color: GROUP_COLOR, collapsed: false });
    return { ok: true, groupId: newGroupId, color: GROUP_COLOR, mode: session.groupMode };
  } catch (e) {
    // Do not let this fail quietly. A previous version called a colorFor() helper that
    // had been deleted along with the per-session palette; the ReferenceError landed
    // here and grouping simply stopped working, reported as a plain {ok:false} that
    // nothing looked at. The reason now travels back to the caller and into the page.
    console.warn("[DevCDP] could not group tab", tabId, e?.message);
    return { ok: false, error: e?.message || "group failed" };
  }
}

async function release(tabId) {
  try { await chrome.tabs.ungroup([tabId]); }
  catch (_) { /* tab already gone, or was never grouped */ }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender?.tab?.id;
  if (tabId == null) { reply?.({ ok: false }); return false; }

  if (msg?.type === "devcdp:claim" && msg.session?.sessionId) {
    claim(tabId, msg.session).then(r => reply?.(r));
    return true;               // keep the channel open for the async reply
  }
  if (msg?.type === "devcdp:release") {
    release(tabId).then(() => reply?.({ ok: true, groupId: null }));
    return true;
  }
  reply?.({ ok: false });
  return false;
});

// Tidy the cache when a group disappears so we don't reuse a dead id.
chrome.tabGroups?.onRemoved?.addListener(group => {
  for (const [sessionId, id] of groups) if (id === group.id) groups.delete(sessionId);
});
