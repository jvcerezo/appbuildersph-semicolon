import { Quote } from 'lucide-react';
import { formatClock } from '../lib/format';
import type { Segment } from '../state/session';

interface SourcesProps {
  ids: string[] | undefined;
  segments: ReadonlyMap<string, Segment>;
  onShow: (segmentId: string) => void;
  /** Quote the line in the user's language when a translation exists. */
  preferTranslation: boolean;
}

/**
 * The transcript lines a summary or answer is based on. Each one is quoted
 * and opens the transcript at that line, so users can check the claim.
 */
export function Sources({ ids, segments, onShow, preferTranslation }: SourcesProps) {
  const found = (ids ?? []).flatMap((id) => {
    const segment = segments.get(id);
    return segment ? [segment] : [];
  });
  if (found.length === 0) return null;

  return (
    <div className="sources">
      <div className="sources__label">
        <Quote size={14} aria-hidden="true" />
        {found.length === 1 ? 'Source' : `Sources (${found.length})`}
      </div>
      <ul className="sources__list">
        {found.map((segment) => {
          const quote = preferTranslation && segment.translation ? segment.translation : null;
          return (
            <li key={segment.id}>
              <button
                type="button"
                className="source"
                onClick={() => onShow(segment.id)}
                aria-label={`Show in transcript: ${segment.speaker} at ${formatClock(segment.t)}`}
              >
                <span className="source__meta">
                  {formatClock(segment.t)} · {segment.speaker}
                </span>
                <span className="source__quote" lang={quote?.language}>
                  “{quote?.text ?? segment.text}”
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
