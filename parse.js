// A fast, dependency-free CommonMark 0.31.2 + GFM renderer, written from
// scratch to match marked 18.1.3's default output byte for byte.
//
// Architecture: a line-based block parser (CommonMark phase 1) builds a
// block tree, then each leaf block's text is run through an inline parser
// that tokenizes (code spans, links, autolinks, raw HTML, entities, breaks)
// and resolves emphasis with the delimiter-stack algorithm of the spec's
// Appendix A. Rendering is a single pass over the tree.

const SPACE = 32;
const TAB = 9;
const LF = 10;
const CR = 13;

// ASCII punctuation, per the CommonMark definition.
function isAsciiPunct(c) {
  return (
    (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126)
  );
}

function isSpaceCode(c) {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 0x85 || c === 0xa0 ||
    c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
    c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000
  );
}

// ASCII whitespace only (space, tab, newline, CR, FF, VT): the only
// whitespace that separates a link destination from its title. Unicode
// spaces such as NBSP are part of the destination instead.
function isLinkWs(c) {
  return c === 32 || (c >= 9 && c <= 13);
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCode(c) {
  if (c < 128) return isAsciiPunct(c);
  return PUNCT_RE.test(String.fromCodePoint(c));
}

// Is the character at `s[i]` (a UTF-16 code unit index) a punctuation
// character? Handles surrogate pairs for non-BMP code points.
function isPunctAt(s, i) {
  const c = s.charCodeAt(i);
  if (c < 128) return isAsciiPunct(c);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) {
      return PUNCT_RE.test(String.fromCodePoint(0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00)));
    }
  }
  return PUNCT_RE.test(s[i]);
}

function isSpaceAt(s, i) {
  return isSpaceCode(s.charCodeAt(i));
}

// ---------------------------------------------------------------------------
// HTML escaping
//
// escape(s, true)  escapes & < > " ' unconditionally (autolink hrefs/text).
// escape(s, false) escapes < > " ' and & except when & begins something
//                    that looks like an entity: &#123; &#xAB; &#XAB; or
//                    &word; (the named entity itself is left as-is; only
//                    numeric entities are decoded, and only in text).
// ---------------------------------------------------------------------------

const ENTITY_LIKE = /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);/y;

function escapeHtml(s, encode) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      if (encode) rep = '&amp;';
      else {
        ENTITY_LIKE.lastIndex = i;
        rep = ENTITY_LIKE.test(s) ? null : '&amp;';
      }
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Plain text escaping for code spans / fenced code: only & < > " are escaped
// (and & is escaped unconditionally here).
function escapeCode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// ---------------------------------------------------------------------------
// cleanUrl: encodeURI, then undo the %25 that encodeURI adds for a literal
// %, so existing %XX sequences survive. Returns null when encodeURI throws
// (lone surrogate), which drops the link entirely.
// ---------------------------------------------------------------------------

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Decode a numeric character reference starting at s[i] ('&' + '#' ...).
// Returns [character, lengthConsumed] or null when it is not a valid
// numeric reference (too many digits, bad digits, no ';'). Out-of-range,
// zero and surrogate code points decode to U+FFFD.
function numericEntityAt(s, i) {
  // s[i] === '&', s[i+1] === '#'
  let j = i + 2;
  let hex = false;
  if (j < s.length && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { // x X
    hex = true;
    j++;
  }
  const dstart = j;
  let v = 0;
  let ndig = 0;
  if (hex) {
    while (j < s.length) {
      const c = s.charCodeAt(j);
      let d = -1;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (c >= 97 && c <= 102) d = c - 87;
      else if (c >= 65 && c <= 70) d = c - 55;
      else break;
      if (ndig >= 6) return null;
      v = v * 16 + d;
      ndig++;
      j++;
    }
  } else {
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c < 48 || c > 57) break;
      if (ndig >= 7) return null;
      v = v * 10 + (c - 48);
      ndig++;
      j++;
    }
  }
  if (ndig === 0 || j >= s.length || s.charCodeAt(j) !== 59) return null; // ';'
  if (v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) v = 0xfffd;
  return [String.fromCodePoint(v), j + 1 - i];
}

// ---------------------------------------------------------------------------
// Link reference label normalization: collapse internal whitespace runs
// (space, tab, newline) to one space, trim, Unicode case fold.
// ---------------------------------------------------------------------------

function normalizeLabel(raw) {
  let out = '';
  let pendingSpace = false;
  let started = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      if (started) pendingSpace = true;
    } else {
      if (pendingSpace) { out += ' '; pendingSpace = false; }
      out += raw[i];
      started = true;
    }
  }
  // Full Unicode case folding (not just toLowerCase): sharp S folds to
  // "ss" and final sigma folds to sigma, so [ẞ] matches [SS].
  // NOTE: backslash escapes are NOT unescaped here — the label is
  // matched literally, so [foo\!] does not match [foo!].
  return out.toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

// Find the index of the bracket that closes the bracket opened at `open`
// (s[open] is '[' or '('). Depth counts nested brackets; backslash escapes
// are skipped. Returns the index of the closing bracket, or -1.
function findClosingBracket(s, open, openCh, closeCh) {
  let level = 0;
  for (let i = open; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash: skip the next character
      i++;
    } else if (c === 96) { // backtick run: marked's link-label grammar
      // A backtick run in link text pairs with the NEXT backtick run
      // (any length) as a code span, swallowing any `]` in between
      // (so `[a ``b](u) `c`` is no link); a run of length >= 2
      // immediately before the closing bracket is literal text (so
      // `[a ``](u)` still forms, even with a later backtick); a run
      // with no later backtick and not before the closer kills the
      // link (so `[a ``b](u)` is literal). Runs are consumed in
      // order: a run that already paired as a closer is never
      // re-opened, so the skip must not jump past the `]`.
      let j = i;
      while (j < s.length && s.charCodeAt(j) === 96) j++;
      const len = j - i;
      if (len >= 2 && j < s.length && s.charCodeAt(j) === closeCh) {
        i = j - 1; // literal run right before the closer
      } else {
        const nxt = s.indexOf('`', j);
        if (nxt === -1) return -1;
        let m = nxt;
        while (m < s.length && s.charCodeAt(m) === 96) m++;
        i = m - 1;
      }
    } else if (c === 60) { // '<': skip an HTML tag / autolink (a `]`
      // inside one is not a link closer); `>` inside a quoted attribute
      // value does not close the tag
      const nc = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      const isTagStart =
        (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122) || // letter
        nc === 33 || nc === 63 || // ! ?
        (nc === 47 && i + 2 < s.length && // / + letter
          ((s.charCodeAt(i + 2) >= 65 && s.charCodeAt(i + 2) <= 90) ||
           (s.charCodeAt(i + 2) >= 97 && s.charCodeAt(i + 2) <= 122)));
      if (isTagStart) {
        let q = 0; // 0 = unquoted, 34 = in "...", 39 = in '...'
        let gt = -1;
        for (let k = i + 1; k < s.length; k++) {
          const cc = s.charCodeAt(k);
          if (q === 0) {
            if (cc === 34 || cc === 39) q = cc;
            else if (cc === 62) { gt = k; break; }
            else if (cc === 10) break;
          } else if (cc === q) {
            q = 0;
          }
        }
        if (gt !== -1) i = gt;
      }
    } else if (c === openCh) {
      level++;
    } else if (c === closeCh) {
      level--;
      if (level === 0) return i;
    }
  }
  return -1;
}

// Code-span mask for an inline source (marked's maskedSrc): intervals
// [start, end) of code spans found by same-length backtick-run pairing,
// left to right, ignoring link structure. A code span pairs the run at i
// with the NEXT run of the same length, even across a link boundary
// (e.g. the `` ` `` in a link text pairs with the `` ` `` of a later code
// span, masking the text between them). Delimiters inside a masked
// interval cannot CLOSE emphasis/strikethrough (they can still open).
function codeSpanMask(s) {
  const n = s.length;
  const mask = [];
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) { i += 2; continue; } // skip escape: `\`` is not a run
    if (c !== 96) { i++; continue; }
    let j = i;
    while (j < n && s.charCodeAt(j) === 96) j++;
    const len = j - i;
    let k = j;
    let found = -1, fend = -1;
    while (k < n) {
      // NOTE: no backslash skipping here — once a code span has opened,
      // its closer is the next same-length run even if preceded by a
      // backslash (the backslash is literal content, cf. marked's
      // code-span regex which does not check escapes for the closer).
      // Only the OPENER scan above skips `\``.
      if (s.charCodeAt(k) !== 96) { k++; continue; }
      let m = k;
      while (m < n && s.charCodeAt(m) === 96) m++;
      if (m - k === len) { found = k; fend = m; break; }
      k = m;
    }
    if (found === -1) { i = j; continue; }
    mask.push([i, fend]);
    i = fend;
  }
  return mask;
}

// Does the region s[start..end) contain a label-style code span
// (`+[^`]+`+) whose opener and closer runs have DIFFERENT lengths?
// Runs pair in order with the next run (any length); a matched pair is
// skipped, an unmatched run ends the scan. Used for the failed-link
// emphasis rule: only a length-mismatched pair suppresses closers.
function hasMismatchedCodeSpan(s, start, end) {
  let i = start;
  while (i < end) {
    if (s.charCodeAt(i) !== 96) { i++; continue; }
    let j = i;
    while (j < end && s.charCodeAt(j) === 96) j++;
    const len = j - i;
    const nxt = s.indexOf('`', j);
    if (nxt === -1 || nxt >= end) return false;
    let m = nxt;
    while (m < end && s.charCodeAt(m) === 96) m++;
    if (m - nxt !== len) return true;
    i = m;
  }
  return false;
}

// Find the bracket that would close the '[' at `open`, leniently: code
// spans are skipped by same-length pairing and an unmatched backtick run
// is literal (never -1 for backticks). Used only to locate the text of a
// link attempt that already failed, so emphasis inside it can be judged.
function findBracketCloseLenient(s, open) {
  let level = 0;
  for (let i = open; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash: skip the next character
      i++;
    } else if (c === 96) { // backtick run: skip a same-length code span
      let j = i;
      while (j < s.length && s.charCodeAt(j) === 96) j++;
      const len = j - i;
      let k = j;
      let found = -1;
      while (k < s.length) {
        const idx = s.indexOf('`', k);
        if (idx === -1) break;
        let m = idx;
        while (m < s.length && s.charCodeAt(m) === 96) m++;
        if (m - idx === len) { found = m; break; }
        k = m;
      }
      if (found !== -1) i = found - 1;
      else i = j - 1;
    } else if (c === 60) { // '<': skip an HTML tag (a `]` inside one is
      // not a link closer)
      const nc = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      const isTagStart =
        (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122) ||
        nc === 33 || nc === 63 ||
        (nc === 47 && i + 2 < s.length &&
          ((s.charCodeAt(i + 2) >= 65 && s.charCodeAt(i + 2) <= 90) ||
           (s.charCodeAt(i + 2) >= 97 && s.charCodeAt(i + 2) <= 122)));
      if (isTagStart) {
        let q = 0;
        let gt = -1;
        for (let k = i + 1; k < s.length; k++) {
          const cc = s.charCodeAt(k);
          if (q === 0) {
            if (cc === 34 || cc === 39) q = cc;
            else if (cc === 62) { gt = k; break; }
            else if (cc === 10) break;
          } else if (cc === q) {
            q = 0;
          }
        }
        if (gt !== -1) i = gt;
      }
    } else if (c === 91) {
      level++;
    } else if (c === 93) {
      level--;
      if (level === 0) return i;
    }
  }
  return -1;
}

// Find the ')' matching the '(' at `open` (paren depth, backslash
// escapes). Returns -1 when unclosed.
function findParenClose(s, open) {
  let depth = 0;
  for (let i = open + 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) { i++; continue; }
    if (c === 40) depth++;
    else if (c === 41) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

// When an inline link attempt `[text](...)` fails, emphasis closers
// inside the bracket text are suppressed iff the attempt contains a
// length-mismatched label-style code span (in the text or the parens).
// Returns the [start, end) text range whose closers are suppressed, or
// null. Only an inline attempt counts: no parens, a space before them,
// a reference label, or an unclosed paren all leave emphasis alone.
function failedLinkNoClose(s, bracket) {
  const close = findBracketCloseLenient(s, bracket);
  if (close === -1) return null;
  if (s.charCodeAt(close + 1) !== 40) return null;
  const parenEnd = findParenClose(s, close + 1);
  if (parenEnd === -1) return null;
  if (hasMismatchedCodeSpan(s, bracket + 1, close)) return [bracket + 1, close];
  if (hasMismatchedCodeSpan(s, close + 1, parenEnd)) return [bracket + 1, close];
  return null;
}

// ---------------------------------------------------------------------------
// Inline tokenizer
//
// Token shapes:
//   {k:'t', s}            plain text (may still need HTML escaping)
//   {k:'code', s}         code span content (newlines already spaces)
//   {k:'br'}              hard break  -> <br>
//   {k:'soft'}            soft break  -> \n
//   {k:'html', s}         raw HTML tag / comment / declaration
//   {k:'auto', href, s}   autolink (href and text already escaped+encoded)
//   {k:'link', href, title, ch}   hyperlink; ch = child tokens
//   {k:'img', src, title, alt}    image; alt = plain-text alt string
//   {k:'d', ch, len, open, close} emphasis / strikethrough delimiter run
// ---------------------------------------------------------------------------

const WORD_CH = /[A-Za-z0-9_]/;
function isWordCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) || c === 95;
}

function punctBefore(s, i) {
  if (i <= 0) return false;
  let idx = i - 1;
  const c = s.charCodeAt(idx);
  if (c >= 0xdc00 && c <= 0xdfff && idx > 0) {
    const h = s.charCodeAt(idx - 1);
    if (h >= 0xd800 && h <= 0xdbff) {
      return PUNCT_RE.test(String.fromCodePoint(0x10000 + ((h - 0xd800) << 10) + (c - 0xdc00)));
    }
  }
  if (c < 128) return isAsciiPunct(c);
  return PUNCT_RE.test(s[idx]);
}

function spaceBefore(s, i) {
  if (i <= 0) return false;
  return isSpaceCode(s.charCodeAt(i - 1));
}

// Scan an inline HTML tag starting at s[i] ('<'). Returns the index just
// past the tag, or -1 when it is not a tag.
function scanHtmlTag(s, i) {
  const n = s.length;
  const c1 = i + 1 < n ? s.charCodeAt(i + 1) : -1;
  if (c1 === 33) { // !
    if (s.charCodeAt(i + 2) === 45 && s.charCodeAt(i + 3) === 45) { // <!--
      // Abruptly closed comments: <!--> and <!---> are complete.
      if (s.charCodeAt(i + 4) === 62) return i + 5;
      if (s.charCodeAt(i + 4) === 45 && s.charCodeAt(i + 5) === 62) return i + 6;
      const e = s.indexOf('-->', i + 4);
      return e === -1 ? -1 : e + 3;
    }
    if (s.startsWith('[CDATA[', i + 2)) {
      const e = s.indexOf(']]>', i + 9);
      return e === -1 ? -1 : e + 3;
    }
    const c2 = s.charCodeAt(i + 2);
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) {
      const e = s.indexOf('>', i + 3);
      return e === -1 ? -1 : e + 1;
    }
    return -1;
  }
  if (c1 === 63) { // <? ... ?>
    const e = s.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  let j = i + 1;
  const closing = s.charCodeAt(j) === 47;
  if (closing) j++; // '/'
  if (j >= n) return -1;
  const tc = s.charCodeAt(j);
  if (!((tc >= 65 && tc <= 90) || (tc >= 97 && tc <= 122))) return -1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  // After the tag name, only whitespace, '>', '/' or end-of-input may
  // follow — a ':' or other character directly attached (as in <m:abc>)
  // is not a valid tag.
  if (j < n) {
    const ac = s.charCodeAt(j);
    if (!(ac === 32 || ac === 9 || ac === 10 || ac === 13 ||
      ac === 62 || ac === 47)) return -1;
  }
  // A closing tag takes no attributes: </a href="x"> is not a tag.
  if (closing) {
    let k = j;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c === 13) k++;
      else break;
    }
    if (k < n && s.charCodeAt(k) !== 62) return -1;
    return k < n ? k + 1 : -1;
  }
  for (;;) {
    let k = j;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c === 13) k++;
      else break;
    }
    if (k >= n) return -1;
    const kc = s.charCodeAt(k);
    if (kc === 62) return k + 1; // >
    if (kc === 47 && k + 1 < n && s.charCodeAt(k + 1) === 62) return k + 2; // />
    // attribute name
    if (!((kc >= 65 && kc <= 90) || (kc >= 97 && kc <= 122) || kc === 95 || kc === 58)) return -1;
    let m = k + 1;
    while (m < n) {
      const c = s.charCodeAt(m);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) || c === 95 || c === 58 || c === 46 || c === 45) m++;
      else break;
    }
    let p = m;
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 32 || c === 9 || c === 10 || c === 13) p++;
      else break;
    }
    if (p < n && s.charCodeAt(p) === 61) { // =
      p++;
      while (p < n) {
        const c = s.charCodeAt(p);
        if (c === 32 || c === 9 || c === 10 || c === 13) p++;
        else break;
      }
      if (p >= n) return -1;
      const vc = s.charCodeAt(p);
      if (vc === 34) {
        const e = s.indexOf('"', p + 1);
        if (e === -1) return -1;
        p = e + 1;
      } else if (vc === 39) {
        const e = s.indexOf("'", p + 1);
        if (e === -1) return -1;
        p = e + 1;
      } else {
        let q = p;
        while (q < n) {
          const c = s.charCodeAt(q);
          if (c === 32 || c === 9 || c === 10 || c === 13 || c === 34 ||
            c === 39 || c === 61 || c === 60 || c === 62 || c === 96) break;
          q++;
        }
        if (q === p) return -1;
        p = q;
      }
      // After an attribute value, the next character must be whitespace,
      // '>' or '/' — another attribute name directly attached (as in
      // href='bar'title=title) is not a valid tag.
      if (p < n) {
        const nc = s.charCodeAt(p);
        if (!(nc === 32 || nc === 9 || nc === 10 || nc === 13 ||
          nc === 62 || nc === 47)) return -1;
      }
    }
    j = p;
  }
}

// Try an <...> autolink at s[i]. Returns {href, text, end} or null.
// href/text here are the raw strings (cleaning + escaping at render time).
function tryAngleAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}: (case-insensitive; 2-32 chars)
  if (j < n) {
    const c0 = s.charCodeAt(j);
    if ((c0 >= 97 && c0 <= 122) || (c0 >= 65 && c0 <= 90)) {
      let k = j + 1;
      while (k < n && k - j <= 31) {
        const c = s.charCodeAt(k);
        if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) ||
          (c >= 48 && c <= 57) ||
          c === 43 || c === 45 || c === 46) k++;
        else break;
      }
      if (k - j >= 2 && k < n && s.charCodeAt(k) === 58) {
        // rest: [^\s<>]* up to '>'
        let m = k + 1;
        while (m < n) {
          const c = s.charCodeAt(m);
          if (c === 62) {
            const inside = s.slice(i + 1, m);
            if (cleanUrl(inside) === null) return null;
            return { href: inside, text: inside, end: m + 1 };
          }
          if (c === 60 || isSpaceCode(c)) break;
          m++;
        }
      }
    }
  }
  // email: local@domain
  j = i + 1;
  const ls = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
      c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 ||
      c === 94 || c === 95 || c === 96 || c === 123 || c === 124 ||
      c === 125 || c === 126 || c === 45) j++;
    else break;
  }
  if (j === ls || j >= n || s.charCodeAt(j) !== 64) return null; // '@'
  j++;
  let labels = 0;
  for (;;) {
    if (j >= n) return null;
    const c = s.charCodeAt(j);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return null;
    let m = j + 1;
    while (m < n) {
      const cc = s.charCodeAt(m);
      if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) ||
        (cc >= 97 && cc <= 122) || cc === 45) m++;
      else break;
    }
    // label must end with an alphanumeric
    const last = s.charCodeAt(m - 1);
    if (!((last >= 48 && last <= 57) || (last >= 65 && last <= 90) || (last >= 97 && last <= 122))) return null;
    labels++;
    j = m;
    if (j < n && s.charCodeAt(j) === 46) { j++; continue; }
    break;
  }
  if (labels < 2 || j >= n || s.charCodeAt(j) !== 62) return null;
  const inside = s.slice(i + 1, j);
  if (cleanUrl('mailto:' + inside) === null) return null;
  return { href: 'mailto:' + inside, text: inside, end: j + 1 };
}

// ---------------------------------------------------------------------------
// Bare autolinks (GFM): www./scheme URLs, bare emails, mailto:/xmpp: links.
// Only active when not inside link text.
// ---------------------------------------------------------------------------

const BARE_EMAIL = /[\w.+-]+@(?:[\w-]+\.)+[\w-]*[A-Za-z0-9](?![\w-])/y;
const BARE_EMAIL_NOLOOK = /[\w.+-]+@(?:[\w-]+\.)+[\w-]*[A-Za-z0-9]/y;

const TRIM_PUNCT = new Set([33, 63, 46, 44, 58, 59, 42, 95, 126, 39, 34]); // ? ! . , : ; * _ ~ ' "

// Apply marked's trailing-trim rules to a matched bare URL. Returns the
// trimmed URL (possibly empty).
function trimBareUrl(url) {
  // Unmatched '(' truncation: the first '(' after the last ')' has no match.
  const lastClose = url.lastIndexOf(')');
  const firstOpen = url.indexOf('(', lastClose + 1);
  if (firstOpen !== -1) url = url.slice(0, firstOpen);
  for (;;) {
    if (url.length === 0) return url;
    const last = url.charCodeAt(url.length - 1);
    if (last === 41) { // )
      const lastOpen = url.lastIndexOf('(');
      if (lastOpen === -1) {
        url = url.replace(/\)+$/, '');
        continue;
      }
      let k = 0;
      for (let p = lastOpen + 1; p < url.length; p++) {
        if (url.charCodeAt(p) === 41) k++;
      }
      let trail = 0;
      for (let p = url.length - 1; p >= 0 && url.charCodeAt(p) === 41; p--) trail++;
      const strip = Math.min(k - 1, trail);
      if (strip <= 0) return url;
      url = url.slice(0, url.length - strip);
      continue;
    }
    if (last === 59) { // ;
      let p = url.length - 2;
      while (p >= 0 && isWordCode(url.charCodeAt(p))) p--;
      if (p >= 0 && url.charCodeAt(p) === 38 && p < url.length - 2) {
        url = url.slice(0, p); // remove the whole &word;
      } else {
        url = url.slice(0, -1); // remove just ';'
      }
      continue;
    }
    if (TRIM_PUNCT.has(last)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

// Try a bare autolink at s[i]. Returns {href, text, end} or null.
function tryBareAutolink(s, i, inUs) {
  const n = s.length;
  // www. / scheme URLs
  let prefixLen = 0;
  let scheme = false;
  const c0 = s.charCodeAt(i);
  if (c0 === 119 && s.startsWith('www.', i)) {
    prefixLen = 4;
  } else if (c0 === 104 || c0 === 72) { // h/H — compare char codes, no slice/toLowerCase alloc
    const c1 = s.charCodeAt(i + 1) | 32, c2 = s.charCodeAt(i + 2) | 32,
      c3 = s.charCodeAt(i + 3) | 32;
    if (c1 === 116 && c2 === 116 && c3 === 112 && s.charCodeAt(i + 4) === 58 &&
      s.charCodeAt(i + 5) === 47 && s.charCodeAt(i + 6) === 47) { prefixLen = 7; scheme = true; }
    else if (c1 === 116 && c2 === 116 && c3 === 112 && s.charCodeAt(i + 4) === 115 &&
      s.charCodeAt(i + 5) === 58 && s.charCodeAt(i + 6) === 47 && s.charCodeAt(i + 7) === 47) { prefixLen = 8; scheme = true; }
  } else if (c0 === 102 || c0 === 70) { // f/F — ftp://
    const c1 = s.charCodeAt(i + 1) | 32, c2 = s.charCodeAt(i + 2) | 32;
    if (c1 === 116 && c2 === 112 && s.charCodeAt(i + 3) === 58 &&
      s.charCodeAt(i + 4) === 47 && s.charCodeAt(i + 5) === 47) { prefixLen = 6; scheme = true; }
  }
  if (prefixLen > 0) {
    let j = i + prefixLen;
    const dstart = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) || c === 45) { j++; continue; }
      if (c === 46 && j + 1 < n) {
        const nc = s.charCodeAt(j + 1);
        if ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) ||
          (nc >= 97 && nc <= 122) || nc === 45) { j++; continue; }
      }
      break;
    }
    if (j === dstart) return null;
    // path: [^\s<]*
    let m = j;
    while (m < n) {
      const c = s.charCodeAt(m);
      if (c === 60 || isSpaceCode(c)) break;
      m++;
    }
    let url = trimBareUrl(s.slice(i, m));
    if (url.length === 0) return null;
    const href = scheme ? url : 'http://' + url;
    if (cleanUrl(href) === null) return null;
    return { href, text: url, end: i + url.length };
  }
  // mailto: / xmpp: + email
  if (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) {
    const isMailto = s.charCodeAt(i) === 109;
    const estart = i + (isMailto ? 7 : 5);
    BARE_EMAIL.lastIndex = estart;
    if (!BARE_EMAIL.test(s)) return null;
    const eend = BARE_EMAIL.lastIndex;
    let end = eend;
    if (!isMailto && end < n && s.charCodeAt(end) === 47) {
      // optional /path segment: /[\w@]+(?:\.[\w@]+)*
      let p = end + 1;
      const pstart = p;
      while (p < n && (isWordCode(s.charCodeAt(p)) || s.charCodeAt(p) === 64)) p++;
      if (p > pstart) {
        for (;;) {
          if (p < n && s.charCodeAt(p) === 46 && p + 1 < n &&
            (isWordCode(s.charCodeAt(p + 1)) || s.charCodeAt(p + 1) === 64)) {
            p++;
            while (p < n && (isWordCode(s.charCodeAt(p)) || s.charCodeAt(p) === 64)) p++;
          } else break;
        }
        end = p;
      }
    }
    const whole = s.slice(i, end);
    if (cleanUrl(whole) === null) return null;
    return { href: whole, text: whole, end };
  }
  // bare email
  // Word-start gate: a bare email starting mid-word (previous char a
  // local-part char: word char / . / + / -) is a suffix of the email
  // starting at the word start — that check already ran and either
  // matched (we jumped past it) or failed (same `@` and domain, so this
  // fails too). Skip the regex unless this is a local-part start.
  let email = null, eend = -1;
  const pc = i === 0 ? -1 : s.charCodeAt(i - 1);
  const atStart = i === 0 || !(isWordCode(pc) || pc === 46 || pc === 43 || pc === 45);
  if (atStart) {
    BARE_EMAIL.lastIndex = i;
    if (BARE_EMAIL.test(s)) {
      email = s.slice(i, BARE_EMAIL.lastIndex);
      eend = BARE_EMAIL.lastIndex;
    }
  }
  // Inside __...__, a closing __ right after the address must not truncate
  // it: marked links the whole address there, while the same address
  // followed by __ with no open __ links only up to the previous label
  // (or not at all). inUs tracks an unmatched __ opener in this inline text.
  if (inUs && atStart) {
    BARE_EMAIL_NOLOOK.lastIndex = i;
    if (BARE_EMAIL_NOLOOK.test(s) && BARE_EMAIL_NOLOOK.lastIndex > eend) {
      const nlEnd = BARE_EMAIL_NOLOOK.lastIndex;
      if (nlEnd < n && s.charCodeAt(nlEnd) === 95) {
        email = s.slice(i, nlEnd);
        eend = nlEnd;
      }
    }
  }
  if (email !== null) {
    if (cleanUrl('mailto:' + email) === null) return null;
    return { href: 'mailto:' + email, text: email, end: eend };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Links and images.
// ---------------------------------------------------------------------------

// Parse the (dest title) part of an inline link, starting at s[j] ('(').
// Returns {dest, title, end} (end = index just past ')') or null.
// Does the string contain a blank line (a line that is empty or only
// spaces/tabs, between two newlines)?
function hasBlankLine(str) {
  let i = 0;
  const n = str.length;
  for (;;) {
    const nl = str.indexOf('\n', i);
    if (nl === -1) return false;
    let j = nl + 1;
    while (j < n && (str.charCodeAt(j) === 32 || str.charCodeAt(j) === 9)) j++;
    if (j < n && str.charCodeAt(j) === 10) return true;
    i = j;
  }
}

function parseLinkParen(s, j) {
  const n = s.length;
  j++; // past '('
  while (j < n && isLinkWs(s.charCodeAt(j))) j++;
  if (j >= n) return null;
  let dest;
  if (s.charCodeAt(j) === 60) { // <...> angle destination (no newline inside)
    // Scan for the closing '>', skipping backslash escapes: `\>` is an
    // escaped '>' and does not close the destination.
    let gt = -1;
    for (let k = j + 1; k < n; k++) {
      const c = s.charCodeAt(k);
      if (c === 92) { k++; continue; }
      if (c === 62) { gt = k; break; }
      if (c === 10) break;
    }
    if (gt === -1) return null;
    // Backslash escapes in the destination are unescaped.
    dest = '';
    for (let k = j + 1; k < gt; k++) {
      if (s.charCodeAt(k) === 92 && k + 1 < gt && isAsciiPunct(s.charCodeAt(k + 1))) {
        dest += s[k + 1];
        k++;
      } else {
        dest += s[k];
      }
    }
    j = gt + 1;
  } else {
    let depth = 0;
    let k = j;
    let d = '';
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 92 && k + 1 < n && isAsciiPunct(s.charCodeAt(k + 1))) {
        d += s[k + 1];
        k += 2;
        continue;
      }
      if (c === 40) { depth++; d += '('; k++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--; d += ')'; k++; continue;
      }
      if (isLinkWs(c)) break;
      d += s[k];
      k++;
    }
    dest = d;
    j = k;
  }
  const afterDest = j;
  while (j < n && isLinkWs(s.charCodeAt(j))) j++;
  if (j >= n) return null;
  let title = null;
  if (s.charCodeAt(j) === 41) { // ')' — no title
    return { dest, title: null, end: j + 1 };
  }
  // A title must be separated from the destination by whitespace.
  if (j === afterDest) return null;
  const qc = s.charCodeAt(j);
  if (qc === 34 || qc === 39) { // "title" or 'title'
    let k = j + 1;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 92) { k += 2; continue; }
      if (c === qc) break;
      k++;
    }
    if (k >= n) return null;
    if (hasBlankLine(s.slice(j + 1, k))) return null;
    title = unescapeTitle(s.slice(j + 1, k));
    j = k + 1;
  } else if (qc === 40) { // (title) — up to the first ')'
    let k = j + 1;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 92) { k += 2; continue; }
      if (c === 41) break;
      k++;
    }
    if (k >= n) return null;
    if (hasBlankLine(s.slice(j + 1, k))) return null;
    title = unescapeTitle(s.slice(j + 1, k));
    j = k + 1;
  } else {
    return null;
  }
  while (j < n && isLinkWs(s.charCodeAt(j))) j++;
  if (j >= n || s.charCodeAt(j) !== 41) return null;
  return { dest, title, end: j + 1 };
}

// Process backslash escapes inside a link title.
function unescapeTitle(t) {
  if (t.indexOf('\\') === -1) return t;
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 92 && i + 1 < t.length && isAsciiPunct(t.charCodeAt(i + 1))) {
      out += t[i + 1];
      i++;
    } else {
      out += t[i];
    }
  }
  return out;
}

// Does a flat token list contain a top-level bracket link token?
function hasBracketLink(toks) {
  for (const t of toks) {
    if (t.k === 'link') return true;
  }
  return false;
}

// Try to parse a link (or image, when isImage) whose '[' is at s[bracket].
// Returns null, or {end, token, textOnly} where token is the link/img token
// to push (null when the destination is unusable and only the text renders).
function tryLink(s, bracket, isImage, refs, inLink) {
  const close = findClosingBracket(s, bracket, 91, 93);
  if (close === -1) return null;
  const text = s.slice(bracket + 1, close);
  let dest = null;
  let title = null;
  let end = -1;
  let after = close + 1;
  if (s.charCodeAt(after) === 40) { // (
    const p = parseLinkParen(s, after);
    if (p) {
      dest = p.dest;
      title = p.title;
      end = p.end;
    } else {
      // Inline link failed: fall back to the shortcut reference [text].
      const slabel = normalizeLabel(text);
      if (slabel.length === 0) return null;
      const ref = refs.get(slabel);
      if (!ref) return null;
      dest = ref.href;
      title = ref.title;
      end = close + 1;
    }
  } else if (s.charCodeAt(after) === 91) { // [label]
    const lclose = findClosingBracket(s, after, 91, 93);
    if (lclose === -1) return null;
    const rawLabel = s.slice(after + 1, lclose);
    const label = normalizeLabel(rawLabel);
    let ref = null;
    if (label.length > 0) {
      ref = refs.get(label);
      // A full reference whose label is not defined is not a link, and
      // does not fall back to the shortcut reference.
      if (!ref) return null;
    } else {
      // Collapsed reference [text][]: the label is the text.
      const slabel = normalizeLabel(text);
      if (slabel.length > 0) ref = refs.get(slabel);
      if (!ref) return null;
    }
    dest = ref.href;
    title = ref.title;
    end = lclose + 1;
  } else {
    const slabel = normalizeLabel(text);
    if (slabel.length === 0) return null;
    const ref = refs.get(slabel);
    if (!ref) return null;
    dest = ref.href;
    title = ref.title;
    end = close + 1;
  }
  const href = cleanUrl(dest);
  if (href === null) {
    // Destination unusable (e.g. lone surrogate): the link drops, but its
    // text still renders, consuming the whole [...](...) span.
    const ch = tokenize(text, refs, inLink);
    return { end, token: null, textOnly: ch };
  }
  if (isImage) {
    const at = tokenize(text, refs, false, false);
    const alt = altText(at.hasDelim ? processEmphasis(at) : at);
    return { end, token: { k: 'img', src: href, title, alt }, textOnly: null };
  }
  if (inLink) return null;
  // A link whose text contains a bracket link does not form.
  const chk = tokenize(text, refs, false, false);
  if (hasBracketLink(chk)) return null;
  const lt = tokenize(text, refs, true);
  const ch = lt.hasDelim ? processEmphasis(lt) : lt;
  return { end, token: { k: 'link', href, title, ch }, textOnly: null };
}

// Plain-text form of inline tokens, for image alt attributes.
function altText(toks) {
  let out = '';
  for (const t of toks) {
    if (t.k === 't' || t.k === 'code') out += t.s;
    else if (t.k === 'auto') out += t.text;
    else if (t.k === 'link' || t.k === 'em' || t.k === 'strong' || t.k === 'del') out += altText(t.ch);
    else if (t.k === 'img') out += t.alt;
    else if (t.k === 'br') out += '\n';
    else if (t.k === 'soft') out += '\n';
    else if (t.k === 'html') out += t.s;
    else if (t.k === 'd') out += t.ch.repeat(t.len);
  }
  return escapeHtml(out, false);
}

// The main inline scanner. Returns raw tokens (delimiters not yet resolved).
// Track an open inline <a> link-opener: while one is open, bare
// autolinks (URL / email) do not fire. A boolean, not a stack: any
// inline </a> clears it, even if it closes a different <a>. An <a>
// counts as a link-opener iff it is `<a` + exactly one space + a
// non-space char (a tab, a second space, or no space do not count).
// Only real (rendered) tokenization updates it; HTML blocks never
// reach here.
function noteLinkTag(refs, s, i, end) {
  if (!refs) return;
  // Closing tag?
  if (s.charCodeAt(i + 1) === 47) {
    let j = i + 2;
    let name = '';
    while (j < end && /[a-zA-Z]/.test(s[j])) { name += s[j]; j++; }
    if (name.toLowerCase() === 'a') refs.noBare = false;
    return;
  }
  let j = i + 1;
  let name = '';
  while (j < end && /[a-zA-Z]/.test(s[j])) { name += s[j]; j++; }
  if (name.toLowerCase() !== 'a') return;
  // Any inline <a> followed by one or more literal spaces suppresses bare
  // autolinks (even <a  />, <a  >, <a  href>); <a> with no space, and
  // <a\t / <a\n (tab/newline), do not.
  if (s.charCodeAt(j) === 32) refs.noBare = true;
}

function tokenize(s, refs, inLink, track) {
  const n = s.length;
  const out = [];
  out.hasDelim = false; // set when a `d` delimiter token is pushed
  let i = 0;
  let start = 0;
  let openUs = 0; // unmatched __ openers (for bare-email __ handling)
  // Delimiters that cannot close: inside a masked code span (mechanism 1)
  // or inside the text of a failed inline link with a length-mismatched
  // code span (mechanism 2). Openers are unaffected.
  const mask = s.indexOf('`') === -1 ? [] : codeSpanMask(s);
  const noClose = [];
  const closeBlocked = (pos) => {
    for (let q = 0; q < mask.length; q++) {
      if (pos >= mask[q][0] && pos < mask[q][1]) return true;
    }
    for (let q = 0; q < noClose.length; q++) {
      if (pos >= noClose[q][0] && pos < noClose[q][1]) return true;
    }
    return false;
  };
  const flush = (to) => {
    if (to > start) out.push({ k: 't', s: s.slice(start, to) });
  };
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < n) {
        const nc = s.charCodeAt(i + 1);
        if (nc === 10) {
          flush(i);
          out.push({ k: 'br', s: '' });
          i += 2;
          // After a hard break, leading spaces/tabs of the next line
          // are stripped.
          while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
          start = i;
          continue;
        }
        if (isAsciiPunct(nc)) {
          flush(i);
          out.push({ k: 't', s: s[i + 1] });
          i += 2; start = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 96) { // backtick run -> code span
      let j = i;
      while (j < n && s.charCodeAt(j) === 96) j++;
      const len = j - i;
      let k = j;
      let found = -1;
      while (k < n) {
        const idx = s.indexOf('`', k);
        if (idx === -1) break;
        let m = idx;
        while (m < n && s.charCodeAt(m) === 96) m++;
        if (m - idx === len) { found = idx; break; }
        k = m;
      }
      if (found === -1) { i = j; continue; }
      let content = s.slice(j, found);
      // Line endings become spaces first; then strip one leading and
      // one trailing space when the content begins and ends with a space
      // and is not all spaces.
      if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 &&
        content.charCodeAt(content.length - 1) === 32 &&
        !/^[ ]+$/.test(content)) {
        content = content.slice(1, -1);
      }
      flush(i);
      out.push({ k: 'code', s: content });
      i = found + len; start = i;
      continue;
    }
    if (c === 42 || c === 95) { // * _
      let j = i;
      while (j < n && s.charCodeAt(j) === c) j++;
      const len = j - i;
      // The beginning and end of the line count as whitespace.
      const afterWs = j >= n ? true : isSpaceAt(s, j);
      const afterPunct = j >= n ? false : isPunctAt(s, j);
      const beforeWs = i === 0 ? true : spaceBefore(s, i);
      const beforePunct = i === 0 ? false : punctBefore(s, i);
      const leftFlank = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlank = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen, canClose;
      if (c === 42) { canOpen = leftFlank; canClose = rightFlank; }
      else {
        canOpen = leftFlank && (!rightFlank || beforePunct);
        canClose = rightFlank && (!leftFlank || afterPunct);
      }
      if (canClose && closeBlocked(i)) canClose = false;
      flush(i);
      out.push({ k: 'd', ch: c === 42 ? '*' : '_', len, open: canOpen, close: canClose, blocked: false });
      out.hasDelim = true;
      if (c === 95) {
        if (canOpen && !canClose) openUs++;
        else if (canClose && !canOpen) openUs = openUs > 0 ? openUs - 1 : 0;
      }
      i = j; start = i;
      continue;
    }
    if (c === 126) { // ~ (strikethrough delimiter, runs of 1-2 only)
      let j = i;
      while (j < n && s.charCodeAt(j) === 126) j++;
      const len = j - i;
      if (len >= 3) { i = j; continue; }
      flush(i);
      const tClose = (i === 0 ? false : !spaceBefore(s, i)) && !closeBlocked(i);
      out.push({ k: 'd', ch: '~', len, open: j >= n ? false : !isSpaceAt(s, j), close: tClose, blocked: false });
      out.hasDelim = true;
      i = j; start = i;
      continue;
    }
    if (c === 38) { // & numeric entity
      const num = numericEntityAt(s, i);
      if (num) {
        flush(i);
        out.push({ k: 't', s: num[0] });
        i += num[1]; start = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 60) { // < autolink or raw HTML
      const auto = tryAngleAutolink(s, i);
      if (auto) {
        flush(i);
        out.push({ k: 'auto', href: auto.href, text: auto.text });
        i = auto.end; start = i;
        continue;
      }
      const tagEnd = scanHtmlTag(s, i);
      if (tagEnd !== -1) {
        flush(i);
        out.push({ k: 'html', s: s.slice(i, tagEnd) });
        if (track !== false) noteLinkTag(refs, s, i, tagEnd);
        i = tagEnd; start = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 33 && i + 1 < n && s.charCodeAt(i + 1) === 91) { // ![
      const r = tryLink(s, i + 1, true, refs, inLink);
      if (r) {
        flush(i);
        if (r.token) out.push(r.token);
        else if (r.textOnly) for (const t of r.textOnly) out.push(t);
        i = r.end; start = i;
        continue;
      }
      const nc = failedLinkNoClose(s, i + 1);
      if (nc) noClose.push(nc);
      i++;
      continue;
    }
    if (c === 91) { // [
      const r = tryLink(s, i, false, refs, inLink);
      if (r) {
        flush(i);
        if (r.token) out.push(r.token);
        else if (r.textOnly) for (const t of r.textOnly) out.push(t);
        i = r.end; start = i;
        continue;
      }
      const nc = failedLinkNoClose(s, i);
      if (nc) noClose.push(nc);
      i++;
      continue;
    }
    if (c === 10) { // newline: hard break when 2+ spaces precede it
      let sp = 0;
      let j = i - 1;
      while (j >= start && s.charCodeAt(j) === 32) { sp++; j--; }
      if (sp >= 2) {
        flush(i - sp);
        out.push({ k: 'br', s: '' });
        i++;
        // After a hard break, leading spaces/tabs of the next line
        // are stripped (after a soft break they are kept).
        while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
        start = i;
      } else {
        flush(i);
        out.push({ k: 'soft', s: '' });
        i++; start = i;
      }
      continue;
    }
    if (!inLink && !(refs && refs.noBare) && (isWordCode(c) || c === 46 || c === 43 || c === 45)) {
      // Only attempt an autolink where one can start: a scheme letter
      // (h/f — http/https/ftp link even mid-word, e.g. `xhttp://...`)
      // or a word start (for `www.`, bare email, and mailto:/xmpp:,
      // which all need a boundary — `xmailto:a@b.com` links only the
      // email, not the scheme). A mid-word letter that is not a scheme
      // letter can start neither.
      const cLow = c | 32;
      let tryAuto = cLow === 104 || cLow === 102;
      if (!tryAuto) {
        const pc = i === 0 ? -1 : s.charCodeAt(i - 1);
        tryAuto = i === 0 || !(isWordCode(pc) || pc === 46 || pc === 43 || pc === 45);
      }
      if (tryAuto) {
        const auto = tryBareAutolink(s, i, openUs > 0);
        if (auto) {
          flush(i);
          out.push({ k: 'auto', href: auto.href, text: auto.text });
          i = auto.end; start = i;
          continue;
        }
      }
    }
    i++;
  }
  flush(n);
  return out;
}

// ---------------------------------------------------------------------------
// Emphasis / strikethrough resolution (CommonMark Appendix A delimiter stack)
// ---------------------------------------------------------------------------

// Closers are tried in order from the start of the token list. For each
// closer, the nearest matching opener below it is used; if the closer still
// has length left it is retried, otherwise we move on. A closer with no
// opener is skipped once and never revisited.

function processEmphasis(toks) {
  const skipped = new Set();
  for (;;) {
    let closerIdx = -1;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.k === 'd' && t.close && !skipped.has(t)) { closerIdx = i; break; }
    }
    if (closerIdx === -1) return toks;
    const closer = toks[closerIdx];
    let openerIdx = -1;
    for (let i = closerIdx - 1; i >= 0; i--) {
      const t = toks[i];
      if (t.k !== 'd') continue;
      if (t.ch !== closer.ch) continue;
      // A delimiter blocked by the blocking rule poisons the region: a
      // closer of the SAME length that would have matched it must not fall
      // through to an earlier opener (it stays literal instead). A closer
      // of a different length (e.g. a len-2 strong closer) may still pass
      // it to reach its own opener.
      if (t.blocked && t.len === closer.len) { openerIdx = -2; break; }
      if (!t.open) continue;
      if (closer.ch === '~' && t.len !== closer.len) continue;
      const oddMatch = (t.open && t.close) || (closer.open && closer.close);
      if (oddMatch && (t.len + closer.len) % 3 === 0 &&
        (t.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
      // Strong preference: a len-1 closer must not consume a len-2 opener
      // when a later len>=2 closer of the same char could form a strong
      // with it (e.g. `**a *b* c**` outer strong wins over an inner em).
      // Only when the opener has exactly len 2: a len>=3 opener keeps
      // enough length for the strong after giving 1 to the em (cm-430).
      if (closer.len === 1 && t.len === 2) {
        let laterStrong = false;
        for (let k = closerIdx + 1; k < toks.length; k++) {
          const tk = toks[k];
          if (tk.k === 'd' && tk.ch === closer.ch && tk.close && tk.len >= 2) {
            laterStrong = true;
            break;
          }
        }
        if (laterStrong) continue;
      }
      openerIdx = i;
      break;
    }
    if (openerIdx === -1 || openerIdx === -2) {
      skipped.add(closer);
      continue;
    }
    const opener = toks[openerIdx];
    let use;
    let kind;
    if (closer.ch === '~') { use = opener.len; kind = 'del'; }
    else if (opener.len >= 2 && closer.len >= 2) { use = 2; kind = 'strong'; }
    else { use = 1; kind = 'em'; }
    // Blocking rule (marked quirk): when a STRONG is formed from an
    // opener that can only open and a closer that can also open, and the
    // sum of the inner opener's length and the nearest enclosing opener's
    // length is a multiple of 3, the enclosing opener is blocked from
    // matching a later closer (the outer emphasis does not form).
    // Only for inner strong (len >= 2): an inner em does not block the
    // outer strong (e.g. `**a *b* c**` forms the strong).
    // Only when the closer is fully consumed by the strong (len 2): a
    // len>=3 closer leaves a star that forms the outer em (e.g.
    // `*a **b (x)***. rest` forms both strong and em).
    if (closer.ch !== '~' && opener.len >= 2 && !opener.close && closer.open && closer.len === 2) {
      for (let j = openerIdx - 1; j >= 0; j--) {
        const t2 = toks[j];
        if (t2.k !== 'd') continue;
        if (t2.ch === closer.ch && t2.open) {
          if ((opener.len + t2.len) % 3 === 0) { t2.open = false; t2.blocked = true; }
          break;
        }
      }
    }
    const node = { k: kind, ch: toks.slice(openerIdx + 1, closerIdx), dc: closer.ch };
    opener.len -= use;
    closer.len -= use;
    const replacement = [];
    if (opener.len > 0) replacement.push(opener);
    replacement.push(node);
    if (closer.len > 0) {
      // Leftover closer delimiters normally go outside the element, but
      // when the strong contains an inner `*` em whose closer was
      // followed by non-space text (an "odd" closer, e.g. `**a *b*c***`),
      // marked puts the leftover inside the strong instead
      // (`<strong>a <em>b</em>c*</strong>`, not `...</strong>*`).
      let inside = false;
      if (kind === 'strong' && closer.ch === '*') {
        for (let j = 0; j < node.ch.length; j++) {
          const ct = node.ch[j];
          if (ct.k === 'em' && ct.dc === '*') {
            const nx = node.ch[j + 1];
            if (nx && nx.k === 't' && nx.s.length > 0 && !/\s/.test(nx.s[0])) {
              inside = true;
              break;
            }
          }
        }
      }
      if (inside) node.ch.push({ k: 't', s: closer.ch.repeat(closer.len) });
      else replacement.push(closer);
    }
    toks.splice(openerIdx, closerIdx - openerIdx + 1, ...replacement);
  }
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

function renderInline(toks) {
  const parts = [];
  for (const t of toks) {
    switch (t.k) {
      case 't':
        parts.push(escapeHtml(t.s, false));
        break;
      case 'code':
        parts.push('<code>', escapeCode(t.s), '</code>');
        break;
      case 'br':
        parts.push('<br>');
        break;
      case 'soft':
        parts.push('\n');
        break;
      case 'html':
        parts.push(t.s);
        break;
      case 'auto': {
        const href = escapeHtml(cleanUrl(t.href), true);
        parts.push('<a href="', href, '">', escapeHtml(t.text, true), '</a>');
        break;
      }
      case 'link':
        parts.push('<a href="', escapeHtml(t.href, false), '"',
          (t.title !== null && t.title !== undefined
            ? ' title="' + escapeHtml(t.title, false) + '"'
            : ''),
          '>', renderInline(t.ch), '</a>');
        break;
      case 'img':
        parts.push('<img src="', escapeHtml(t.src, false), '" alt="', t.alt, '"',
          (t.title !== null && t.title !== undefined
            ? ' title="' + escapeHtml(t.title, false) + '"'
            : ''), '>');
        break;
      case 'em':
        parts.push('<em>', renderInline(t.ch), '</em>');
        break;
      case 'strong':
        parts.push('<strong>', renderInline(t.ch), '</strong>');
        break;
      case 'del':
        parts.push('<del>', renderInline(t.ch), '</del>');
        break;
      case 'd':
        parts.push(escapeHtml(t.ch.repeat(t.len), false));
        break;
    }
  }
  return parts.join('');
}

// Single-char triggers for the parseInline fast path: any of these means
// the text may contain an inline construct (emphasis, code span, link,
// image, autolink, HTML, escape, strikethrough, email).
const INLINE_FAST = /[*_`[\]\\!<>~@&]/;

function parseInline(s, refs, inLink) {
  // Fast path: plain text with no inline constructs. When the text has
  // no emphasis/code/link/autolink/escape/entity trigger, no autolink
  // prefix, and no space-or-tab before a soft break, the inline result
  // is just the escaped text — no tokenization, no emphasis pass, no
  // rendering. (`&` is a trigger because tokenize decodes entities,
  // which escapeHtml alone does not.)
  if (!inLink && !INLINE_FAST.test(s) && s.indexOf('www.') === -1 &&
      s.indexOf('://') === -1 && s.indexOf('mailto:') === -1 &&
      s.indexOf('xmpp:') === -1 && s.indexOf(' \n') === -1 &&
      s.indexOf('\t\n') === -1) {
    return escapeHtml(s, false);
  }
  const toks = tokenize(s, refs, !!inLink);
  return renderInline(toks.hasDelim ? processEmphasis(toks) : toks);
}

// ===========================================================================
// Block parser (CommonMark phase 1)
// ===========================================================================

// A line cursor: s = line text, i = index, col = column, part = remaining
// virtual spaces from a partially consumed tab.
function makeLine(s) {
  return { s, i: 0, col: 0, part: 0 };
}
function lch(ln) {
  if (ln.part > 0) return 32;
  return ln.i < ln.s.length ? ln.s.charCodeAt(ln.i) : -1;
}
// Advance one column.
function ladv(ln) {
  if (ln.part > 0) {
    ln.part--;
    ln.col++;
    if (ln.part === 0) ln.i++;
    return;
  }
  const c = ln.s.charCodeAt(ln.i);
  if (c === 9) ln.col += 4 - (ln.col % 4);
  else ln.col++;
  ln.i++;
}
// Advance past up to `cols` columns of spaces/tabs. Returns columns advanced.
function lskipSpaces(ln, cols) {
  let n = 0;
  while (n < cols) {
    const c = lch(ln);
    if (c === 32) { ladv(ln); n++; }
    else if (c === 9) {
      const w = 4 - (ln.col % 4);
      if (n + w <= cols) { ladv(ln); n += w; }
      else {
        ln.part = w - (cols - n);
        ln.col += cols - n;
        n = cols;
      }
    } else break;
  }
  return n;
}
// Advance past up to `n` leading whitespace characters (spaces/tabs),
// counting each character as 1 regardless of column width. Marked
// removes fenced-code fence indent this way: a tab in the indent is
// removed whole even when it spans more columns than remain.
function lskipWsChars(ln, n) {
  let k = 0;
  while (k < n) {
    const c = lch(ln);
    if (c !== 32 && c !== 9) break;
    ladv(ln);
    k++;
  }
  return k;
}
// How many columns of spaces/tabs lie ahead (without consuming)?
function peekSpaces(ln) {
  let col = ln.col;
  let i = ln.i;
  let part = ln.part;
  for (;;) {
    if (part > 0) {
      col++; part--;
      if (part === 0) i++;
      continue;
    }
    if (i >= ln.s.length) break;
    const c = ln.s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col - ln.col, atEnd: i >= ln.s.length };
}
// The rest of the line from the cursor, with remaining virtual spaces
// expanded to real spaces.
function restOfLine(ln) {
  if (ln.part > 0) return ' '.repeat(ln.part) + ln.s.slice(ln.i + 1);
  return ln.s.slice(ln.i);
}
// Columns of leading whitespace in s (a tab advances to a multiple of 4).
function indentCols(s) {
  let col = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return col;
}

// Remove up to `cols` columns of leading whitespace from s. A partially
// consumed tab leaves its remaining width as spaces.
function stripIndentCols(s, cols) {
  let i = 0;
  let col = 0;
  while (i < s.length && col < cols) {
    const c = s.charCodeAt(i);
    if (c === 32) { i++; col++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= cols) { i++; col += w; }
      else return ' '.repeat(col + w - cols) + s.slice(i + 1);
    } else break;
  }
  return s.slice(i);
}

// Content of a leaf line: like restOfLine, but tabs in the leading
// whitespace run are expanded to spaces (by column) when the line was
// container-stripped (cursor not at the raw line start). A plain line
// keeps its tabs verbatim.
function contentOf(ln) {
  return contentOfCol(ln, ln.col);
}
function contentOfCol(ln, baseCol) {
  const s = restOfLine(ln);
  if (ln.i === 0 && ln.col === 0 && ln.part === 0) return s;
  let i = 0;
  let hasTab = false;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) i++;
    else if (c === 9) { hasTab = true; i++; }
    else break;
  }
  if (!hasTab) return s;
  let col = baseCol;
  let out = '';
  for (let k = 0; k < i; k++) {
    if (s.charCodeAt(k) === 9) {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else { out += ' '; col++; }
  }
  return out + s.slice(i);
}
// Is the rest of the line blank (only spaces/tabs)?
function isBlankFrom(ln) {
  const p = peekSpaces(ln);
  return p.atEnd;
}
// Number of columns of leading whitespace at the cursor (consuming it).
function measureIndent(ln) {
  const p = peekSpaces(ln);
  lskipSpaces(ln, p.cols);
  return p.cols;
}

// Match a blockquote marker at the cursor: up to 3 spaces, '>', one optional
// space. Returns true and advances the cursor, or false.
// Match a blockquote marker. `baseCol` (optional) is the column origin
// for tab-width computation: the content indent of the innermost
// enclosing list item. A tab after `>` expands from the
// container-relative column, not the raw line column, so the separator
// space consumes 1 column of that width (e.g. `- a` + `  >\tindented`
// leaves 2 spaces, not 0).
function matchQuote(ln, baseCol) {
  const save = { i: ln.i, col: ln.col, part: ln.part };
  let n = 0;
  while (n < 3 && lch(ln) === 32) { ladv(ln); n++; }
  if (lch(ln) !== 62) {
    ln.i = save.i; ln.col = save.col; ln.part = save.part;
    return false;
  }
  ladv(ln);
  const c = lch(ln);
  if (c === 32) lskipSpaces(ln, 1);
  else if (c === 9) {
    const relCol = ln.col - (baseCol || 0);
    const w = 4 - (relCol % 4);
    if (w > 1) {
      ln.part = w - 1;
      ln.col += 1;
    } else {
      ladv(ln);
    }
  }
  return true;
}

// Match a list item continuation: blank line, or indent >= the item's
// content indent (relative to its parent container's content start).
// The cursor is at the parent's content start when called, so the
// relative indent is the number of columns to skip.
function matchItem(ln, item) {
  if (isBlankFrom(ln)) return true;
  const save = { i: ln.i, col: ln.col, part: ln.part };
  const need = item.relContentIndent !== undefined
    ? item.relContentIndent
    : item.contentIndent - ln.col;
  if (need <= 0) return true;
  if (lskipSpaces(ln, need) >= need) return true;
  ln.i = save.i; ln.col = save.col; ln.part = save.part;
  return false;
}

// Parse a list marker at the cursor (indent already stripped to <= 3
// spaces). Returns null, or {ordered, bullet, delim, start, empty} and
// leaves the cursor at the item content start (or at the line end for an
// empty item). `contentIndent` is the absolute column where content starts.
function parseListMarker(ln) {
  const startCol = ln.col;
  const c = lch(ln);
  let ordered = false;
  let bullet = 0;
  let delim = '';
  let num = 0;
  if (c === 45 || c === 43 || c === 42) { // - + *
    bullet = c;
    ladv(ln);
  } else if (c >= 48 && c <= 57) {
    let v = 0;
    let ndig = 0;
    while (ndig < 9) {
      const d = lch(ln);
      if (d >= 48 && d <= 57) { v = v * 10 + (d - 48); ndig++; ladv(ln); }
      else break;
    }
    if (ndig === 0) return null;
    const dc = lch(ln);
    if (dc !== 46 && dc !== 41) return null; // . or )
    delim = dc === 46 ? '.' : ')';
    num = v;
    ordered = true;
    ladv(ln);
  } else {
    return null;
  }
  // The marker must be followed by space/tab or end of line.
  const nc = lch(ln);
  if (nc !== -1 && nc !== 32 && nc !== 9) return null;
  const markerCol = ln.col;
  const sp = peekSpaces(ln);
  if (sp.atEnd) {
    return { ordered, bullet, delim, start: num, empty: true, contentIndent: markerCol + 1 };
  }
  if (sp.cols >= 1 && sp.cols <= 4) {
    lskipSpaces(ln, sp.cols);
    return { ordered, bullet, delim, start: num, empty: false, contentIndent: ln.col };
  }
  // 5+ spaces: content indent is marker + 1, the rest is content.
  lskipSpaces(ln, 1);
  return { ordered, bullet, delim, start: num, empty: false, contentIndent: ln.col };
}

// ATX heading: #{1,6} + space/tab/EOL, content up to an optional closing
// sequence. Returns {level, text} or null. Consumes the line.
function parseAtx(ln) {
  let n = 0;
  while (n < 6 && lch(ln) === 35) { ladv(ln); n++; }
  if (n === 0) return null;
  const c = lch(ln);
  if (c !== -1 && c !== 32 && c !== 9) return null;
  let text = restOfLine(ln);
  // Strip trailing spaces, then an optional closing sequence (a run of #
  // preceded by a space, or the whole content), then leading spaces.
  text = text.replace(/[ \t]+$/, '');
  const m = text.match(/^(.*?)[ \t]+#+$/);
  if (m) text = m[1];
  else if (/^#+$/.test(text)) text = '';
  text = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level: n, text };
}

// Fenced code start: ``` or ~~~ (3+). Returns {fence, len, info} or null.
function parseFence(ln) {
  const c = lch(ln);
  if (c !== 96 && c !== 126) return null;
  let n = 0;
  while (lch(ln) === c) { ladv(ln); n++; }
  if (n < 3) return null;
  let info = restOfLine(ln);
  if (c === 96 && info.indexOf('`') !== -1) return null;
  info = info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // Info is the first word only; backslash escapes are processed.
  const sp = info.search(/[ \t]/);
  if (sp !== -1) info = info.slice(0, sp);
  info = unescapeTitle(info);
  return { fence: c, len: n, info };
}

// Is this line a closing fence for the given fence char/length?
function isClosingFence(ln, fence, len) {
  let n = 0;
  while (lch(ln) === fence) { ladv(ln); n++; }
  if (n < len) return false;
  return isBlankFrom(ln);
}

// HTML block start types (CommonMark 4.6), checked in order.
// Returns the type (1-7) or 0.
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

function htmlBlockStart(ln) {
  if (lch(ln) !== 60) return 0; // <
  const s = ln.s;
  const i = ln.i;
  const n = s.length;
  if (s.startsWith('<!--', i)) return 2;
  if (s.startsWith('<?', i)) return 3;
  if (s.startsWith('<![CDATA[', i)) return 5;
  if (i + 1 < n && s.charCodeAt(i + 1) === 33) {
    const c2 = i + 2 < n ? s.charCodeAt(i + 2) : -1;
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) return 4;
    return 0;
  }
  // Type 1: <pre, <script, <style, <textarea followed by space/tab/EOL/>/>
  const low = s.slice(i + 1, i + 11).toLowerCase();
  for (const name of ['script', 'textarea', 'style', 'pre']) {
    if (low.startsWith(name)) {
      const after = s.charCodeAt(i + 1 + name.length);
      if (after === 32 || after === 9 || after === 62 || after === 47 ||
        after === -1 || Number.isNaN(after)) return 1;
      break;
    }
  }
  // Type 6: <tag or </tag where tag is a block tag, followed by
  // space/tab/EOL/>/> ; type 7: a complete tag alone on the line.
  let j = i + 1;
  if (j < n && s.charCodeAt(j) === 47) j++; // '/'
  if (j >= n) return 0;
  const tc = s.charCodeAt(j);
  if (!((tc >= 65 && tc <= 90) || (tc >= 97 && tc <= 122))) return 0;
  let k = j;
  while (k < n) {
    const c = s.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) || c === 45) k++;
    else break;
  }
  const name = s.slice(j, k).toLowerCase();
  const after = k < n ? s.charCodeAt(k) : -1;
  if (BLOCK_TAGS.has(name) &&
    (after === 32 || after === 9 || after === 62 || after === 47 || after === -1)) {
    // A closing tag takes no attributes: </a href="x"> is not a block.
    if (s.charCodeAt(i + 1) === 47) {
      let m = k;
      while (m < n && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9)) m++;
      if (m < n && s.charCodeAt(m) !== 62) return 0;
    }
    return 6;
  }
  // Type 7: a complete tag (open or closing) alone on the line.
  // A tab right after the tag name is not a type-7 block (a space is).
  const tagEnd = scanHtmlTag(s, i);
  if (tagEnd !== -1 && after !== 9) {
    let m = tagEnd;
    while (m < n && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9)) m++;
    if (m >= n) return 7;
  }
  return 0;
}

// Thematic break: a line of - _ * (3+), possibly spaced.
function isThematicBreak(ln) {
  const s = ln.s;
  let i = ln.i;
  const n = s.length;
  while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i >= n) return false;
  const c = s.charCodeAt(i);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  let count = 0;
  while (i < n) {
    const cc = s.charCodeAt(i);
    if (cc === c) { count++; i++; }
    else if (cc === 32 || cc === 9) i++;
    else return false;
  }
  return count >= 3;
}

// If s is a run of '=' characters (with optional leading/trailing
// whitespace), return the run with its trailing whitespace (leading
// whitespace removed); otherwise null.
function equalsRun(s) {
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i >= s.length || s.charCodeAt(i) !== 61) return null;
  let j = i;
  while (j < s.length && s.charCodeAt(j) === 61) j++;
  let k = j;
  while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
  if (k < s.length) return null;
  return s.slice(i);
}

// Setext underline: a run of = or - (no internal spaces), with optional
// leading/trailing whitespace. The leading indent must be at most 3
// columns (4+ is not a setext underline).
function setextLevel(ln) {
  if (peekSpaces(ln).cols > 3) return 0;
  const s = ln.s;
  let i = ln.i;
  const n = s.length;
  while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i >= n) return 0;
  const c = s.charCodeAt(i);
  if (c !== 61 && c !== 45) return 0;
  while (i < n && s.charCodeAt(i) === c) i++;
  while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i < n) return 0;
  return c === 61 ? 1 : 2;
}

// ---------------------------------------------------------------------------
// GFM tables
// ---------------------------------------------------------------------------

// Split a table row line into cells (naive split on unescaped '|').
// Leading/trailing pipes are ignored. Returns null when the line has no
// usable cells.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  // Skip leading whitespace, then a leading pipe.
  let j = 0;
  while (j < n && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j < n && line.charCodeAt(j) === 124) i = j + 1;
  for (; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < n && line.charCodeAt(i + 1) === 124) {
      cur += '|';
      i++;
    } else if (c === 124) {
      cells.push(cur);
      cur = '';
    } else {
      cur += line[i];
    }
  }
  // A trailing pipe ends the last cell; otherwise the last segment is a cell.
  if (n > 0 && line.charCodeAt(n - 1) === 124) {
    // trailing pipe: the last segment was already pushed as a cell above
    // when we hit the pipe; do not add another
  } else {
    cells.push(cur);
  }
  return cells;
}

// Is this line a table delimiter row? Returns the alignment array
// ('l'/'r'/'c'/null per column) or null.
function tableDelimiter(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (let cell of cells) {
    cell = cell.trim();
    if (!/^:?-+:?$/.test(cell)) return null;
    if (cell.startsWith(':') && cell.endsWith(':') && cell.length >= 2) aligns.push('c');
    else if (cell.startsWith(':')) aligns.push('l');
    else if (cell.endsWith(':')) aligns.push('r');
    else aligns.push(null);
  }
  return aligns;
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

// Attempt to parse one link reference definition from the logical lines
// starting at `startIdx`. `getLine(idx)` returns the stripped content of
// raw line idx, or null when the containers do not match there.
// Returns {ref, linesUsed, label} or null.
//
// The definition is parsed over a cursor of (line, column) across the
// logical lines, so a title may span several lines (even blank ones),
// while the destination and the title's start must not be separated from
// what precedes them by a blank line.
function parseLinkDef(getLine, startIdx) {
  const first = getLine(startIdx);
  if (first === null) return null;
  let p = 0;
  while (p < 3 && first.charCodeAt(p) === 32) p++;
  if (first.charCodeAt(p) !== 91) return null; // [
  // Scan the label across lines (it may span lines). The label is the
  // text up to the first unescaped ']' and must not contain '['.
  let labelText = '';
  let curLine = first;
  let curIdx = startIdx;
  let lci = p + 1;
  let labelEndLine = -1;
  let labelEndCi = -1;
  for (;;) {
    if (lci >= curLine.length) {
      const nl = getLine(curIdx + 1);
      if (nl === null) return null;
      labelText += '\n';
      curLine = nl;
      curIdx++;
      lci = 0;
      continue;
    }
    const c = curLine.charCodeAt(lci);
    if (c === 92 && lci + 1 < curLine.length && isAsciiPunct(curLine.charCodeAt(lci + 1))) {
      // Backslash escape: keep both characters in the label (labels are
      // matched literally, so [foo\!] does not match [foo!]).
      labelText += curLine[lci] + curLine[lci + 1];
      lci += 2;
      continue;
    }
    if (c === 91) return null; // '[' inside the label
    if (c === 93) { // ']'
      labelEndLine = curIdx;
      labelEndCi = lci + 1;
      break;
    }
    labelText += curLine[lci];
    lci++;
  }
  const label = normalizeLabel(labelText);
  if (label.length === 0) return null;
  // The char after ']' must be ':' on the same line.
  if (labelEndCi >= curLine.length) return null;
  if (curLine.charCodeAt(labelEndCi) !== 58) return null; // :
  const labelLines = labelEndLine - startIdx;
  const lines = [curLine.slice(labelEndCi + 1)];
  let nextLine = labelEndLine + 1;
  const isBlank = (li) => {
    const l = lines[li];
    for (let a = 0; a < l.length; a++) {
      const c = l.charCodeAt(a);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  };
  const extend = () => {
    const l = getLine(nextLine);
    if (l === null) return false;
    lines.push(l);
    nextLine++;
    return true;
  };
  // Cursor: li = line index, ci = char index within the line.
  // charAt returns the char code, 10 for a line break, -1 at end of input.
  let li = 0;
  let ci = 0;
  const charAt = () => {
    if (li >= lines.length) return -1;
    const l = lines[li];
    if (ci < l.length) return l.charCodeAt(ci);
    if (li + 1 < lines.length) return 10;
    return -1;
  };
  const advance = () => {
    if (li >= lines.length) return;
    const l = lines[li];
    if (ci < l.length) ci++;
    else { li++; ci = 0; }
  };
  const atEnd = () => {
    if (li >= lines.length) return true;
    if (ci < lines[li].length) return false;
    return li + 1 >= lines.length;
  };
  // Skip spaces/tabs/newlines. Returns false when a blank line is crossed
  // (i.e. the line entered is blank).
  const skipWs = () => {
    for (;;) {
      const c = charAt();
      if (c === 32 || c === 9) { advance(); continue; }
      if (c === 10) {
        if (isBlank(li + 1)) return false;
        advance();
        continue;
      }
      return true;
    }
  };
  if (!skipWs()) return null;
  if (atEnd()) {
    if (!extend()) return null;
    if (!skipWs()) return null;
  }
  let dest;
  if (charAt() === 60) { // <...> angle destination (no newline inside)
    advance();
    let s = '';
    for (;;) {
      const c = charAt();
      if (c === -1) {
        if (!extend()) return null;
        continue;
      }
      if (c === 10) return null;
      if (c === 62) { advance(); break; }
      s += String.fromCharCode(c);
      advance();
    }
    dest = s; // an empty angle destination <> is valid (href "")
  } else {
    let depth = 0;
    let s = '';
    for (;;) {
      const c = charAt();
      if (c === -1) {
        if (!extend()) break;
        continue;
      }
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 92) { // backslash escape: only punct chars are unescaped
        advance();
        const c2 = charAt();
        if (c2 === -1) {
          if (!extend()) break;
          continue;
        }
        if (isAsciiPunct(c2)) s += String.fromCharCode(c2);
        else s += '\\' + String.fromCharCode(c2);
        advance();
        continue;
      }
      if (c === 40) { depth++; s += '('; advance(); continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--; s += ')'; advance(); continue;
      }
      s += String.fromCharCode(c);
      advance();
    }
    if (depth !== 0) return null;
    if (s.length === 0) return null;
    dest = s;
  }
  // Title (optional): must start on the same line or the next line,
  // separated from the destination by whitespace. If no title follows,
  // the cursor is restored to the end of the destination. When the title
  // starts on a FOLLOWING line and fails for any reason (unclosed, junk
  // after it, two titles), the definition falls back to having no title
  // instead of failing; a same-line title failure fails the definition.
  let title = null;
  const saveLi = li, saveCi = ci;
  let haveTitle = false;
  let titleStartLi = -1;
  let titleBad = false;
  for (;;) {
    if (!skipWs()) break; // crossed a blank line: no title
    if (atEnd()) {
      if (!extend()) break; // no more lines: no title
      continue; // retry skipWs on the new line
    }
    const qc = charAt();
    if (qc === 34 || qc === 39 || qc === 40) {
      // A title must be separated from the destination by whitespace.
      if (li === saveLi && ci === saveCi) return null;
      haveTitle = true;
      titleStartLi = li;
      const closeCh = qc === 40 ? 41 : qc;
      advance();
      let s = '';
      let found = false;
      for (;;) {
        const c = charAt();
        if (c === -1) {
          if (!extend()) { titleBad = true; break; }
          continue;
        }
        // A single-quoted title cannot span a blank line.
        if (c === 10 && qc === 39 && li + 1 < lines.length && isBlank(li + 1)) { titleBad = true; break; }
        if (c === 92) {
          advance();
          const c2 = charAt();
          if (c2 === -1) {
            if (!extend()) { titleBad = true; break; }
            continue;
          }
          if (isAsciiPunct(c2)) s += String.fromCharCode(c2);
          else { s += '\\' + String.fromCharCode(c2); }
          advance();
          continue;
        }
        if (c === closeCh) { advance(); found = true; break; }
        s += c === 10 ? '\n' : String.fromCharCode(c);
        advance();
      }
      if (titleBad) break;
      if (!found) { titleBad = true; break; }
      title = s;
    }
    break;
  }
  if (titleBad) {
    if (titleStartLi > saveLi) {
      // Following-line title failed: fall back to no title.
      li = saveLi; ci = saveCi;
      title = null;
      haveTitle = false;
    } else {
      return null;
    }
  }
  if (!haveTitle) { li = saveLi; ci = saveCi; }
  // After the title (or destination), only spaces/tabs to end of line.
  for (;;) {
    const c = charAt();
    if (c === 32 || c === 9) { advance(); continue; }
    break;
  }
  if (charAt() !== -1 && charAt() !== 10) {
    if (haveTitle && titleStartLi > saveLi) {
      // Following-line title followed by junk: fall back to no title.
      li = saveLi; ci = saveCi;
      title = null;
    } else {
      return null;
    }
  }
  // The definition consumed labelLines + li + 1 raw lines.
  const used = labelLines + li + 1;
  return { ref: { href: dest, title }, linesUsed: used, label };
}

// ===========================================================================
// Main block parsing loop
// ===========================================================================

function parseBlocks(src) {
  const lines = src.split('\n');
  // A trailing '\n' is a line terminator, not an extra blank line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const totalLines = lines.length;
  const srcEndsNl = src.endsWith('\n');
  const refs = new Map();
  const doc = { t: 'doc', children: [] };
  const open = [doc];

  const top = () => open[open.length - 1];

  // Strip the current open containers from raw line idx; returns the
  // remaining content string, or null when a container does not match.
  const logicalLine = (idx) => {
    if (idx >= lines.length) return null;
    const ln = makeLine(lines[idx]);
    for (let k = 1; k < open.length; k++) {
      const b = open[k];
      if (b.t !== 'quote' && b.t !== 'list' && b.t !== 'item') break;
      if (b.t === 'quote') { if (!matchQuote(ln)) return null; }
      else if (b.t === 'item') { if (!matchItem(ln, b)) return null; }
    }
    return contentOf(ln);
  };

  // Try to consume link reference definitions starting at line li.
  // Returns the number of lines consumed (0 when the line is not a def).
  const tryDefs = (li) => {
    let used = 0;
    for (;;) {
      const r = parseLinkDef(logicalLine, li + used);
      if (!r) break;
      if (!refs.has(r.label)) refs.set(r.label, r.ref);
      used += r.linesUsed;
    }
    return used;
  };

  // Whether a blank line intervened before the current non-blank line.
  let blankLine = false;
  let hadBlank = false;
  // Whether the previous line was blank.
  let prevBlank = false;
  // A blank line with container markers (e.g. `>`) is local to its
  // innermost container: it stops counting once that container closes.
  // A truly blank line counts globally. blankDepth is the open-stack
  // depth the local blank line was recorded at.
  let blankLocal = false;
  let blankDepth = 0;

  // Whether the next line (li+1) matches all currently open containers.
  const nextMatches = () => {
    if (li + 1 >= lines.length) return false;
    const nln = makeLine(lines[li + 1]);
    for (let k = 1; k < open.length; k++) {
      const b = open[k];
      if (b.t !== 'quote' && b.t !== 'list' && b.t !== 'item') break;
      if (b.t === 'quote') { if (!matchQuote(nln)) return false; }
      else if (b.t === 'item') { if (!matchItem(nln, b)) return false; }
    }
    return true;
  };

  // When a blank line intervened since the previous block and `parent`
  // is a list item that already has children, the list containing that
  // item is loose (the item holds two blocks separated by a blank line).
  const markLooseFor = (parent) => {
    if (hadBlank && parent.t === 'item' && parent.children.length > 0) {
      for (let k = open.length - 1; k >= 1; k--) {
        if (open[k] === parent && open[k - 1].t === 'list') {
          open[k - 1].loose = true;
          break;
        }
      }
    }
  };

  // Add a block node as a child of `parent`, marking the list loose when
  // a blank line intervened (see markLooseFor).
  const addBlock = (parent, node) => {
    markLooseFor(parent);
    parent.children.push(node);
  };

  // A paragraph's lines, minus trailing blank lines, joined with '\n'.
  const paraText = (para) => {
    let end = para.lines.length;
    while (end > 0 && para.lines[end - 1] === '') end--;
    return para.lines.slice(0, end).join('\n');
  };

  // A paragraph's lines as a setext heading's text: the leading
  // whitespace of the first line and the trailing whitespace of the last
  // line are stripped; every other line is kept verbatim (so trailing
  // spaces on a non-last line still form a hard break).
  const setextText = (para) => {
    const lines = para.lines;
    let end = lines.length;
    while (end > 0 && lines[end - 1] === '') end--;
    if (end === 0) return '';
    let out = '';
    for (let k = 0; k < end; k++) {
      let line = lines[k];
      if (k === 0) {
        let a = 0;
        while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
        line = line.slice(a);
      }
      if (k === end - 1) {
        let b = line.length;
        while (b > 0 && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
        line = line.slice(0, b);
      }
      if (k > 0) out += '\n';
      out += line;
    }
    return out;
  };

  let li = 0;
  while (li < lines.length) {
    const ln = makeLine(lines[li]);
    // ---- 1. match open containers ----
    let containerCount = 0;
    let allMatched = true;
    // Innermost enclosing list item's content indent: the column origin
    // for tab-width computation after a `>` marker.
    let itemBaseCol = 0;
    for (let k = open.length - 1; k >= 0; k--) {
      if (open[k].t === 'item') { itemBaseCol = open[k].contentIndent; break; }
    }
    for (let k = 1; k < open.length; k++) {
      const b = open[k];
      if (b.t !== 'quote' && b.t !== 'list' && b.t !== 'item') break;
      if (b.t === 'quote') {
        if (!matchQuote(ln, itemBaseCol)) { allMatched = false; break; }
      } else if (b.t === 'item') {
        if (!matchItem(ln, b)) { allMatched = false; break; }
      }
      containerCount = k;
    }
    // Lazy continuation: a paragraph may continue on a line that does not
    // match its containers, provided the line is plain paragraph text.
    let lazy = false;
    if (!allMatched && top().t === 'para' && !isBlankFrom(ln) &&
      !lineStartsBlock(ln)) {
      lazy = true;
    }
    // A fenced code block captures its content lines even when they do not
    // match an enclosing LIST ITEM (e.g. an unindented line inside a
    // fenced block in a list item). It does NOT capture lines that fail
    // a BLOCKQUOTE (a line without `>` is outside the quote), and an
    // unindented fence line of the same char does not close the in-item
    // fence — it starts a new top-level fence instead.
    let codeUnmatched = false;
    if (!allMatched && top().t === 'code' && top().fenced) {
      const failB = open[containerCount + 1];
      if (failB && failB.t === 'item') {
        const leaf0 = top();
        const save0 = { i: ln.i, col: ln.col, part: ln.part };
        const ind0 = peekSpaces(ln).cols;
        let isFenceLine = false;
        if (ind0 <= 3) {
          lskipSpaces(ln, ind0);
          let n0 = 0;
          while (lch(ln) === leaf0.fence) { ladv(ln); n0++; }
          if (n0 >= leaf0.len && isBlankFrom(ln)) isFenceLine = true;
        }
        ln.i = save0.i; ln.col = save0.col; ln.part = save0.part;
        // Only once the fence already holds content: if its very first
        // content line is unindented, the fence ends empty instead.
        // And only for plain text: a line that starts a new block (a
        // list item, heading, blockquote, thematic break, fence) ends
        // the fence instead of being captured as code content.
        if (!isFenceLine && leaf0.lines.length > 0 && !lineStartsBlock(ln)) codeUnmatched = true;
      }
    }
    if (!allMatched && !lazy && !codeUnmatched) {
      while (open.length > containerCount + 1) open.pop();
    }

    // ---- 2. blank line ----
    if (isBlankFrom(ln)) {
      // A whitespace-only line containing a tab, whose expanded width
      // is exactly 4 columns, is a table body row (empty cells), not a
      // blank line that ends the table.
      const leaf0 = top();
      if (leaf0.t === 'table') {
        const p0 = peekSpaces(ln);
        let hasTab = false;
        for (let c = ln.i; c < lines[li].length; c++) {
          const cc = lines[li].charCodeAt(c);
          if (cc === 9) { hasTab = true; break; }
          if (cc !== 32) break;
        }
        if (hasTab && ln.col + p0.cols === 4) {
          leaf0.rows.push(contentOf(ln));
          li++;
          continue;
        }
      }
      blankLine = true;
      // A line of only whitespace is a global blank line; a line with
      // container markers is local to its innermost container.
      const raw = lines[li];
      let allWs = true;
      for (let c = 0; c < raw.length; c++) {
        const cc = raw.charCodeAt(c);
        if (cc !== 32 && cc !== 9) { allWs = false; break; }
      }
      blankLocal = !allWs;
      const wasPrevBlank = prevBlank;
      prevBlank = true;
      const leaf = top();
      if (leaf.t === 'para') {
        // A spaces-only line inside a blockquote, when the quote ends
        // after it and the previous line was not blank, contributes its
        // spaces as a paragraph line (cm-241).
        const parent = open[open.length - 2];
        if (parent && parent.t === 'quote' && !wasPrevBlank && !nextMatches()) {
          const sp = contentOf(ln);
          let allSp = sp.length > 0;
          for (let c = 0; c < sp.length; c++) {
            if (sp.charCodeAt(c) !== 32) { allSp = false; break; }
          }
          if (allSp) leaf.lines.push(sp);
        }
        open.pop();
      } else if (leaf.t === 'code') {
        // A blank line's whitespace is code content: for fenced code it
        // is kept verbatim; for indented code the first 4 columns of
        // indent are removed. A backtick fence also loses up to its
        // indent (whitespace characters) from a blank content line —
        // e.g. a fence indented 2 with a 3-space blank line keeps 1
        // space. A tilde fence does not dedent.
        if (leaf.fenced) {
          if (leaf.fence === 96 && leaf.indent > 0) lskipWsChars(ln, leaf.indent);
          leaf.lines.push(contentOf(ln));
        } else {
          lskipSpaces(ln, 4);
          leaf.lines.push(restOfLine(ln));
        }
      } else if (leaf.t === 'html') {
        if (leaf.htmlType === 6 || leaf.htmlType === 7) open.pop();
        else { leaf.lines.push(''); leaf.lastLine = li; }
      } else if (leaf.t === 'table') open.pop();
      // A blank line closes an empty list item: it cannot take content
      // after the blank line.
      if (top().t === 'item' && top().children.length === 0) open.pop();
      // A local blank line belongs to its innermost container with a
      // marker on this line (a quote, else a list) — not to the leaf
      // item, whose pop for a sibling item must not clear the flag.
      if (blankLocal) {
        blankDepth = open.length;
        for (let k = open.length - 1; k >= 0; k--) {
          if (open[k].t === 'quote' || open[k].t === 'list') {
            blankDepth = k + 1;
            break;
          }
        }
      }
      li++;
      continue;
    }

    // A local blank line stops counting once its container closes.
    if (blankLocal && open.length < blankDepth) {
      blankLine = false;
      blankLocal = false;
    }

    // Capture whether a blank line intervened before this line, then
    // clear the flag for the next line.
    hadBlank = blankLine;
    blankLine = false;
    prevBlank = false;

    // ---- 3. leaf continuation ----
    let leaf = top();
    if (leaf.t === 'code' && leaf.fenced) {
      const save = { i: ln.i, col: ln.col, part: ln.part };
      const ind = peekSpaces(ln).cols;
      if (ind <= 3) {
        lskipSpaces(ln, ind);
        if (isClosingFence(ln, leaf.fence, leaf.len)) {
          open.pop();
          li++;
          continue;
        }
      }
      ln.i = save.i; ln.col = save.col; ln.part = save.part;
      // A content line loses up to the opening fence's indent — but only
      // for backtick fences. A tilde fence does NOT dedent its content
      // by the fence indent (only container indent is stripped, which
      // already happened in phase 2); stripping it would eat real
      // content indent (e.g. `>   ~~~x` + `>   if ...` keeps 2 spaces).
      if (codeUnmatched) {
        const strip = Math.max(0, (leaf.rawIndent || 0) - ln.col);
        if (strip > 0) lskipSpaces(ln, strip);
      } else if (leaf.indent > 0 && leaf.fence === 96) lskipWsChars(ln, leaf.indent);
      // Fenced-code content: at top level tabs are kept verbatim after the
      // fence indent is stripped. Inside a blockquote, a leading tab expands
      // by column, but nested quotes do not accumulate: the effective column
      // is ln.col minus 2 per quote level beyond the first.
      let fcontent;
      if (open.length <= 2) {
        fcontent = restOfLine(ln);
      } else {
        let quoteCount = 0;
        let itemIndent = 0;
        let innerIsItem = false;
        for (let q = 0; q < open.length; q++) {
          if (open[q].t === 'quote') quoteCount++;
          if (open[q].t === 'item') itemIndent = open[q].contentIndent;
        }
        // Innermost container (ignoring the leaf code block itself).
        for (let q = open.length - 2; q >= 0; q--) {
          if (open[q].t === 'item') { innerIsItem = true; break; }
          if (open[q].t === 'quote') break;
        }
        if (quoteCount > 0) {
          // Subtract the item indent only when the quote sits inside the
          // item; when the item is innermost, the column is already
          // relative to it.
          const sub = innerIsItem ? 0 : itemIndent;
          fcontent = contentOfCol(ln, ln.col - sub - 2 * (quoteCount - 1));
        } else {
          fcontent = contentOf(ln);
        }
      }
      leaf.lines.push(fcontent);
      li++;
      continue;
    }
    if (leaf.t === 'code' && !leaf.fenced) {
      if (peekSpaces(ln).cols >= 4) {
        lskipSpaces(ln, 4);
        leaf.lines.push(restOfLine(ln));
        li++;
        continue;
      }
      open.pop(); // fall through to new-block processing
      leaf = top();
    }
    if (leaf.t === 'html') {
      const text = contentOf(ln);
      leaf.lines.push(text);
      leaf.lastLine = li;
      if (htmlBlockEnds(leaf, text)) {
        leaf.closedByTag = true;
        open.pop();
      }
      li++;
      continue;
    }
    if (leaf.t === 'table') {
      // A body row: not blank, indent < 4, does not start a new block.
      const ind = peekSpaces(ln).cols;
      if (ind < 4 && !startsNewBlock(ln)) {
        leaf.rows.push(contentOf(ln));
        li++;
        continue;
      }
      open.pop();
      leaf = top();
    }

    // ---- 4. new blocks (may loop: blockquote/list nest) ----
    // `ln` is the cursor after the matched containers. The paragraph leaf,
    // if open, stays open for setext/table checks.
    let handled = false;
    let lineDone = false;
    while (!handled) {
      const ind = peekSpaces(ln).cols;
      // Thematic break (beats list items; loses to setext underlines)
      if (ind <= 3 && isThematicBreak(ln)) {
        const paraNow = top().t === 'para';
        if (!(paraNow && setextLevel(ln) > 0)) {
          if (paraNow) open.pop();
          if (top().t === 'list') open.pop();
          addBlock(top(), { t: 'hr' });
          lineDone = true;
          break;
        }
      }
      // Blockquote
      if (ind <= 3) {
        const save = { i: ln.i, col: ln.col, part: ln.part };
        lskipSpaces(ln, ind);
        if (lch(ln) === 62) {
          ladv(ln);
          // The space after `>` is optional. A tab here expands from
          // the container-relative column (see matchQuote): consume 1
          // column of that width, not of the raw line column.
          if (lch(ln) === 32) lskipSpaces(ln, 1);
          else if (lch(ln) === 9) {
            const relCol = ln.col - itemBaseCol;
            const w = 4 - (relCol % 4);
            if (w > 1) {
              ln.part = w - 1;
              ln.col += 1;
            } else {
              ladv(ln);
            }
          }
          if (top().t === 'para') open.pop();
          if (top().t === 'list') open.pop();
          const q = { t: 'quote', children: [] };
          addBlock(top(), q);
          open.push(q);
          continue;
        }
        ln.i = save.i; ln.col = save.col; ln.part = save.part;
      }
      // List item
      if (ind <= 3) {
        const save = { i: ln.i, col: ln.col, part: ln.part };
        lskipSpaces(ln, ind);
        const m = parseListMarker(ln);
        if (m) {
          const paraOpen = top().t === 'para';
          // An ordered list not starting at 1 cannot interrupt a
          // paragraph, EXCEPT when the paragraph sits inside a list item:
          // then the list nests inside the item and may interrupt it.
          // An empty list marker never interrupts a paragraph.
          const inItem = paraOpen && open.length >= 2 && open[open.length - 2].t === 'item';
          const canInterrupt = !paraOpen || (!m.ordered || m.start === 1 || inItem) && !m.empty;
          if (canInterrupt) {
            if (paraOpen) open.pop();
            let parent = top();
            let list = null;
            if (parent.t === 'list' && parent.ordered === m.ordered &&
              parent.bullet === m.bullet && parent.delim === m.delim) {
              list = parent;
            } else {
              if (parent.t === 'list') open.pop();
              parent = top();
              list = {
                t: 'list', ordered: m.ordered, bullet: m.bullet,
                delim: m.delim, start: m.start, loose: false,
                children: [],
              };
              addBlock(parent, list);
              open.push(list);
            }
            // A new item after a blank line makes its list loose, unless
            // it is the list's first item.
            if (hadBlank && list.children.length > 0) list.loose = true;
            const item = { t: 'item', contentIndent: m.contentIndent, relContentIndent: m.contentIndent - save.col, children: [] };
            list.children.push(item);
            open.push(item);
            continue;
          }
        }
        ln.i = save.i; ln.col = save.col; ln.part = save.part;
      }
      handled = true;
    }

    if (lineDone) {
      li++;
      continue;
    }

    // A blank remainder (e.g. a lone '>') creates nothing.
    if (isBlankFrom(ln)) {
      li++;
      continue;
    }

    // ---- 5. leaf blocks / paragraph ----
    if (top().t === 'list') open.pop();
    leaf = top();
    const paraOpen = leaf.t === 'para';
    // Setext heading (paragraph open). A setext underline cannot be a
    // lazy continuation line, so this only runs when the line matched
    // the paragraph's containers.
    if (paraOpen && !lazy) {
      const save = { i: ln.i, col: ln.col, part: ln.part };
      const lvl = setextLevel(ln);
      if (lvl > 0) {
        const para = open.pop();
        const parent = top();
        const pi = parent.children.indexOf(para);
        if (pi !== -1) parent.children.splice(pi, 1);
        parent.children.push({ t: 'head', level: lvl, text: setextText(para) });
        li++;
        continue;
      }
      ln.i = save.i; ln.col = save.col; ln.part = save.part;
    }
    // Table delimiter (paragraph open, indent at most 3)
    if (paraOpen && peekSpaces(ln).cols <= 3) {
      const aligns = tableDelimiter(contentOf(ln));
      if (aligns) {
        const para = top();
        const plines = para.lines.slice();
        while (plines.length > 0 && plines[plines.length - 1] === '') plines.pop();
        if (plines.length > 0) {
          const headerCells = splitTableRow(plines[plines.length - 1]);
          if (headerCells.length === aligns.length) {
            const para = open.pop();
            const parent = top();
            const pi = parent.children.indexOf(para);
            if (pi !== -1) parent.children.splice(pi, 1);
            if (plines.length > 1) {
              parent.children.push({ t: 'para', lines: plines.slice(0, -1) });
            }
            const table = {
              t: 'table', aligns,
              header: plines[plines.length - 1], rows: [],
            };
            top().children.push(table);
            open.push(table);
            li++;
            continue;
          }
        }
      }
    }
    // ATX heading
    if (peekSpaces(ln).cols <= 3) {
      const save = { i: ln.i, col: ln.col, part: ln.part };
      lskipSpaces(ln, peekSpaces(ln).cols);
      const atx = parseAtx(ln);
      if (atx) {
        if (paraOpen) open.pop();
        addBlock(top(), { t: 'head', level: atx.level, text: atx.text });
        li++;
        continue;
      }
      ln.i = save.i; ln.col = save.col; ln.part = save.part;
    }
    // Fenced code
    if (peekSpaces(ln).cols <= 3) {
      const save = { i: ln.i, col: ln.col, part: ln.part };
      const find = peekSpaces(ln).cols;
      lskipSpaces(ln, find);
      const f = parseFence(ln);
      if (f) {
        if (paraOpen) open.pop();
        const code = { t: 'code', fenced: true, fence: f.fence, len: f.len, info: f.info, indent: find, rawIndent: ln.col, lines: [] };
        addBlock(top(), code);
        open.push(code);
        li++;
        continue;
      }
      ln.i = save.i; ln.col = save.col; ln.part = save.part;
    }
    // HTML block (type 7 cannot interrupt a paragraph). The first line
    // keeps its leading whitespace.
    if (peekSpaces(ln).cols <= 3) {
      const save = { i: ln.i, col: ln.col, part: ln.part };
      const firstLine = contentOf(ln);
      lskipSpaces(ln, peekSpaces(ln).cols);
      const ht = htmlBlockStart(ln);
      if (ht > 0 && !(ht === 7 && paraOpen)) {
        if (paraOpen) open.pop();
        const html = { t: 'html', htmlType: ht, lines: [firstLine], lastLine: li, closedByTag: false };
        if (ht === 1) {
          const m = firstLine.toLowerCase().match(/<(pre|script|style|textarea)(?:[\s/>]|$)/);
          html.endTag = m ? m[1] : 'pre';
        }
        addBlock(top(), html);
        open.push(html);
        if (htmlBlockEnds(html, firstLine)) {
          html.closedByTag = true;
          open.pop();
        }
        li++;
        continue;
      }
      ln.i = save.i; ln.col = save.col; ln.part = save.part;
    }
    // Indented code (no paragraph open)
    if (!paraOpen && peekSpaces(ln).cols >= 4) {
      lskipSpaces(ln, 4);
      const code = { t: 'code', fenced: false, lines: [restOfLine(ln)] };
      addBlock(top(), code);
      open.push(code);
      li++;
      continue;
    }
    // Link reference definitions (only at a paragraph start). A def is
    // a block inside its parent, so it can loosen a list like any block.
    if (!paraOpen) {
      const used = tryDefs(li);
      if (used > 0) {
        markLooseFor(top());
        li += used;
        continue;
      }
    }
    // Paragraph (create or continue)
    if (!paraOpen) {
      const para = { t: 'para', lines: [], lastLazy: false };
      addBlock(top(), para);
      open.push(para);
    }
    const para = top();
    // Inside a blockquote, a leading tab expands by column, but nested
    // quotes do not accumulate and the item indent is subtracted when
    // the quote sits inside the item (same adjustment as fenced-code
    // content): the tab's column is relative to the item's content
    // start, not the raw line. Only for matched lines: a lazy
    // continuation line is stripped by the lazy path below instead.
    let content;
    {
      let quoteCount = 0;
      let itemIndent = 0;
      for (let q = 0; q < open.length; q++) {
        if (open[q].t === 'quote') quoteCount++;
        if (open[q].t === 'item') itemIndent = open[q].contentIndent;
      }
      if (quoteCount > 0 && !lazy) {
        let innerIsItem = false;
        for (let q = open.length - 2; q >= 0; q--) {
          if (open[q].t === 'item') { innerIsItem = true; break; }
          if (open[q].t === 'quote') break;
        }
        const sub = innerIsItem ? 0 : itemIndent;
        content = contentOfCol(ln, ln.col - sub - 2 * (quoteCount - 1));
      } else {
        content = contentOf(ln);
      }
    }
    if (lazy) {
      // A lazy continuation line loses its container's indent, then 4
      // more columns when the remainder is >= 4. When the indent is
      // below the container's indent, the line's own indent loses 4
      // columns when it is >= 4.
      const parent = open[open.length - 2];
      const base = parent && parent.t === 'item' ? parent.relContentIndent : 0;
      const ind = indentCols(content);
      let rem = ind >= base ? ind - base : ind;
      if (rem >= 4) rem -= 4;
      content = stripIndentCols(content, ind - rem);
      // A lazy '=' setext-underline line, following another lazy line,
      // inside a blockquote, is stored indented by 4 spaces, so it stays
      // plain paragraph text instead of forming a setext heading.
      const eq = equalsRun(content);
      if (eq !== null && para.lastLazy) {
        const parent = open[open.length - 2];
        if (parent && parent.t === 'quote') content = '    ' + eq;
      }
      para.lastLazy = true;
    } else {
      // A matched continuation line inside a list item loses 4 columns
      // when its remaining indent is >= 4.
      if (paraOpen) {
        const parent = open[open.length - 2];
        if (parent && parent.t === 'item') {
          const ind = indentCols(content);
          if (ind >= 4) content = stripIndentCols(content, 4);
        }
      }
      para.lastLazy = false;
    }
    para.lines.push(content);
    li++;
  }
  // An HTML block's trailing newline: a type 1 block that ended at its
  // close tag keeps one when the following line is not blank (or when
  // it is the last line and the input ends with a newline); any other
  // block keeps one only when its last line is the last input line and
  // the input ends with a newline. A block cut off by a blank line or
  // by a following block gets none. NOTE: "blank" here means truly empty
  // — a whitespace-only line (spaces/tabs) after a close tag KEEPS the
  // trailing newline; only an empty line drops it.
  const isBlankRaw = (s) => s.length === 0;
  // A line of only `>` markers and whitespace, with at least one `>`,
  // is a blank line inside a blockquote (e.g. a lone `>` after an HTML
  // block that ended): it drops the trailing newline, like an empty
  // line. A whitespace-only line (no `>`) still keeps it.
  const isBlankQuoteLine = (s) => {
    let seen = false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 62) { seen = true; continue; }
      if (c === 32 || c === 9) continue;
      return false;
    }
    return seen;
  };
  const markHtml = (node) => {
    if (node.t === 'html') {
      if (node.closedByTag) {
        node.trailingNl = node.lastLine + 1 < totalLines
          ? !isBlankRaw(lines[node.lastLine + 1]) && !isBlankQuoteLine(lines[node.lastLine + 1])
          : srcEndsNl;
      } else {
        node.trailingNl = node.lastLine === totalLines - 1 && srcEndsNl;
      }
    }
    if (node.children) for (const c of node.children) markHtml(c);
  };
  markHtml(doc);
  return { doc, refs };
}

// Does the line (at the cursor) start a new block that would end a
// paragraph, including a lazy continuation? A '=' setext underline does
// not start a block (it is a lazy continuation); a '-' underline is also
// a thematic break, which does start a block.
function lineStartsBlock(ln) {
  if (setextLevel(ln) === 1) return false;
  const q = { s: ln.s, i: ln.i, col: ln.col, part: ln.part };
  const ind = peekSpaces(q).cols;
  if (ind > 3) return false;
  lskipSpaces(q, ind);
  if (lch(q) === 62) return true; // blockquote
  if (parseAtx(q)) return true;
  q.i = ln.i; q.col = ln.col; q.part = ln.part;
  lskipSpaces(q, ind);
  if (parseFence(q)) return true;
  q.i = ln.i; q.col = ln.col; q.part = ln.part;
  lskipSpaces(q, ind);
  if (htmlBlockStart(q) > 0) return true;
  q.i = ln.i; q.col = ln.col; q.part = ln.part;
  if (isThematicBreak(q)) return true;
  q.i = ln.i; q.col = ln.col; q.part = ln.part;
  lskipSpaces(q, ind);
  if (parseListMarker(q)) return true;
  return false;
}

// Does this line end an HTML block of the given type?
function htmlBlockEnds(html, text) {
  const low = text.toLowerCase();
  switch (html.htmlType) {
    case 1: {
      const tag = html.endTag;
      const idx = low.indexOf('</' + tag);
      if (idx === -1) return false;
      const after = low.charCodeAt(idx + 2 + tag.length);
      return after === 32 || after === 9 || after === 62 || after === 47 ||
        Number.isNaN(after);
    }
    case 2: return low.indexOf('-->') !== -1;
    case 3: return low.indexOf('?>') !== -1;
    case 4: return low.indexOf('>') !== -1;
    case 5: return low.indexOf(']]>') !== -1;
    default: return false; // types 6/7 end at a blank line
  }
}

// Would this line start a new block (used to end a table body)?
function startsNewBlock(ln) {
  const save = { i: ln.i, col: ln.col, part: ln.part };
  const ind = peekSpaces(ln).cols;
  if (ind > 3) { ln.i = save.i; ln.col = save.col; ln.part = save.part; return true; }
  lskipSpaces(ln, ind);
  const c = lch(ln);
  if (c === 62) { ln.i = save.i; ln.col = save.col; ln.part = save.part; return true; } // >
  if (parseAtx(ln)) { ln.i = save.i; ln.col = save.col; ln.part = save.part; return true; }
  ln.i = save.i; ln.col = save.col; ln.part = save.part;
  lskipSpaces(ln, ind);
  if (parseFence(ln)) { ln.i = save.i; ln.col = save.col; ln.part = save.part; return true; }
  ln.i = save.i; ln.col = save.col; ln.part = save.part;
  lskipSpaces(ln, ind);
  if (htmlBlockStart(ln) > 0) { ln.i = save.i; ln.col = save.col; ln.part = save.part; return true; }
  ln.i = save.i; ln.col = save.col; ln.part = save.part;
  if (isThematicBreak(ln)) return true;
  // list marker
  lskipSpaces(ln, ind);
  const m = parseListMarker(ln);
  ln.i = save.i; ln.col = save.col; ln.part = save.part;
  return m !== null;
}

// ===========================================================================
// Rendering
// ===========================================================================

function renderTableCell(text, refs) {
  return parseInline(text.trim(), refs, false);
}

function renderNode(node, refs, out) {
  switch (node.t) {
    case 'doc':
      for (const c of node.children) renderNode(c, refs, out);
      break;
    case 'para':
      out.push('<p>' + parseInline(paraTextOf(node), refs, false) + '</p>\n');
      break;
    case 'head':
      out.push('<h' + node.level + '>' + parseInline(node.text, refs, false) + '</h' + node.level + '>\n');
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'code': {
      const lines = node.lines;
      let end = lines.length;
      if (!node.fenced) {
        while (end > 0 && lines[end - 1] === '') end--;
      }
      let content = lines.slice(0, end).join('\n');
      // A trailing newline is added only when the content does not
      // already end with one (a trailing blank line in fenced code
      // already supplies it).
      if (content.length > 0 && content.charCodeAt(content.length - 1) !== 10) content += '\n';
      if (node.fenced) {
        const info = node.info
          ? ' class="language-' + escapeHtml(node.info, false) + '"'
          : '';
        out.push('<pre><code' + info + '>' + escapeCode(content) + '</code></pre>\n');
      } else {
        out.push('<pre><code>' + escapeCode(content) + '</code></pre>\n');
      }
      break;
    }
    case 'html':
      out.push(node.lines.join('\n') + (node.trailingNl ? '\n' : ''));
      break;
    case 'quote': {
      out.push('<blockquote>\n');
      for (const c of node.children) renderNode(c, refs, out);
      out.push('</blockquote>\n');
      break;
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      out.push('<' + tag + start + '>\n');
      for (const item of node.children) {
        out.push('<li>');
        renderItem(item, node.loose, refs, out);
        out.push('</li>\n');
      }
      out.push('</' + tag + '>\n');
      break;
    }
    case 'table': {
      const aligns = node.aligns;
      out.push('<table>\n<thead>\n<tr>\n');
      const headCells = splitTableRow(node.header);
      for (let i = 0; i < aligns.length; i++) {
        const a = aligns[i];
        const attr = a === 'l' ? ' align="left"' : a === 'r' ? ' align="right"' : a === 'c' ? ' align="center"' : '';
        const cell = i < headCells.length ? headCells[i] : '';
        out.push('<th' + attr + '>' + renderTableCell(cell, refs) + '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (node.rows.length > 0) {
        out.push('<tbody>');
        for (const row of node.rows) {
          out.push('<tr>\n');
          const cells = splitTableRow(row);
          for (let i = 0; i < aligns.length; i++) {
            const a = aligns[i];
            const attr = a === 'l' ? ' align="left"' : a === 'r' ? ' align="right"' : a === 'c' ? ' align="center"' : '';
            const cell = i < cells.length ? cells[i] : '';
            out.push('<td' + attr + '>' + renderTableCell(cell, refs) + '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody></table>\n');
      } else {
        out.push('</table>\n');
      }
      break;
    }
  }
}

function paraTextOf(para) {
  let end = para.lines.length;
  while (end > 0 && para.lines[end - 1] === '') end--;
  return para.lines.slice(0, end).join('\n');
}

function renderItem(item, loose, refs, out) {
  const children = item.children;
  // A task list item starts with [ ] / [x] / [X] in its first paragraph.
  if (children.length === 0) return;
  const first = children[0];
  let taskHtml = null;
  if (first.t === 'para') {
    const text = paraTextOf(first);
    const m = text.match(/^\[([ xX])\] /);
    if (m) {
      taskHtml = m[1] === ' '
        ? '<input disabled="" type="checkbox"> '
        : '<input checked="" disabled="" type="checkbox"> ';
    }
  }
  if (!loose) {
    // Tight list: render the children inline (paragraphs without <p>).
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.t === 'para') {
        let html = parseInline(paraTextOf(c), refs, false);
        if (i === 0 && taskHtml !== null) {
          html = taskHtml + html.slice(4);
        }
        out.push(html);
      } else {
        renderNode(c, refs, out);
      }
    }
    return;
  }
  // Loose list: paragraphs are wrapped in <p>.
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.t === 'para') {
      let html = parseInline(paraTextOf(c), refs, false);
      if (i === 0 && taskHtml !== null) {
        html = taskHtml + html.slice(4);
      }
      out.push('<p>' + html + '</p>\n');
    } else {
      renderNode(c, refs, out);
    }
  }
}

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const { doc, refs } = parseBlocks(src);
  const out = [];
  renderNode(doc, refs, out);
  return out.join('');
}
