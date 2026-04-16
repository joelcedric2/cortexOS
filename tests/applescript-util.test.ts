/**
 * Tests for src/apps/applescript-util.ts — shared quoteAS helper.
 *
 * Covers: quotes, backslashes, newlines, non-ASCII, NUL-byte rejection,
 * combined escapes, and the two export variants (bare inner + wrapped).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { quoteAS, quoteASInner } from "../src/apps/applescript-util.js";

/* ------------------------------------------------------------------ */
/*  quoteASInner — bare inner (mail/messages/calendar convention)      */
/* ------------------------------------------------------------------ */

describe("quoteASInner", () => {
  it("doubles embedded double-quotes", () => {
    assert.equal(quoteASInner(`hi "bob"`), `hi \\"bob\\"`);
  });

  it("escapes backslashes", () => {
    assert.equal(quoteASInner(`path\\to\\file`), `path\\\\to\\\\file`);
  });

  it("strips \\n / \\r\\n / \\r sequences to single space", () => {
    assert.equal(quoteASInner("line1\nline2"), "line1 line2");
    assert.equal(quoteASInner("line1\r\nline2"), "line1 line2");
    assert.equal(quoteASInner("a\n\n\nb"), "a b");
    assert.equal(quoteASInner("a\rb"), "a b");
  });

  it("combines all escapes together", () => {
    assert.equal(
      quoteASInner(`say "hi"\nand\\stuff`),
      `say \\"hi\\" and\\\\stuff`,
    );
  });

  it("returns empty for empty input", () => {
    assert.equal(quoteASInner(""), "");
  });

  it("leaves plain ASCII alone", () => {
    assert.equal(quoteASInner("Hello, Joel!"), "Hello, Joel!");
  });

  it("handles non-ASCII: emoji, ZWJ, combining marks, RTL", () => {
    // Emoji with ZWJ (family)
    assert.equal(quoteASInner("👨‍👩‍👧‍👦"), "👨‍👩‍👧‍👦");
    // Combining mark (e-acute)
    assert.equal(quoteASInner("e\u0301"), "e\u0301");
    // RTL override
    assert.equal(quoteASInner("\u200F\u0639\u0631\u0628\u064A"), "\u200F\u0639\u0631\u0628\u064A");
  });

  it("rejects NUL bytes", () => {
    assert.throws(
      () => quoteASInner("safe\x00unsafe"),
      /NUL byte/,
    );
    assert.throws(
      () => quoteASInner("\x00"),
      /NUL byte/,
    );
  });

  it("blocks AppleScript metachar injection attempt", () => {
    // A classic injection: close the AS string, then shell-script.
    const malicious = `"; do shell script "whoami`;
    const escaped = quoteASInner(malicious);
    // The resulting string should NOT contain an unescaped `"`.
    // Every `"` in the output is preceded by `\\`.
    assert.doesNotMatch(escaped, /(?<!\\)"/);
    // And when reconstituted, the literal content is the expected string.
    assert.equal(
      escaped,
      `\\"; do shell script \\"whoami`,
    );
  });
});

/* ------------------------------------------------------------------ */
/*  quoteAS — wrapped (safari/notes/reminders/music/finder convention) */
/* ------------------------------------------------------------------ */

describe("quoteAS (wrapped)", () => {
  it("wraps simple string in double-quotes", () => {
    assert.equal(quoteAS("hi"), `"hi"`);
  });

  it("escapes and wraps embedded quotes", () => {
    assert.equal(quoteAS(`say "hi"`), `"say \\"hi\\""`);
  });

  it("escapes and wraps backslashes", () => {
    assert.equal(quoteAS(`back\\slash`), `"back\\\\slash"`);
  });

  it("strips newlines in wrapped output", () => {
    assert.equal(quoteAS("a\nb"), `"a b"`);
    assert.equal(quoteAS("a\r\nb"), `"a b"`);
  });

  it("handles empty string", () => {
    assert.equal(quoteAS(""), `""`);
  });

  it("rejects NUL byte in wrapped path", () => {
    assert.throws(() => quoteAS("a\x00b"), /NUL byte/);
  });
});
