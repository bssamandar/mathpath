/**
 * Pure text helpers shared by the web app and the studio. Question stems and
 * solutions use inline LaTeX between dollar signs (schema doc §4.2).
 */

/**
 * Splits text with inline LaTeX (`$...$`) into plain and math parts.
 * `\$` is a literal dollar sign. An unclosed `$` is kept as plain text.
 */
export function splitMath(text: string): { math: boolean; text: string }[] {
  const parts: { math: boolean; text: string }[] = [];
  let current = '';
  let math = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '\\' && text[i + 1] === '$') {
      current += math ? '\\$' : '$';
      i += 1;
    } else if (char === '$') {
      if (current) parts.push({ math, text: current });
      current = '';
      math = !math;
    } else {
      current += char;
    }
  }
  if (math) {
    // No closing dollar: show what was typed instead of half a formula.
    const last = parts.at(-1);
    const rest = `$${current}`;
    if (last && !last.math) last.text += rest;
    else parts.push({ math: false, text: rest });
  } else if (current) {
    parts.push({ math: false, text: current });
  }
  return parts;
}
