import { useEffect, useRef, type ReactNode } from 'react';
import { AudioLines, PanelRightClose, VolumeX } from 'lucide-react';
import type { Status } from '@linaw/contract';
import { formatClock } from '../lib/format';
import type { Segment } from '../state/session';

interface TranscriptPanelProps {
  segments: Segment[];
  explainedIds: ReadonlySet<string>;
  status: Status;
  stoppedAtSec: number | null;
  onHide: () => void;
  onTermClick: (cardId: string) => void;
}

export function TranscriptPanel({ segments, explainedIds, status, stoppedAtSec, onHide, onTermClick }: TranscriptPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [segments]);

  return (
    <aside className="transcript" aria-label="Live transcript">
      <div className="panel-header">
        <h2 className="panel-header__title">Live transcript</h2>
        <button type="button" className="outline-button" onClick={onHide}>
          <PanelRightClose size={18} aria-hidden="true" />
          Hide transcript
        </button>
      </div>
      <div className="transcript__body">
        {segments.length === 0 ? (
          <p className="muted">Words will show here as they are spoken.</p>
        ) : (
          segments.map((segment) => (
            <div key={segment.id} className={segment.final ? 'segment' : 'segment segment--partial'}>
              <div className="segment__meta">
                {formatClock(segment.t)} · {segment.speaker}
              </div>
              <div>{highlightTerms(segment, explainedIds, onTermClick)}</div>
            </div>
          ))
        )}
        {status === 'stopped' && stoppedAtSec !== null ? (
          <div className="transcript__stopped">
            <VolumeX size={18} aria-hidden="true" />
            Stopped at {formatClock(stoppedAtSec)}
          </div>
        ) : (
          (status === 'listening' || status === 'offline') && (
            <div className="transcript__listening">
              <AudioLines size={18} aria-hidden="true" />
              Listening…
            </div>
          )
        )}
        <div ref={endRef} />
      </div>
    </aside>
  );
}

/** Underlines each flagged term: solid once its card exists, dotted while pending. */
function highlightTerms(segment: Segment, explainedIds: ReadonlySet<string>, onTermClick: (cardId: string) => void) {
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
