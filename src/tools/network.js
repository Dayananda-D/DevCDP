// ─── Network tools ───────────────────────────────────────────────────────────
// NET-1: v4 advertised "every request, status, timing & response body" but
// network_get_requests never returned a body, and its max_body_bytes argument was
// dead — nothing read it. Bodies are opt-in here and the cap actually applies.
// TOOL-5: the wait tool advertised "max 3 s" with default 3000 while the code
// defaulted to 15000. Defaults now live only in the schema.

import { defineTool } from "../core/tools.js";
import { CODES, fail } from "../core/errors.js";

/** Clip to a UTF-8 byte budget without splitting a character. */
function byteClip(str, maxBytes) {
  if (!str || !maxBytes || maxBytes <= 0) return { text: str, clipped: false };
  const bytes = Buffer.from(str, "utf8");
  if (bytes.length <= maxBytes) return { text: str, clipped: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;   // back off mid-sequence
  return {
    text: bytes.subarray(0, end).toString("utf8"),
    clipped: true,
    totalBytes: bytes.length,
    shownBytes: end,
  };
}

defineTool({
  name: "network_get_requests",
  readOnly: true,
  description:
    "List HTTP requests captured since attach, with method, status, duration, size and initiator. Filter by URL "
    + "substring, method, status or failures only. Response bodies are opt-in via include_bodies because they are "
    + "large. Capture starts when DevCDP attaches, so requests from before that are not here — reload to see them.",
  args: {
    url_filter:     { type: "string",  description: "Only requests whose URL contains this substring." },
    method:         { type: "string",  description: "Only this HTTP method, e.g. POST." },
    status:         { type: "number",  description: "Only this exact response status." },
    min_status:     { type: "number",  description: "Only responses with status >= this, e.g. 400 for problems." },
    failed_only:    { type: "boolean", description: "Only network failures and 4xx/5xx responses.", default: false },
    limit:          { type: "number",  description: "Maximum requests to return.", default: 20, min: 1, max: 200 },
    offset:         { type: "number",  description: "Skip this many of the newest matches, for paging back in time.", default: 0, min: 0 },
    include_headers:{ type: "boolean", description: "Include request and response headers.", default: false },
    include_bodies: { type: "boolean", description: "Include response bodies, subject to max_body_bytes.", default: false },
    include_post_data: { type: "boolean", description: "Include request payloads.", default: false },
    max_body_bytes: { type: "number",  description: "Per-body byte cap when include_bodies is set.", default: 2048, min: 0, max: 200000 },
  },
  async handler(args, ctx) {
    let reqs = ctx.network.all();
    const totalHeld = reqs.length;

    if (args.url_filter) reqs = reqs.filter(r => r.url.includes(args.url_filter));
    if (args.method)     reqs = reqs.filter(r => r.method === args.method.toUpperCase());
    if (args.status)     reqs = reqs.filter(r => r.status === args.status);
    if (args.min_status) reqs = reqs.filter(r => r.status != null && r.status >= args.min_status);
    if (args.failed_only) reqs = reqs.filter(r => r.error || (r.status != null && r.status >= 400));

    const matched = reqs.length;
    const end     = args.offset > 0 ? -args.offset : undefined;
    let page      = reqs.slice(Math.max(0, matched - args.limit - args.offset), end === undefined ? matched : end);

    const out = [];
    for (const r of page) {
      const item = ctx.conn.publicRequest(r, {
        headers: args.include_headers, postData: args.include_post_data,
        full: args.include_headers === true,
      });
      if (args.include_bodies && r.status != null && !r.error) {
        try {
          const { body, base64Encoded } = await ctx.conn.client.Network.getResponseBody({ requestId: r.requestId });
          if (base64Encoded) {
            item.body = "(binary)";
            item.bodyBase64Bytes = Buffer.from(body || "", "base64").length;
          } else {
            const clip = byteClip(body, args.max_body_bytes);
            item.body = clip.text;
            if (clip.clipped) item.bodyClipped = `showing ${clip.shownBytes} of ${clip.totalBytes} bytes — raise max_body_bytes or use network_get_response_body`;
          }
        } catch (e) {
          item.bodyUnavailable = `Chrome no longer holds this body (${e.message}). Bodies are discarded on navigation.`;
        }
      }
      out.push(item);
    }

    const stats = ctx.network.stats();
    return {
      count: out.length,
      matched,
      held: totalHeld,
      requests: out,
      ...(matched > out.length ? { note: `${matched} matched; showing ${out.length}. Use offset to page further back.` } : {}),
      ...(stats.dropped ? { evicted: stats.dropped, evictionNote: stats.note } : {}),
    };
  },
});

defineTool({
  name: "network_wait_for_request",
  readOnly: true,
  description:
    "Block until a request whose URL contains url_filter completes, then return it. Event driven, so there is no "
    + "polling. Call this immediately AFTER triggering the action, or pass a filter that has not fired yet — a "
    + "request that already completed is returned straight away. Gives up after timeout_ms and tells you so.",
  args: {
    url_filter: { type: "string", description: "Substring the request URL must contain.", required: true },
    method:     { type: "string", description: "Also require this HTTP method." },
    timeout_ms: { type: "number", description: "Give up after this long.", default: 15000, min: 100, max: 120000 },
    allow_existing: { type: "boolean", description: "Satisfy immediately from an already-completed matching request.", default: true },
  },
  // Waits on purpose: the backstop must sit above the caller's own ceiling.
  deadlineFor: args => args.timeout_ms + 5000,
  async handler(args, ctx) {
    if (args.allow_existing) {
      const done = ctx.network.all().filter(r =>
        r.url.includes(args.url_filter) &&
        (!args.method || r.method === args.method.toUpperCase()) &&
        (r.status != null || r.error));
      if (done.length) {
        return { matched: ctx.conn.publicRequest(done[done.length - 1]), source: "already-completed", waitedMs: 0 };
      }
    }

    // A blocking wait is the one place the overlay can look frozen for no visible
    // reason. Name what is being waited for, then say how it ended.
    const started = Date.now();
    ctx.conn.setBadge(`waiting for ${args.url_filter}`, "busy");

    const req = await new Promise((resolve, reject) => {
      const waiter = {
        filter: args.url_filter,
        method: args.method ? args.method.toUpperCase() : null,
        resolve,
        timer: setTimeout(() => {
          const i = ctx.waiters.indexOf(waiter);
          if (i >= 0) ctx.waiters.splice(i, 1);
          reject(Object.assign(new Error("timeout"), { __timeout: true }));
        }, args.timeout_ms),
      };
      ctx.waiters.push(waiter);
    }).catch(e => {
      if (!e.__timeout) throw e;
      ctx.conn.setBadge(`nothing matched ${args.url_filter} in ${args.timeout_ms}ms`, "err");
      fail(CODES.TIMEOUT,
        `No request matching "${args.url_filter}" completed within ${args.timeout_ms}ms.`,
        "Confirm the action actually fired, check the filter against network_get_requests, or raise timeout_ms.",
        { held: ctx.network.stats().count });
    });

    const waitedMs = Date.now() - started;
    ctx.conn.setBadge(
      `${req.status ?? req.error ?? "done"} ← ${args.url_filter} (${waitedMs}ms)`,
      req.error || (req.status >= 400) ? "err" : null);
    return { matched: ctx.conn.publicRequest(req), source: "observed", waitedMs };
  },
});

defineTool({
  name: "network_get_response_body",
  readOnly: true,
  description:
    "Fetch the full response body for one requestId from network_get_requests. Chrome discards bodies when the page "
    + "navigates, so read them while the page is still on the same document.",
  // The only camelCase argument on the whole surface was here, so anyone who had
  // learned the convention from the other sixty tools passed request_id and was
  // rejected. Both are accepted; request_id is the documented one.
  args: {
    request_id:     { type: "string", description: "The requestId field from a network_get_requests row." },
    requestId:      { type: "string", description: "Deprecated spelling of request_id; both work." },
    max_body_bytes: { type: "number", description: "Byte cap; 0 means no limit.", default: 0, min: 0, max: 5000000 },
  },
  async handler(args, ctx) {
    const requestId = args.request_id || args.requestId;
    if (!requestId) {
      fail(CODES.BAD_ARGS, "No request id was given.",
        "Pass request_id, taken from the requestId field of a network_get_requests row.");
    }
    const known = ctx.network.get(requestId);
    try {
      const { body, base64Encoded } = await ctx.conn.client.Network.getResponseBody({ requestId });
      if (base64Encoded) {
        const buf = Buffer.from(body || "", "base64");
        return { url: known?.url || null, base64Encoded: true, bytes: buf.length, body: "(binary — not decoded)" };
      }
      const clip = byteClip(body, args.max_body_bytes);
      return {
        url: known?.url || null,
        status: known?.status ?? null,
        mimeType: known?.mimeType || null,
        base64Encoded: false,
        body: clip.text,
        ...(clip.clipped ? { clipped: true, shownBytes: clip.shownBytes, totalBytes: clip.totalBytes } : {}),
      };
    } catch (e) {
      fail(CODES.IO_FAILED, `Chrome could not return that body: ${e.message}`,
        known
          ? "The page has probably navigated since. Re-trigger the request and read the body before navigating."
          : "That requestId is not in the buffer — call network_get_requests first.");
    }
  },
});

defineTool({
  name: "network_clear",
  destructive: false, idempotent: true,
  description:
    "Empty the network buffer so the next thing you read belongs only to the action you are about to take. "
    + "Does not affect the browser's own Network panel.",
  async handler(_args, ctx) {
    const before = ctx.network.stats().count;
    ctx.network.clear();
    return { cleared: true, discarded: before };
  },
});
