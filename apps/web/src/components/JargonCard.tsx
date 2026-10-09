import { forwardRef } from 'react';
import { AudioLines, Bookmark, BookmarkCheck, Cpu, ShieldCheck, Text, Volume2 } from 'lucide-react';
import type { Card } from '@linaw/contract';
import { formatClock } from '../lib/format';

interface JargonCardProps {
  card: Card;
  saved: boolean;
  simplifying: boolean;
  highlighted: boolean;
  onReadAloud: (card: Card) => void;
  /** Omit where the backend can't be asked (past sessions); hides "Simpler". */
  onSimplify?: (card: Card) => void;
  onToggleSaved: (card: Card) => void;
}

export const JargonCard = forwardRef<HTMLElement, JargonCardProps>(function JargonCard(
  { card, saved, simplifying, highlighted, onReadAloud, onSimplify, onToggleSaved },
  ref,
) {
  const ai = card.kind === 'ai';
  const className = ['card', ai ? 'card--ai' : 'card--checked', highlighted ? 'card--highlighted' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <article ref={ref} className={className} aria-labelledby={`${card.id}-term`} tabIndex={-1}>
      <header className="card__header">
        <h3 id={`${card.id}-term`} className="card__term">
          {card.term}
        </h3>
        <div className="card__meta">
          {ai ? (
            <span className="badge badge--ai" title="Explained by AI. Double-check important details.">
              <Cpu size={16} aria-hidden="true" />
              AI-explained
            </span>
          ) : (
            <span className="badge" title="From Linaw's checked glossary">
              <ShieldCheck size={16} aria-hidden="true" />
              Checked
            </span>
          )}
          <span className="card__time">{formatClock(card.t)}</span>
        </div>
      </header>

      <section className="card__section">
        <div className="eyebrow">Meaning</div>
        <p lang={card.language} className="card__meaning">
          {card.meaning}
        </p>
        {card.basis && <CardBasis card={card} className="card__basis" />}
      </section>
      <section className="card__section">
        <div className="eyebrow">Example</div>
        <p lang={card.language} className="card__example">
          {card.example}
        </p>
      </section>
      <section className="card__section card__now">
        <div className="eyebrow">Right now</div>
        <p lang={card.language}>{card.now}</p>
      </section>

      <footer className="card__actions">
        <button type="button" className="ghost-button" onClick={() => onReadAloud(card)}>
          <Volume2 size={20} aria-hidden="true" />
          Read aloud
        </button>
        {onSimplify && (
          <button type="button" className="ghost-button" onClick={() => onSimplify(card)} disabled={simplifying}>
            {simplifying ? <AudioLines size={20} aria-hidden="true" /> : <Text size={20} aria-hidden="true" />}
            {simplifying ? 'Making it simpler…' : 'Simpler'}
          </button>
        )}
        <button type="button" className="ghost-button" aria-pressed={saved} onClick={() => onToggleSaved(card)}>
          {saved ? <BookmarkCheck size={20} aria-hidden="true" /> : <Bookmark size={20} aria-hidden="true" />}
          {saved ? 'Saved' : 'Save'}
        </button>
      </footer>
    </article>
  );
});

const BASIS_LABEL: Record<Card['language'], string> = { tl: 'Batayan:', en: 'Based on:' };

/**
 * The law a card's meaning rests on, e.g. "Rules on Evidence, Rule 130, Sec. 37". The label is in the
 * card's language; the citation is left as the backend wrote it (Philippine laws are cited in English).
 */
export function CardBasis({ card, className }: { card: Card; className: string }) {
  if (!card.basis) return null;
  return (
    <span className={className}>
      <span lang={card.language} className="basis__label">
        {BASIS_LABEL[card.language]}
      </span>{' '}
      {card.basis}
    </span>
  );
}

export function PendingCard({ term }: { term: string }) {
  return (
    <div className="card card--pending" aria-busy="true">
      <div className="card__pending-head">
        <div className="skeleton skeleton--title" aria-hidden="true" />
        <div className="card__pending-label">
          <AudioLines size={18} aria-hidden="true" />
          Explaining “{term}”…
        </div>
      </div>
      <div className="skeleton-group" aria-hidden="true">
        <div className="skeleton skeleton--eyebrow" />
        <div className="skeleton skeleton--line" />
        <div className="skeleton skeleton--line skeleton--short" />
      </div>
    </div>
  );
}
