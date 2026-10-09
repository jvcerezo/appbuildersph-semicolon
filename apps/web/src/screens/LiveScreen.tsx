import { useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, History, PanelRightOpen, RefreshCw, VolumeX } from 'lucide-react';
import type { Card, Language } from '@linaw/contract';
import { ActionBar } from '../components/ActionBar';
import { HelpPanel } from '../components/HelpPanel';
import { JargonCard, PendingCard } from '../components/JargonCard';
import { ListeningAnimation } from '../components/ListeningAnimation';
import { TranscriptPanel } from '../components/TranscriptPanel';
import type { HelpKind, SessionState } from '../state/session';

/** Cards shown in full; older ones collapse under "Earlier terms". */
const RECENT_CARDS = 3;
const HIGHLIGHT_MS = 2000;

interface LiveScreenProps {
  session: SessionState;
  language: Language;
  showTranscript: boolean;
  showTranslation: boolean;
  stoppedAtSec: number | null;
  onShowTranscript: (show: boolean) => void;
  onOpenHelp: (kind: HelpKind | null) => void;
  onAsk: (question: string) => void;
  onAskAloud: (clip: Blob, mimeType: string) => void;
  preparingVoiceId: string | null;
  onError: (message: string) => void;
  onShowSegment: (segmentId: string) => void;
  onReadAloud: (card: Card) => void;
  speakingCardId: string | null;
  onSimplify: (card: Card) => void;
  onToggleSaved: (card: Card) => void;
  onReconnect: () => void;
  onFinish: () => void;
}

export function LiveScreen(props: LiveScreenProps) {
  const { session, language, showTranscript, stoppedAtSec } = props;
  const [showEarlier, setShowEarlier] = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());

  const explainedIds = useMemo(() => new Set(session.cards.map((c) => c.id)), [session.cards]);
  const stopped = session.status === 'stopped';
  const isEmpty = session.cards.length === 0 && session.pending.length === 0;
  const recent = session.cards.slice(0, RECENT_CARDS);
  const earlier = session.cards.slice(RECENT_CARDS);
  const latest = session.cards[0];

  const focusCard = (cardId: string) => {
    if (session.cards.findIndex((c) => c.id === cardId) >= RECENT_CARDS) setShowEarlier(true);
    // Wait a frame so an expanded "Earlier terms" list is in the DOM.
    requestAnimationFrame(() => {
      const el = cardRefs.current.get(cardId);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.focus({ preventScroll: true });
    });
    setHighlighted(cardId);
    window.setTimeout(() => setHighlighted((current) => (current === cardId ? null : current)), HIGHLIGHT_MS);
  };

  const renderCard = (card: Card) => (
    <JargonCard
      key={card.id}
      ref={(el) => {
        if (el) cardRefs.current.set(card.id, el);
        else cardRefs.current.delete(card.id);
      }}
      card={card}
      saved={session.saved.includes(card.id)}
      simplifying={session.simplifying.some((s) => s.cardId === card.id)}
      speaking={props.speakingCardId === card.id}
      highlighted={highlighted === card.id}
      onReadAloud={props.onReadAloud}
      onSimplify={props.onSimplify}
      onToggleSaved={props.onToggleSaved}
    />
  );

  const side = session.help ? (
    <HelpPanel
      kind={session.help}
      session={session}
      language={language}
      onAsk={props.onAsk}
      onAskAloud={props.onAskAloud}
      onError={props.onError}
      onShowSegment={props.onShowSegment}
      preparingVoiceId={props.preparingVoiceId}
      onClose={() => props.onOpenHelp(null)}
    />
  ) : showTranscript ? (
    <TranscriptPanel
      segments={session.segments}
      explainedIds={explainedIds}
      status={session.status}
      stoppedAtSec={stoppedAtSec}
      showTranslation={props.showTranslation}
      focusedSegment={session.focusedSegment}
      onHide={() => props.onShowTranscript(false)}
      onTermClick={focusCard}
    />
  ) : null;

  return (
    <div className={side ? 'live' : 'live live--single'}>
      <div className="live__main">
        {isEmpty && !stopped ? (
          <div className="waiting">
            <ListeningAnimation />
            <div className="waiting__text">
              <h2 className="waiting__title">{session.status === 'waiting' ? 'Waiting for audio…' : 'Listening…'}</h2>
              <p className="waiting__hint">
                {session.status === 'waiting'
                  ? 'Play the hearing in your shared tab. Explanations will appear here as soon as someone speaks.'
                  : 'Explanations will appear here when a hard word comes up.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="cards-scroll">
            <div className="cards">
              {stopped && (
                <div className="alert" role="alert">
                  <div className="alert__icon" aria-hidden="true">
                    <VolumeX size={28} />
                  </div>
                  <div className="alert__text">
                    <div className="alert__title">Audio sharing stopped</div>
                    <div className="alert__hint">Your cards are kept. Reconnect to keep listening, or finish to save this session.</div>
                  </div>
                  <button type="button" className="outline-button outline-button--tall" onClick={props.onFinish}>
                    Finish session
                  </button>
                  <button type="button" className="solid-button solid-button--tall" onClick={props.onReconnect}>
                    <RefreshCw size={22} aria-hidden="true" />
                    Reconnect
                  </button>
                </div>
              )}

              <div className="cards__heading">
                <h2 className="eyebrow eyebrow--lg">Explanations</h2>
                <div className="cards__heading-right">
                  <span className="muted">
                    Newest first · {session.cards.length} {session.cards.length === 1 ? 'term' : 'terms'}
                  </span>
                  {!showTranscript && !session.help && (
                    <button type="button" className="outline-button" onClick={() => props.onShowTranscript(true)}>
                      <PanelRightOpen size={18} aria-hidden="true" />
                      Show transcript
                    </button>
                  )}
                </div>
              </div>

              <div className={stopped ? 'cards__list cards__list--dimmed' : 'cards__list'}>
                {session.pending.map((p) => (
                  <PendingCard key={p.id} term={p.term} />
                ))}
                {recent.map(renderCard)}

                {earlier.length > 0 && (
                  <button
                    type="button"
                    className="earlier"
                    aria-expanded={showEarlier}
                    onClick={() => setShowEarlier((v) => !v)}
                  >
                    <History size={24} aria-hidden="true" />
                    <span className="earlier__text">
                      <span className="earlier__title">Earlier terms ({earlier.length})</span>
                      <span className="muted">{describeEarlier(earlier)}</span>
                    </span>
                    <span className="earlier__toggle">
                      {showEarlier ? 'Hide' : 'Show all'}
                      {showEarlier ? <ChevronUp size={20} aria-hidden="true" /> : <ChevronDown size={20} aria-hidden="true" />}
                    </span>
                  </button>
                )}
                {showEarlier && earlier.map(renderCard)}
              </div>
            </div>
          </div>
        )}
        <ActionBar onOpen={(kind) => props.onOpenHelp(kind)} disabled={session.connection !== 'open'} />
      </div>
      {side}

      <div className="visually-hidden" aria-live="polite">
        {latest ? `New explanation: ${latest.term}` : ''}
      </div>
    </div>
  );
}

function describeEarlier(cards: Card[]): string {
  const names = cards.slice(0, 4).map((c) => c.term);
  const more = cards.length - names.length;
  return more > 0 ? `${names.join(', ')}, and ${more} more` : names.join(', ');
}
