import { forwardRef, type ReactNode } from 'react';
import { formatClock } from '../lib/format';
import type { Segment } from '../state/session';

const LANGUAGE_NAME = { tl: 'Tagalog', en: 'English' } as const;

interface SegmentLineProps {
  segment: Segment;
  explainedIds: ReadonlySet<string>;
  showTranslation: boolean;
  highlighted?: boolean;
  onTermClick: (cardId: string) => void;
}

/** One transcript line: who spoke and when, what they said, and its translation. */
export const SegmentLine = forwardRef<HTMLDivElement, SegmentLineProps>(function SegmentLine(
  { segment, explainedIds, showTranslation, highlighted, onTermClick },
  ref,
) {
  const className = ['segment', segment.final ? '' : 'segment--partial', highlighted ? 'segment--highlighted' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div ref={ref} className={className}>
      <div className="segment__meta">
        {formatClock(segment.t)} · {segment.speaker}
      </div>
      <div className="segment__text">{highlightTerms(segment, explainedIds, onTermClick)}</div>
      {showTranslation && segment.translation && (
        <div className="segment__translation" lang={segment.translation.language}>
          <span className="segment__translation-label">{LANGUAGE_NAME[segment.translation.language]}</span>
          {segment.translation.text}
        </div>
      )}
    </div>
  );
});

/** Underlines each flagged term: solid once its card exists, dotted while pending. */
export function highlightTerms(segment: Segment, explainedIds: ReadonlySet<string>, onTermClick: (cardId: string) => void) {
  const parts: ReactNode[] = [];
  let rest = segment.text;
  let key = 0;

  for (const term of segment.terms) {
    const at = rest.toLowerCase().indexOf(term.text.toLowerCase());
    if (at === -1) continue;
    parts.push(rest.slice(0, at));
    const text = rest.slice(at, at + term.text.length);
    const cardId = term.cardId !== undefined && explainedIds.has(term.cardId) ? term.cardId : null;
    parts.push(
      cardId ? (
        <button key={key++} type="button" className="term term--explained" onClick={() => onTermClick(cardId)}>
          {text}
        </button>
      ) : (
        <span key={key++} className="term term--pending" title="Explaining…">
          {text}
        </span>
      ),
    );
    rest = rest.slice(at + term.text.length);
  }
  parts.push(rest);
  return parts;
}
