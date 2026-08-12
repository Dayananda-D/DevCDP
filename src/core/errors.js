// ─── Structured error contract (ARCH-4) ──────────────────────────────────────
// Every failure leaves the server as { ok:false, code, message, hint }.
// Nothing is allowed to look like a success when it isn't (DBG-1, SRC-2).

export const CODES = {
  NOT_CONNECTED:      "NOT_CONNECTED",
  CHROME_UNREACHABLE: "CHROME_UNREACHABLE",
  NO_TARGET:          "NO_TARGET",
  TARGET_CLAIMED:     "TARGET_CLAIMED",
  TARGET_GONE:        "TARGET_GONE",
  SESSION_CONTENTION: "SESSION_CONTENTION",
  NOT_PAUSED:         "NOT_PAUSED",
  BREAKPOINT_UNBOUND: "BREAKPOINT_UNBOUND",
  SCRIPT_NOT_FOUND:   "SCRIPT_NOT_FOUND",
  SOURCEMAP_MISSING:  "SOURCEMAP_MISSING",
  NO_SESSION:         "NO_SESSION",
  BAD_ARGS:           "BAD_ARGS",
  TIMEOUT:            "TIMEOUT",
  PAGE_UNRESPONSIVE:  "PAGE_UNRESPONSIVE",
  EVAL_FAILED:        "EVAL_FAILED",
  UNSUPPORTED:        "UNSUPPORTED",
  IO_FAILED:          "IO_FAILED",
  INTERNAL:           "INTERNAL",
};

export class DevCdpError extends Error {
  /** @param {string} code @param {string} message @param {string=} hint @param {object=} details */
  constructor(code, message, hint, details) {
    super(message);
    this.name    = "DevCdpError";
    this.code    = code;
    this.hint    = hint || null;
    this.details = details || null;
  }

  toResult() {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      ...(this.hint    ? { hint: this.hint }       : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export const fail = (code, message, hint, details) => {
  throw new DevCdpError(code, message, hint, details);
};

/** Wrap an unknown throw into the contract without losing the original text. */
export function toErrorResult(err) {
  if (err instanceof DevCdpError) return err.toResult();
  return {
    ok: false,
    code: CODES.INTERNAL,
    message: err?.message || String(err),
    ...(err?.stack ? { details: { stack: err.stack.split("\n").slice(0, 4) } } : {}),
  };
}
