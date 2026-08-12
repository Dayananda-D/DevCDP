// ─── Buffers ─────────────────────────────────────────────────────────────────
// Ring buffers with explicit cursors and honest accounting. v4 dropped data
// silently: the network log evicted its oldest entry with no record (NET-2), and
// console logs were keyed on whichever target happened to be current.
//
// Every buffer here reports `dropped` so a caller can tell "nothing happened"
// apart from "it happened and we lost it".

export class RingBuffer {
  constructor(limit) {
    this.limit   = limit;
    this.items   = [];
    this.seq     = 0;
    this.dropped = 0;
  }

  push(entry) {
    entry.seq = ++this.seq;
    this.items.push(entry);
    while (this.items.length > this.limit) { this.items.shift(); this.dropped++; }
    return entry;
  }

  /** Entries newer than `cursor`; 0 means everything retained. */
  since(cursor = 0) {
    return cursor > 0 ? this.items.filter(e => e.seq > cursor) : [...this.items];
  }

  clear() { this.items.length = 0; return this; }

  stats() {
    return {
      count: this.items.length,
      cursor: this.seq,
      dropped: this.dropped,
      ...(this.dropped ? { note: `${this.dropped} older entries evicted (buffer holds ${this.limit})` } : {}),
    };
  }
}

/**
 * Console logs, keyed per target so a reconnect to the same tab keeps its
 * history and a switch to a different tab cannot inherit someone else's.
 */
export class ConsoleStore {
  constructor(limit) { this.limit = limit; this.byTarget = new Map(); }

  for(targetId) {
    const key = targetId || "__detached__";
    if (!this.byTarget.has(key)) this.byTarget.set(key, new RingBuffer(this.limit));
    return this.byTarget.get(key);
  }

  forget(targetId) { this.byTarget.delete(targetId || "__detached__"); }
}

/** Network requests keyed by CDP requestId, with eviction accounting. */
export class NetworkStore {
  constructor(limit) {
    this.limit   = limit;
    this.map     = new Map();
    this.dropped = 0;
  }

  start(requestId, entry) {
    this.map.set(requestId, entry);
    while (this.map.size > this.limit) {
      this.map.delete(this.map.keys().next().value);
      this.dropped++;
    }
    return entry;
  }

  get(requestId)    { return this.map.get(requestId) || null; }
  all()             { return [...this.map.values()]; }
  clear()           { this.map.clear(); return this; }

  stats() {
    return {
      count: this.map.size,
      dropped: this.dropped,
      ...(this.dropped ? { note: `${this.dropped} older requests evicted (buffer holds ${this.limit})` } : {}),
    };
  }
}
