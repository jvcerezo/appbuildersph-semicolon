import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  ChevronDown,
  ChevronUp,
  Cpu,
  Ghost,
  Headphones,
  Minus,
  PlugZap,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
  Square,
  VolumeX,
  WifiOff,
  X,
} from 'lucide-react';
import type { Card, Status } from '@linaw/contract';
import { ActionBar } from '../components/ActionBar';
import { HelpPanel } from '../components/HelpPanel';
import { JargonCard } from '../components/JargonCard';
import { ListeningAnimation } from '../components/ListeningAnimation';
import { SettingsDialog } from '../components/SettingsDialog';
import { highlightTerms } from '../components/SegmentLine';
import { TranscriptList } from '../components/TranscriptPanel';
import { desktop } from '../lib/desktop';
import { formatClock } from '../lib/format';
import type { Linaw } from '../state/useLinaw';
import './overlay.css';

const STATUS: Record<Status, { label: string; icon: typeof Headphones }> = {
  listening: { label: 'Listening', icon: Headphones },
  offline: { label: 'Offline — still working', icon: WifiOff },
  waiting: { label: 'Waiting for audio', icon: AudioLines },
  stopped: { label: 'Stopped', icon: VolumeX },
};

/**
 * Compact layout that floats over the video. In the desktop shell it is an
 * always-on-top window; in a browser it is the same layout at `?overlay`.
 */
export function OverlayApp({ linaw }: { linaw: Linaw }) {
  const { session, settings } = linaw;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ghost, setGhost] = useState(false);

  useEffect(() => desktop?.onGhostChange(setGhost), []);

  return (
    <div className={ghost ? 'overlay overlay--ghost' : 'overlay'}>
      <OverlayBar linaw={linaw} ghost={ghost} onOpenSettings={() => setSettingsOpen(true)} />

      {ghost && (
        <div className="ov-ghost-hint" role="status">
          <Ghost size={16} aria-hidden="true" />
          Ghost mode · press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> to use Linaw again
        </div>
      )}
      {session.connection === 'closed' && (
        <div className="ov-banner" role="alert">
          <PlugZap size={18} aria-hidden="true" />
          Can’t reach Linaw’s helper. Trying again…
        </div>
      )}
      {session.error && (
        <div className="ov-banner" role="alert">
          {session.error}
        </div>
      )}

      <OverlayLive linaw={linaw} />

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onChange={linaw.setSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

function OverlayBar({ linaw, ghost, onOpenSettings }: { linaw: Linaw; ghost: boolean; onOpenSettings: () => void }) {
  const { session } = linaw;
  const live = session.phase === 'live';

  return (
    <header className="ov-bar">
      <div className="ov-bar__brand">Linaw</div>
      <div className="ov-bar__actions">
        {live && session.status !== 'stopped' && (
          <button type="button" className="ov-icon" aria-label="Stop listening" title="Stop listening" onClick={linaw.stopListening}>
            <Square size={16} aria-hidden="true" />
          </button>
        )}
        {desktop && (
          <button
            type="button"
            className="ov-icon"
            aria-pressed={ghost}
            aria-label="Ghost mode: see-through and click-through (Ctrl+Shift+L)"
            title="Ghost mode (Ctrl+Shift+L)"
            onClick={() => desktop?.setGhost(!ghost)}
          >
            <Ghost size={18} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="ov-icon" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
          <SettingsIcon size={18} aria-hidden="true" />
        </button>
        {desktop ? (
          <>
            <button type="button" className="ov-icon" aria-label="Minimize" title="Minimize" onClick={desktop.minimize}>
              <Minus size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ov-icon"
              aria-label="End session and go back to the library"
              title="End session"
              onClick={() => void linaw.finishSession()}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </>
        ) : (
          <button type="button" className="ov-icon" aria-label="End session" title="End session" onClick={() => void linaw.finishSession()}>
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </div>
    </header>
  );
}

function OverlayLive({ linaw }: { linaw: Linaw }) {
  const { session, settings } = linaw;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [view, setView] = useState<'cards' | 'transcript'>('cards');
  const rowRefs = useRef(new Map<string, HTMLElement>());

  // Tapping a source quote focuses a transcript line: switch to the transcript to show it.
  useEffect(() => {
    if (session.focusedSegment) setView('transcript');
  }, [session.focusedSegment]);

  const explainedIds = useMemo(() => new Set(session.cards.map((c) => c.id)), [session.cards]);
  const [latest, ...earlier] = session.cards;
  const caption = session.segments.at(-1);
  const stopped = session.status === 'stopped';
  const status = STATUS[session.status];
  const timer = (
    <span className="ov-caption__meta">
      <span className={`ov-status ov-status--${session.status}`} role="status">
        <status.icon size={16} aria-hidden="true" />
        {status.label}
      </span>
      {linaw.elapsedSec !== null && (
        <span className="ov-caption__timer" title="Time since you started listening">
          {formatClock(linaw.elapsedSec)}
        </span>
      )}
    </span>
  );

  if (session.help) {
    return (
      <div className="ov-help">
        <HelpPanel
          kind={session.help}
          session={session}
          language={settings.language}
          onAsk={linaw.ask}
          onShowSegment={linaw.showSegment}
          onClose={() => linaw.openHelp(null)}
        />
      </div>
    );
  }

  const showCard = (cardId: string) => {
    setView('cards');
    if (cardId !== latest?.id) setExpanded(cardId);
    requestAnimationFrame(() => rowRefs.current.get(cardId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };

  const fullCard = (card: Card) => (
    <JargonCard
      card={card}
      saved={session.saved.includes(card.id)}
      simplifying={session.simplifying.some((s) => s.cardId === card.id)}
      highlighted={false}
      onReadAloud={linaw.speak}
      onSimplify={linaw.simplify}
      onToggleSaved={linaw.toggleSaved}
    />
  );

  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  };

  return (
    <>
      <section className="ov-caption" aria-label="What is being said now">
        {caption ? (
          <>
            <div className="ov-caption__head">
              <span className="ov-caption__speaker">{caption.speaker}</span>
              {timer}
            </div>
            <p className={caption.final ? 'ov-caption__text' : 'ov-caption__text ov-caption__text--partial'}>
              {highlightTerms(caption, explainedIds, showCard)}
            </p>
            {settings.showTranslation && caption.translation && (
              <p className="ov-caption__translation" lang={caption.translation.language}>
                {caption.translation.text}
              </p>
            )}
          </>
        ) : (
          <div className="ov-caption__head">
            <span className="muted">Words will show here as they are spoken.</span>
            {timer}
          </div>
        )}
      </section>

      <div className="ov-tabs" role="tablist" aria-label="View">
        <button type="button" role="tab" aria-selected={view === 'cards'} className="ov-tab" onClick={() => setView('cards')}>
          Explanations{session.cards.length > 0 && <span className="ov-tab__count">{session.cards.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'transcript'}
          className="ov-tab"
          onClick={() => setView('transcript')}
        >
          Transcript{session.segments.length > 0 && <span className="ov-tab__count">{session.segments.length}</span>}
        </button>
      </div>

      {view === 'transcript' ? (
        <div className="ov-transcript" role="tabpanel" aria-label="Transcript">
          <TranscriptList
            segments={session.segments}
            explainedIds={explainedIds}
            status={session.status}
            stoppedAtSec={linaw.stoppedAtSec}
            showTranslation={settings.showTranslation}
            focusedSegment={session.focusedSegment}
            onTermClick={showCard}
          />
        </div>
      ) : (
        <div className="ov-scroll" role="tabpanel" aria-label="Explanations">
          {stopped && (
            <div className="ov-stopped" role="alert">
              <VolumeX size={22} aria-hidden="true" />
              <div className="ov-stopped__text">
                <strong>Audio stopped</strong>
                <span>Your cards are kept.</span>
              </div>
              <button type="button" className="outline-button" onClick={() => void linaw.finishSession()}>
                Finish
              </button>
              <button type="button" className="solid-button" onClick={linaw.reconnect}>
                <RefreshCw size={18} aria-hidden="true" />
                Reconnect
              </button>
            </div>
          )}

          {session.pending.map((p) => (
            <div key={p.id} className="ov-pending" aria-busy="true">
              <AudioLines size={18} aria-hidden="true" />
              Explaining “{p.term}”…
            </div>
          ))}

          {latest ? (
            <div ref={register(latest.id)} className={stopped ? 'ov-latest ov-dimmed' : 'ov-latest'}>
              {fullCard(latest)}
            </div>
          ) : (
            session.pending.length === 0 &&
            !stopped && (
              <div className="ov-waiting">
                <ListeningAnimation />
                <p>
                  {session.status === 'waiting'
                    ? 'Waiting for audio… Play the hearing and explanations will appear here.'
                    : 'Listening. Explanations appear when a hard word comes up.'}
                </p>
              </div>
            )
          )}

          {earlier.length > 0 && (
            <div className={stopped ? 'ov-earlier ov-dimmed' : 'ov-earlier'}>
              <h2 className="eyebrow">Earlier terms ({earlier.length})</h2>
              {earlier.map((card) => {
                const open = expanded === card.id;
                return (
                  <div key={card.id} ref={register(card.id)} className="ov-row-wrap">
                    <button
                      type="button"
                      className="ov-row"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : card.id)}
                    >
                      {card.kind === 'ai' ? (
                        <Cpu size={18} aria-label="AI-explained" />
                      ) : (
                        <ShieldCheck size={18} aria-label="Checked" />
                      )}
                      <span className="ov-row__term">{card.term}</span>
                      <span className="ov-row__time">{formatClock(card.t)}</span>
                      {open ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
                    </button>
                    {open && fullCard(card)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <ActionBar onOpen={linaw.openHelp} disabled={session.connection !== 'open'} />

      <div className="visually-hidden" aria-live="polite">
        {latest ? `New explanation: ${latest.term}` : ''}
      </div>
    </>
  );
}
