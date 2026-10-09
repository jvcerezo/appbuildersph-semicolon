import { useEffect, useRef } from 'react';
import { AudioLines, PanelRightClose, VolumeX } from 'lucide-react';
import type { Status } from '@linaw/contract';
import { formatClock } from '../lib/format';
import type { Segment } from '../state/session';
import { SegmentLine } from './SegmentLine';

interface TranscriptListProps {
  segments: Segment[];
  explainedIds: ReadonlySet<string>;
  status: Status;
  stoppedAtSec: number | null;
  showTranslation: boolean;
  focusedSegment: string | null;
  onTermClick: (cardId: string) => void;
}

/**
 * The full transcript. Follows new lines as they arrive, unless a line is
 * focused (e.g. from a source quote), which it scrolls to and highlights.
 */
export function TranscriptList({
  segments,
  explainedIds,
  status,
  stoppedAtSec,
  showTranslation,
  focusedSegment,
  onTermClick,
}: TranscriptListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (focusedSegment) return;
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [segments, focusedSegment]);

  useEffect(() => {
    if (focusedSegment) lineRefs.current.get(focusedSegment)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusedSegment]);

  return (
    <div className="transcript__body">
      {segments.length === 0 ? (
        <p className="muted">Words will show here as they are spoken.</p>
      ) : (
        segments.map((segment) => (
          <SegmentLine
            key={segment.id}
            ref={(el) => {
              if (el) lineRefs.current.set(segment.id, el);
              else lineRefs.current.delete(segment.id);
            }}
            segment={segment}
            explainedIds={explainedIds}
            showTranslation={showTranslation}
            highlighted={segment.id === focusedSegment}
            onTermClick={onTermClick}
          />
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
  );
}

interface TranscriptPanelProps extends TranscriptListProps {
  onHide: () => void;
}

export function TranscriptPanel({ onHide, ...list }: TranscriptPanelProps) {
  return (
    <aside className="transcript" aria-label="Live transcript">
      <div className="panel-header">
        <h2 className="panel-header__title">Live transcript</h2>
        <button type="button" className="outline-button" onClick={onHide}>
          <PanelRightClose size={18} aria-hidden="true" />
          Hide transcript
        </button>
      </div>
      <TranscriptList {...list} />
    </aside>
  );
}
