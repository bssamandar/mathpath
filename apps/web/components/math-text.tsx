'use client';

import { splitMath } from '@mathpath/client';
import katex from 'katex';
import { useMemo } from 'react';

/**
 * Text with inline formulas (`$...$`), as question stems and solutions are
 * written (schema doc §4.2). Plain parts are React text; formulas go through
 * KaTeX with `trust: false` (no links, no raw HTML, no styles from the
 * source) and size limits, so a template cannot inject markup (C-15).
 * KaTeX also writes MathML, which screen readers read as maths.
 */
export function MathText({ text, block = false }: { text: string; block?: boolean }) {
  const parts = useMemo(() => splitMath(text), [text]);
  const Tag = block ? 'p' : 'span';
  return (
    <Tag className="math-text">
      {parts.map((part, i) =>
        part.math ? (
          <span key={i} dangerouslySetInnerHTML={{ __html: renderFormula(part.text) }} />
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </Tag>
  );
}

function renderFormula(tex: string): string {
  return katex.renderToString(tex, {
    throwOnError: false,
    trust: false,
    strict: 'ignore',
    maxSize: 10,
    maxExpand: 100,
    output: 'htmlAndMathml',
  });
}
