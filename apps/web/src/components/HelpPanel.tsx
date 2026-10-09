import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AudioLines, Mic, Send, Square, X } from 'lucide-react';
import type { Language } from '@linaw/contract';
import { formatClock } from '../lib/format';
import { MAX_QUESTION_SEC, recordQuestion, type VoiceRecording } from '../lib/voice';
import type { HelpKind, Segment, SessionState } from '../state/session';
import { Sources } from './Sources';

const TITLES: Record<HelpKind, string> = {
  what_said: 'What did they say?',
  summary: 'Summary',
  ask: 'Ask a question',
};

const SUGGESTIONS = [
  'Ano ang mangyayari pagkatapos?',
  'Bakit may objection?',
  'Sino ang nagsasalita ngayon?',
  'Ano ang ibig sabihin ng impeachment?',
];

interface HelpPanelProps {
  kind: HelpKind;
  session: SessionState;
  language: Language;
  onAsk: (question: string) => void;
  /** Push to talk: a recorded question. */
  onAskAloud: (clip: Blob, mimeType: string) => void;
  /** Shows a problem (e.g. no microphone) in the usual error banner. */
  onError: (message: string) => void;
  onShowSegment: (segmentId: string) => void;
  onClose: () => void;
}

/** What each view needs to quote its sources. */
interface SourceProps {
  session: SessionState;
  language: Language;
  segments: ReadonlyMap<string, Segment>;
  onShowSegment: (segmentId: string) => void;
}

export function HelpPanel({ kind, session, language, onAsk, onAskAloud, onError, onShowSegment, onClose }: HelpPanelProps) {
  const segments = useMemo(() => new Map(session.segments.map((s) => [s.id, s])), [session.segments]);
  const shared = { session, language, segments, onShowSegment };
  return (
    <aside className="help" aria-labelledby="help-title">
      <div className="panel-header">
        <h2 id="help-title" className="panel-header__title">
          {TITLES[kind]}
        </h2>
        <button type="button" className="outline-button" onClick={onClose}>
          <X size={18} aria-hidden="true" />
          Close
        </button>
      </div>
      {kind === 'what_said' && <WhatSaid {...shared} />}
      {kind === 'summary' && <Summary {...shared} />}
      {kind === 'ask' && <Ask {...shared} onAsk={onAsk} onAskAloud={onAskAloud} onError={onError} />}
    </aside>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="help__loading" role="status">
      <AudioLines size={20} aria-hidden="true" />
      {label}
    </div>
  );
}

function WhatSaid({ session, language, segments, onShowSegment }: SourceProps) {
  const { whatSaid } = session;
  if (whatSaid.state !== 'done') return <Loading label="Looking back at what was said…" />;
  const minutes = Math.round(whatSaid.value.windowSec / 60);
  return (
    <div className="help__body">
      <div className="eyebrow">The last {minutes} minutes</div>
      <ol className="points" lang={language}>
        {whatSaid.value.points.map((point, i) => (
          <li key={i}>{point}</li>
        ))}
      </ol>
      <Sources ids={whatSaid.value.sources} segments={segments} onShow={onShowSegment} preferTranslation />
    </div>
  );
}

function Summary({ session, language, segments, onShowSegment }: SourceProps) {
  const { summary } = session;
  if (summary.state !== 'done') return <Loading label="Writing a summary…" />;
  const { overview, events, openIssue } = summary.value;
  return (
    <div className="help__body">
      <div className="eyebrow">Today so far</div>
      <p className="help__overview" lang={language}>
        {overview}
      </p>
      <ol className="timeline" lang={language}>
        {events.map((event) => (
          <li key={`${event.t}-${event.title}`}>
            <span className="timeline__time">{formatClock(event.t)}</span>
            <div>
              <div className="timeline__title">{event.title}</div>
              <div className="timeline__detail">{event.detail}</div>
              <Sources ids={event.sources} segments={segments} onShow={onShowSegment} preferTranslation />
            </div>
          </li>
        ))}
      </ol>
      {openIssue && (
        <div className="card__now" lang={language}>
          <div className="eyebrow">Still open</div>
          <p>{openIssue}</p>
        </div>
      )}
    </div>
  );
}

function Ask({
  session,
  language,
  segments,
  onShowSegment,
  onAsk,
  onAskAloud,
  onError,
}: SourceProps & Pick<HelpPanelProps, 'onAsk' | 'onAskAloud' | 'onError'>) {
  const [draft, setDraft] = useState('');
  const talk = usePushToTalk(onAskAloud, onError);
  const endRef = useRef<HTMLDivElement>(null);
  const waiting = session.questions.some((q) => q.answer === undefined);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [session.questions]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const question = draft.trim();
    if (!question || waiting) return;
    onAsk(question);
    setDraft('');
  };

  return (
    <>
      <div className="help__body help__body--chat">
        {session.questions.length === 0 ? (
          <div className="ask-empty">
            <div>
              <div className="ask-empty__title">Ask anything about the hearing.</div>
              <div className="muted">Type or tap the microphone and ask out loud, in Tagalog or English. Or tap a question below.</div>
            </div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" lang="tl" className="suggestion" onClick={() => onAsk(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          session.questions.map((q) => (
            <div key={q.requestId} className="qa">
              <div className="qa__question">
                {q.voice ? (
                  q.question ? (
                    <>
                      <Mic size={16} aria-label="Asked out loud:" /> {q.question}
                    </>
                  ) : (
                    <span className="muted">Listening to your question…</span>
                  )
                ) : (
                  q.question
                )}
              </div>
              {q.answer ? (
                <>
                  <p className="qa__answer" lang={language}>
                    {q.answer}
                  </p>
                  <Sources ids={q.sources} segments={segments} onShow={onShowSegment} preferTranslation />
                </>
              ) : (
                <Loading label="Thinking…" />
              )}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
      <form className="ask-form" onSubmit={submit}>
        <label htmlFor="ask-input" className="visually-hidden">
          Your question
        </label>
        <input
          id="ask-input"
          className="ask-form__input"
          placeholder={talk.recording ? 'Listening… tap Done when you finish' : 'Type your question'}
          disabled={talk.recording}
          value={draft}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
        />
        <button
          type="button"
          className={`mic-button${talk.recording ? ' mic-button--on' : ''}`}
          aria-pressed={talk.recording}
          disabled={waiting && !talk.recording}
          onClick={talk.toggle}
        >
          {talk.recording ? <Square size={20} aria-hidden="true" /> : <Mic size={22} aria-hidden="true" />}
          {talk.recording ? `Done ${talk.seconds}s` : 'Speak'}
        </button>
        <button type="submit" className="solid-button solid-button--tall" disabled={!draft.trim() || waiting || talk.recording}>
          <Send size={20} aria-hidden="true" />
          Ask
        </button>
      </form>
    </>
  );
}

/**
 * Tap to start, tap again to send. Recording turns the speakers down (desktop app) so the mic hears
 * the user, and stops by itself at the length limit.
 */
function usePushToTalk(onAskAloud: HelpPanelProps['onAskAloud'], onError: HelpPanelProps['onError']) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const active = useRef<VoiceRecording | null>(null);
  const starting = useRef(false);

  const finish = async () => {
    const rec = active.current;
    active.current = null;
    setRecording(false);
    if (!rec) return;
    const clip = await rec.finish();
    if (clip.size > 0) onAskAloud(clip, rec.mimeType);
  };

  const start = async () => {
    if (starting.current) return;
    starting.current = true;
    try {
      active.current = await recordQuestion(() => void finish());
      setSeconds(0);
      setRecording(true);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Linaw can’t use the microphone.');
    } finally {
      starting.current = false;
    }
  };

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setSeconds((s) => Math.min(s + 1, MAX_QUESTION_SEC)), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  // Closing the panel mid-question throws the recording away and gives the volume back.
  useEffect(() => () => active.current?.cancel(), []);

  return { recording, seconds, toggle: () => void (recording ? finish() : start()) };
}
