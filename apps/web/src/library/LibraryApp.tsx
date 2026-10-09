import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  BookmarkCheck,
  FileText,
  Headphones,
  Info,
  Layers,
  ListOrdered,
  Minus,
  MonitorPlay,
  PlugZap,
  Plus,
  Search,
  Settings as SettingsIcon,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { JargonCard } from '../components/JargonCard';
import { SegmentLine } from '../components/SegmentLine';
import { SettingsDialog } from '../components/SettingsDialog';
import { Sources } from '../components/Sources';
import { desktop } from '../lib/desktop';
import { formatClock } from '../lib/format';
import { historyStore, useSessionHistory, type SessionRecord } from '../lib/history';
import type { Linaw } from '../state/useLinaw';
import './library.css';

/**
 * The app when nothing is live: start a session, browse past sessions, and
 * read or annotate them. In the desktop shell this is a normal window; it
 * turns into the overlay when listening starts.
 */
export function LibraryApp({ linaw }: { linaw: Linaw }) {
  const { session, settings, libraryView, setLibraryView } = linaw;
  const { sessions, loaded } = useSessionHistory();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.cards.some((c) => c.term.toLowerCase().includes(q)),
    );
  }, [sessions, query]);

  const open = libraryView.page === 'session' ? sessions.find((s) => s.id === libraryView.id) : undefined;

  return (
    <div className="lib">
      <header className="lib-bar">
        <div className="lib-bar__brand">Linaw</div>
        <div className="lib-bar__spacer" />
        <button type="button" className="ov-icon" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon size={18} aria-hidden="true" />
        </button>
        {desktop && (
          <>
            <button type="button" className="ov-icon" aria-label="Minimize" title="Minimize" onClick={desktop.minimize}>
              <Minus size={18} aria-hidden="true" />
            </button>
            <button type="button" className="ov-icon" aria-label="Maximize" title="Maximize" onClick={desktop.toggleMaximize}>
              <Square size={15} aria-hidden="true" />
            </button>
            <button type="button" className="ov-icon" aria-label="Quit Linaw" title="Quit" onClick={desktop.close}>
              <X size={18} aria-hidden="true" />
            </button>
          </>
        )}
      </header>

      {session.connection === 'closed' && (
        <div className="banner" role="alert">
          <PlugZap size={20} aria-hidden="true" />
          Can’t reach Linaw’s helper on this computer. You can still read past sessions. Trying again…
        </div>
      )}

      <div className="lib__body">
        <aside className="lib-side" aria-label="Sessions">
          <button
            type="button"
            className={libraryView.page === 'home' ? 'lib-side__new lib-side__new--active' : 'lib-side__new'}
            onClick={() => setLibraryView({ page: 'home' })}
          >
            <Plus size={20} aria-hidden="true" />
            New session
          </button>

          <label className="lib-search">
            <Search size={18} aria-hidden="true" />
            <span className="visually-hidden">Search sessions</span>
            <input
              type="search"
              placeholder="Search sessions and terms"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>

          <nav className="lib-side__list">
            {!loaded ? null : filtered.length === 0 ? (
              <p className="lib-side__empty">
                {sessions.length === 0 ? 'Your past sessions will show up here.' : 'No sessions match your search.'}
              </p>
            ) : (
              groupByDay(filtered).map(([day, items]) => (
                <section key={day}>
                  <h2 className="lib-side__day">{day}</h2>
                  {items.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="lib-item"
                      aria-current={open?.id === s.id ? 'page' : undefined}
                      onClick={() => setLibraryView({ page: 'session', id: s.id })}
                    >
                      <span className="lib-item__title">{s.title}</span>
                      <span className="lib-item__meta">
                        {timeOfDay(s.startedAt)} · {formatDuration(s.durationSec)} · {plural(s.cards.length, 'term')}
                      </span>
                    </button>
                  ))}
                </section>
              ))
            )}
          </nav>
        </aside>

        <main className="lib-main">
          {libraryView.page === 'session' && open ? (
            <SessionView key={open.id} record={open} linaw={linaw} onDeleted={() => setLibraryView({ page: 'home' })} />
          ) : (
            <Home linaw={linaw} sessions={sessions} />
          )}
        </main>
      </div>

      <SettingsDialog open={settingsOpen} settings={settings} onChange={linaw.setSettings} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

// ------------------------------------------------------------------ home

function Home({ linaw, sessions }: { linaw: Linaw; sessions: SessionRecord[] }) {
  const ready = linaw.session.connection === 'open';
  const terms = sessions.reduce((sum, s) => sum + s.cards.length, 0);

  return (
    <div className="lib-home">
      <div className="lib-home__hero">
        <h1 className="lib-home__title">Understand what’s being said.</h1>
        <p className="lib-home__lede">
          Linaw listens to a hearing or trial with you and explains the hard words in simple Tagalog, as they are said.
        </p>
      </div>

      <div className="lib-home__choices">
        <button
          type="button"
          className="choice"
          disabled={!ready}
          onClick={() => void linaw.startListening(desktop ? { kind: 'system' } : { kind: 'tab' })}
        >
          {desktop ? <Headphones size={32} aria-hidden="true" /> : <MonitorPlay size={32} aria-hidden="true" />}
          <span className="choice__title">{desktop ? 'Listen to this computer' : 'Listen to a browser tab'}</span>
          <span className="choice__hint">
            {desktop
              ? 'For a live stream on YouTube, Facebook, a news site, or a video call. Linaw moves to a small window on top of your video.'
              : 'Pick the tab with the hearing and turn on “Share tab audio”.'}
          </span>
          <span className="choice__cta">Start listening</span>
        </button>
      </div>

      {linaw.session.error && (
        <p className="notice" role="alert">
          {linaw.session.error}
        </p>
      )}

      {sessions.length > 0 && (
        <dl className="lib-stats">
          <div>
            <dt>Sessions</dt>
            <dd>{sessions.length}</dd>
          </div>
          <div>
            <dt>Terms explained</dt>
            <dd>{terms}</dd>
          </div>
        </dl>
      )}

      <p className="lib-home__tip">
        <Info size={18} aria-hidden="true" />
        <span>
          While listening, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> to make Linaw see-through so it never blocks
          the video. Everything stays on this computer. Linaw explains terms; it is not legal advice.
        </span>
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ one past session

type Tab = 'summary' | 'transcript' | 'terms';
const SUMMARY_WAIT_MS = 30_000;

function SessionView({ record, linaw, onDeleted }: { record: SessionRecord; linaw: Linaw; onDeleted: () => void }) {
  const [tab, setTab] = useState<Tab>('summary');
  const [title, setTitle] = useState(record.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [savedOnly, setSavedOnly] = useState(false);
  const lineRefs = useRef(new Map<string, HTMLDivElement>());

  const segments = useMemo(() => new Map(record.segments.map((s) => [s.id, s])), [record.segments]);
  const explainedIds = useMemo(() => new Set(record.cards.map((c) => c.id)), [record.cards]);
  const update = (change: (r: SessionRecord) => SessionRecord) => void historyStore.update(record.id, change);

  // Waiting for the summary requested when the session was finished.
  const summaryPending = !record.summary && record.endedAt !== null && Date.now() - record.endedAt < SUMMARY_WAIT_MS;
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!summaryPending) return;
    const timer = window.setTimeout(() => forceTick((n) => n + 1), SUMMARY_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [summaryPending]);

  const showLine = (id: string) => {
    setTab('transcript');
    setFocused(id);
    requestAnimationFrame(() => lineRefs.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };

  const saveTitle = () => {
    const next = title.trim();
    if (next && next !== record.title) update((r) => ({ ...r, title: next }));
    else setTitle(record.title);
  };

  const cards = savedOnly ? record.cards.filter((c) => record.saved.includes(c.id)) : record.cards;
  const tabs: { id: Tab; label: string; icon: typeof FileText; count?: number }[] = [
    { id: 'summary', label: 'Summary', icon: FileText },
    { id: 'transcript', label: 'Transcript', icon: ListOrdered, count: record.segments.length },
    { id: 'terms', label: 'Terms', icon: Layers, count: record.cards.length },
  ];

  return (
    <div className="lib-session">
      <header className="lib-session__head">
        <label className="visually-hidden" htmlFor="session-title">
          Session title
        </label>
        <input
          id="session-title"
          className="lib-session__title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <div className="lib-session__meta">
          <span>{new Date(record.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
          <span>{formatDuration(record.durationSec)} listened</span>
          <span>{record.source === 'file' ? 'From a file' : record.source === 'tab' ? 'From a browser tab' : 'From this computer'}</span>
          {!confirmDelete ? (
            <button type="button" className="lib-session__delete" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={16} aria-hidden="true" />
              Delete session
            </button>
          ) : (
            <span className="lib-session__confirm" role="alert">
              Delete this session and its transcript?
              <button type="button" className="outline-button" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
              <button
                type="button"
                className="solid-button"
                onClick={() => void historyStore.remove(record.id).then(onDeleted)}
              >
                Delete
              </button>
            </span>
          )}
        </div>
      </header>

      <div className="lib-tabs" role="tablist" aria-label="Session">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className="lib-tab"
            onClick={() => setTab(t.id)}
          >
            <t.icon size={18} aria-hidden="true" />
            {t.label}
            {t.count !== undefined && t.count > 0 && <span className="ov-tab__count">{t.count}</span>}
          </button>
        ))}
      </div>

      <div className="lib-session__body" role="tabpanel">
        {tab === 'summary' &&
          (record.summary ? (
            <div className="lib-summary">
              <p className="help__overview" lang={linaw.settings.language}>
                {record.summary.overview}
              </p>
              {record.summary.openIssue && (
                <div className="card__now">
                  <div className="eyebrow">Still open</div>
                  <p>{record.summary.openIssue}</p>
                </div>
              )}
              <ol className="timeline">
                {record.summary.events.map((event) => (
                  <li key={`${event.t}-${event.title}`}>
                    <span className="timeline__time">{formatClock(event.t)}</span>
                    <div>
                      <div className="timeline__title">{event.title}</div>
                      <div className="timeline__detail">{event.detail}</div>
                      <Sources ids={event.sources} segments={segments} onShow={showLine} preferTranslation={linaw.settings.showTranslation} />
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className="lib-empty">
              {summaryPending ? <AudioLines size={28} aria-hidden="true" /> : <FileText size={28} aria-hidden="true" />}
              <p>
                {summaryPending
                  ? 'Writing the summary for this session…'
                  : record.segments.length === 0
                    ? 'Nothing was said in this session.'
                    : 'No summary was saved for this session. Its transcript and terms are still here.'}
              </p>
            </div>
          ))}

        {tab === 'transcript' && (
          <div className="lib-transcript">
            {record.segments.length === 0 ? (
              <div className="lib-empty">
                <ListOrdered size={28} aria-hidden="true" />
                <p>No transcript for this session.</p>
              </div>
            ) : (
              record.segments.map((segment) => (
                <SegmentLine
                  key={segment.id}
                  ref={(el) => {
                    if (el) lineRefs.current.set(segment.id, el);
                    else lineRefs.current.delete(segment.id);
                  }}
                  segment={segment}
                  explainedIds={explainedIds}
                  showTranslation={linaw.settings.showTranslation}
                  highlighted={segment.id === focused}
                  onTermClick={() => setTab('terms')}
                />
              ))
            )}
          </div>
        )}

        {tab === 'terms' && (
          <div className="lib-terms">
            {record.saved.length > 0 && (
              <div className="segmented lib-terms__filter" role="radiogroup" aria-label="Show">
                <button type="button" role="radio" aria-checked={!savedOnly} className="segmented__option" onClick={() => setSavedOnly(false)}>
                  All terms
                </button>
                <button type="button" role="radio" aria-checked={savedOnly} className="segmented__option" onClick={() => setSavedOnly(true)}>
                  <BookmarkCheck size={16} aria-hidden="true" /> Saved
                </button>
              </div>
            )}
            {cards.length === 0 ? (
              <div className="lib-empty">
                <Layers size={28} aria-hidden="true" />
                <p>No terms were explained in this session.</p>
              </div>
            ) : (
              cards.map((card) => (
                <JargonCard
                  key={card.id}
                  card={card}
                  saved={record.saved.includes(card.id)}
                  simplifying={false}
                  highlighted={false}
                  onReadAloud={linaw.speak}
                  onToggleSaved={(c) =>
                    update((r) => ({
                      ...r,
                      saved: r.saved.includes(c.id) ? r.saved.filter((id) => id !== c.id) : [...r.saved, c.id],
                    }))
                  }
                />
              ))
            )}
          </div>
        )}

      </div>
    </div>
  );
}

// ------------------------------------------------------------------ helpers

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function formatDuration(sec: number): string {
  const minutes = Math.round(sec / 60);
  if (minutes < 1) return `${Math.max(0, Math.round(sec))} sec`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "Today", "Yesterday", or a date, newest first. */
function groupByDay(sessions: SessionRecord[]): [string, SessionRecord[]][] {
  const today = new Date();
  const dayKey = (d: Date) => d.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const groups = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    const d = new Date(s.startedAt);
    const label =
      dayKey(d) === dayKey(today)
        ? 'Today'
        : dayKey(d) === dayKey(yesterday)
          ? 'Yesterday'
          : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
    groups.set(label, [...(groups.get(label) ?? []), s]);
  }
  return [...groups];
}
