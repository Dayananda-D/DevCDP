// ─── Screen capture ──────────────────────────────────────────────────────────
//
// Three decisions shape this tool, and each of them is the difference between a
// screenshot that is useful and one that is actively misleading:
//
//   To disk by default. A full-page capture of a real application runs well over a
//   megabyte of base64 — a quarter of a million tokens, more than the entire tool
//   listing, paid on one call. So the image is written to a file and the reply carries
//   the path. `inline: true` hands it to the model when the model genuinely needs to
//   look, and even then it is scaled to fit a budget rather than sent whole.
//
//   DevCDP's own overlay is hidden first. Otherwise every screenshot has our badge,
//   our messages and our edge border baked into it — which is worthless for a bug
//   report and actively wrong for anything comparing against a reference image. It is
//   hidden for the capture and restored afterwards, including if the capture throws.
//
//   Regions come from the same locator as the interaction tools. "Snip the total"
//   should not require anyone to work out pixel coordinates, and the element's box is
//   already something DevCDP can find by the text a person reads.

import fs from "fs";
import path from "path";

import { defineTool } from "../core/tools.js";
import { CODES, fail } from "../core/errors.js";
import { withElementExpression } from "../browser/locate.js";

const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/** Slug that keeps a screenshot's filename recognisable a week later. */
function fileNameFor(args, page) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const hint = (args.selector || args.text || args.testid || page?.title || "page")
    .toString().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
  return `${stamp}-${hint}.${args.format}`;
}

async function evalJson(ctx, expression, label) {
  const { result, exceptionDetails } = await ctx.conn.eval(expression, { label });
  if (exceptionDetails) {
    fail(CODES.EVAL_FAILED,
      `The page threw while measuring what to capture: ${exceptionDetails.exception?.description?.split("\n")[0] || exceptionDetails.text}`,
      "Usually an invalid selector — dom_query is a safe way to test one.");
  }
  try { return JSON.parse(result?.value || "{}"); } catch (_) { return {}; }
}

/**
 * Take the overlay out of the picture, run the capture, put it back.
 *
 * Restoration has to be unconditional. A capture that throws with the overlay hidden
 * leaves the user staring at an application that has silently stopped telling them
 * anything, with no way to know why — worse than the screenshot they did not get.
 */
async function withoutOverlay(ctx, hide, capture) {
  if (!hide) return capture();

  const set = display => ctx.conn.evalQuiet(
    `(function(){var h=document.getElementById('devcdp-badge-host');
      if(!h) return 'absent'; h.style.display=${JSON.stringify(display)}; return 'ok';})()`, 2000);

  const was = await set("none");
  try {
    return await capture();
  } finally {
    if (was === "ok") await set("");
  }
}

defineTool({
  name: "page_screenshot",
  readOnly: true,
  description:
    "Capture what is on screen: the viewport, the whole scrollable page, one element, or an explicit rectangle. "
    + "Name the element the same way as the ui_* tools — by CSS selector, by the text a person reads, or by test id — "
    + "so snipping a region does not require working out coordinates. DevCDP's own badge and messages are hidden "
    + "first, so the image shows the application and nothing else. Written to a file and returned as a path; pass "
    + "inline:true when you need to look at it yourself, which costs a great deal of context.",
  args: {
    selector: { type: "string", description: "CSS selector of the element to capture. Descends into open shadow roots." },
    text:     { type: "string", description: "Visible text of the element to capture." },
    testid:   { type: "string", description: "Test attribute value of the element to capture." },
    nth:      { type: "number", description: "Which match to use when several qualify, 0-based.", default: 0, min: 0, max: 500 },
    rect:     { type: "object", description: "Explicit page-coordinate region { x, y, width, height }. Overrides any element target." },
    full_page: { type: "boolean", description: "Capture the whole scrollable page, not just the viewport. Ignored when a target or rect is given.", default: false },
    format:   { type: "string", description: "Image format. jpeg is far smaller for photographic content; png is exact.", enum: ["png", "jpeg", "webp"], default: "png" },
    quality:  { type: "number", description: "1-100, for jpeg and webp only.", default: 80, min: 1, max: 100 },
    max_width: { type: "number", description: "Scale the capture down to at most this many pixels wide. Keeps a full-page shot to a sane size.", default: 1600, min: 64, max: 8000 },
    hide_overlay: { type: "boolean", description: "Hide DevCDP's badge and messages for the capture. Turn off only when the overlay itself is what you are looking at.", default: true },
    save_to:  { type: "string", description: "Absolute path to write to. Defaults to a timestamped file in the screenshotDir setting." },
    inline:   { type: "boolean", description: "Also return the image itself so you can see it. Expensive — a large capture can cost more context than every tool description combined.", default: false },
  },
  async handler(args, ctx) {
    const targeted = !!(args.selector || args.text || args.testid);

    // Page geometry, and the element's box when one was asked for. Both in *page*
    // coordinates: Page.captureScreenshot's clip is measured from the document origin,
    // not the viewport, so a rect straight out of getBoundingClientRect is wrong by
    // however far the page happens to be scrolled.
    const page = await evalJson(ctx, `JSON.stringify({
      title: document.title,
      scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY),
      viewportW: window.innerWidth, viewportH: window.innerHeight,
      pageW: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
      pageH: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
      dpr: window.devicePixelRatio || 1
    })`, "measure page");

    let clip, of, element = null;

    if (args.rect) {
      const { x, y, width, height } = args.rect;
      if (![x, y, width, height].every(n => typeof n === "number" && Number.isFinite(n))) {
        fail(CODES.BAD_ARGS, "rect needs numeric x, y, width and height.",
          "Coordinates are page coordinates, as reported by dom_query.");
      }
      if (width < 1 || height < 1) fail(CODES.BAD_ARGS, "rect has no area.", "width and height must be at least 1.");
      clip = { x, y, width, height };
      of = "rect";

    } else if (targeted) {
      const found = await evalJson(ctx, withElementExpression(
        { selector: args.selector, text: args.text, testid: args.testid, testAttributes: ctx.cfg.testAttributes },
        { nth: args.nth },
        `try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch(_) {}
         var r = el.getBoundingClientRect();
         return { rect: { x: r.left + window.scrollX, y: r.top + window.scrollY,
                          width: r.width, height: r.height } };`),
        "measure element");

      if (!found.found) {
        fail(CODES.NO_TARGET,
          `Nothing matches ${args.selector ? `selector "${args.selector}"` : args.text ? `text "${args.text}"` : `testid "${args.testid}"`}.`,
          "ui_inspect lists the controls actually on screen; dom_query confirms any selector.");
      }
      if (!found.rect || found.rect.width < 1 || found.rect.height < 1) {
        fail(CODES.NO_TARGET, "That element has no visible area, so there is nothing to capture.",
          "It may be collapsed or display:none — dom_query(visible_only:false) will say.");
      }
      clip = found.rect;
      of = "element";
      element = found.node;

    } else if (args.full_page) {
      clip = { x: 0, y: 0, width: page.pageW, height: page.pageH };
      of = "full-page";

    } else {
      clip = { x: page.scrollX, y: page.scrollY, width: page.viewportW, height: page.viewportH };
      of = "viewport";
    }

    // One scale for the whole capture, so a 4000px-wide page does not arrive as a
    // 12 MB file nobody asked for.
    const scale = Math.min(1, args.max_width / Math.max(1, clip.width));

    const shot = await withoutOverlay(ctx, args.hide_overlay, () =>
      ctx.conn.client.Page.captureScreenshot({
        format: args.format,
        ...(args.format === "png" ? {} : { quality: args.quality }),
        clip: {
          x: Math.round(clip.x), y: Math.round(clip.y),
          width: Math.round(clip.width), height: Math.round(clip.height),
          scale,
        },
        // Required for anything outside the visible area, and harmless otherwise.
        captureBeyondViewport: true,
      }));

    if (!shot?.data) {
      fail(CODES.EVAL_FAILED, "Chrome returned no image data.",
        "The tab may have navigated mid-capture. Retry, or capture the viewport rather than the full page.");
    }

    const bytes = Buffer.from(shot.data, "base64");
    const file = args.save_to || path.join(ctx.cfg.screenshotDir, fileNameFor(args, page));
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    } catch (e) {
      fail(CODES.IO_FAILED, `Captured the image but could not write ${file}: ${e.message}`,
        "Set save_to to a writable path, or change screenshotDir in your settings.");
    }

    ctx.conn.setBadge(`captured ${of}`, "busy");
    ctx.recordActivity("capture", { of, file, bytes: bytes.length, ...(element ? { element } : {}) });

    const kb = Math.round(bytes.length / 1024);
    return {
      captured: of,
      file,
      size: { bytes: bytes.length, kb },
      dimensions: {
        width: Math.round(clip.width * scale), height: Math.round(clip.height * scale),
        ...(scale < 1 ? { scaledFrom: { width: Math.round(clip.width), height: Math.round(clip.height) }, scale: Number(scale.toFixed(3)) } : {}),
      },
      ...(element ? { element } : {}),
      overlayHidden: args.hide_overlay,
      // Chrome draws this itself, above the page, and no DOM change can remove it —
      // so a screenshot taken at a breakpoint has a banner in it that is not the app's.
      ...(ctx.pause.active
        ? { note: "The page is paused at a breakpoint, so Chrome's own \"Paused in debugger\" bar is in the image. It is not part of the application." }
        : {}),
      ...(args.inline
        ? { _media: { data: shot.data, mimeType: MIME[args.format] },
            inlined: `${kb} KB of image returned as well as written to disk` }
        : { hint: "Read the file to look at it, or pass inline:true to have it returned here." }),
    };
  },
});
