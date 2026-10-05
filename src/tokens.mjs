// Token estimates. There is no public offline tokenizer for current Claude
// models, so this is a documented heuristic, not a count:
//   - English prose and Markdown: about 4 characters per token
//   - code (fenced blocks):       about 3.5 characters per token
//   - JSON and tool schemas:      about 3 characters per token (punctuation
//                                 and quoted keys tokenize densely)
//   - each non-ASCII character:   about 1 token (CJK, emoji and accented
//                                 text cost more than English)
// Claude Code's own /context command shows real numbers inside a session.

export const DEFAULT_RATIOS = Object.freeze({ prose: 4, code: 3.5, json: 3 });
export const RATIOS = { ...DEFAULT_RATIOS };

/** Change the prose ratio (chars per token); code and JSON scale with it. */
export function setCharsPerToken(prose) {
  const f = (Number(prose) > 0 ? Number(prose) : DEFAULT_RATIOS.prose) / DEFAULT_RATIOS.prose;
  RATIOS.prose = DEFAULT_RATIOS.prose * f;
  RATIOS.code = DEFAULT_RATIOS.code * f;
  RATIOS.json = DEFAULT_RATIOS.json * f;
}

function count(text, ratio) {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return ascii / ratio + other;
}

/** Estimate tokens for a string. kind: 'prose' | 'markdown' | 'code' | 'json'. */
export function estimateTokens(text, kind = 'markdown') {
  if (!text) return 0;
  if (kind === 'json') return Math.ceil(count(text, RATIOS.json));
  if (kind === 'code') return Math.ceil(count(text, RATIOS.code));
  if (kind === 'prose') return Math.ceil(count(text, RATIOS.prose));
  // markdown: fenced code at the code ratio, everything else as prose
  let total = 0;
  const fence = /```[\s\S]*?(```|$)/g;
  let last = 0;
  for (const m of text.matchAll(fence)) {
    total += count(text.slice(last, m.index), RATIOS.prose);
    total += count(m[0], RATIOS.code);
    last = m.index + m[0].length;
  }
  total += count(text.slice(last), RATIOS.prose);
  return Math.ceil(total);
}

export function heuristicNote() {
  const r = (n) => String(Math.round(n * 10) / 10);
  return `Estimates: ~${r(RATIOS.prose)} chars/token for prose, ~${r(RATIOS.code)} for code, ~${r(RATIOS.json)} for JSON schemas. Not exact.`;
}
