import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Card } from '@linaw/contract';
import { captureFile, captureScreenAudio, startRecorder, type AudioSource, type Recorder } from '../lib/audio';
import { newRequestId } from '../lib/format';
import { historyStore, newId, type SessionRecord } from '../lib/history';
import { loadSettings, saveSettings, SPEECH_RATE, TEXT_SCALE, toPreferences, type Settings } from '../lib/settings';
import { BackendSocket } from '../lib/socket';
import { readAloud, stopReading } from '../lib/speech';
import { initialSession, sessionReducer, type HelpKind, type SessionState } from './session';

const WHAT_SAID_WINDOW_SEC = 120;
const FOCUS_MS = 6000;
const AUTOSAVE_MS = 800;

/** What the library shows when no session is live. */
export type LibraryView = { page: 'home' } | { page: 'session'; id: string };

export type SourceRequest = { kind: 'tab' } | { kind: 'system' } | { kind: 'file'; file: File };
type SourceKind = SourceRequest['kind'];

/**
 * Everything Linaw does, independent of layout: the backend socket, audio
 * capture, settings and user actions. The full-page app and the overlay
 * are two views over this one hook.
 */
export function useLinaw() {
  const [session, dispatch] = useReducer(sessionReducer, initialSession);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const now = useNow(session.phase === 'live' && session.status !== 'stopped');

  const socket = useRef<BackendSocket | null>(null);
  const capture = useRef<{ source: AudioSource; recorder: Recorder; kind: SourceKind } | null>(null);
  const lastSource = useRef<SourceRequest>({ kind: 'tab' });
  const focusTimer = useRef<number | undefined>(undefined);
  /** The final summary requested when a session is finished, to store when it arrives. */
  const pendingSummary = useRef<{ recordId: string; requestId: string } | null>(null);
  const [libraryView, setLibraryView] = useState<LibraryView>({ page: 'home' });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // ---- backend connection
  useEffect(() => {
    const backend = new BackendSocket(
      (message) => {
        const pending = pendingSummary.current;
        if (pending && 'requestId' in message && message.requestId === pending.requestId) {
          pendingSummary.current = null;
          if (message.type === 'summary.result') {
            const { overview, events, openIssue } = message;
            void historyStore.update(pending.recordId, (r) => ({ ...r, summary: { overview, events, openIssue, at: Date.now() } }));
          }
          return;
        }
        dispatch({ type: 'server', message });
      },
      (state) => {
        dispatch({ type: 'connection', state });
        // The backend forgets the session when the socket drops; announce it again.
        const active = capture.current;
        if (state === 'open' && active) {
          backend.send({
            type: 'session.start',
            source: active.kind,
            mimeType: active.recorder.mimeType,
            preferences: toPreferences(settingsRef.current),
          });
        }
      },
    );
    socket.current = backend;
    return () => {
      backend.dispose();
      socket.current = null;
    };
  }, []);

  // ---- settings: persist, apply to the page, tell the backend
  useEffect(() => {
    saveSettings(settings);
    const root = document.documentElement;
    root.dataset.theme = settings.highContrast ? 'hc' : 'light';
    root.style.setProperty('--text-scale', String(TEXT_SCALE[settings.textSize]));
  }, [settings]);

  useEffect(() => {
    socket.current?.send({ type: 'preferences.update', preferences: { level: settings.level, language: settings.language } });
  }, [settings.level, settings.language]);

  // ---- audio
  const stopCapture = useCallback(() => {
    const active = capture.current;
    if (!active) return;
    capture.current = null;
    active.recorder.stop();
    active.source.release();
  }, []);

  useEffect(() => stopCapture, [stopCapture]);

  const startListening = useCallback(
    async (request: SourceRequest) => {
      const backend = socket.current;
      if (!backend || session.connection !== 'open') {
        dispatch({ type: 'error', message: 'Linaw’s helper is not running on this computer yet. Start it, then try again.' });
        return;
      }
      stopCapture();
      lastSource.current = request;

      let source: AudioSource;
      try {
        source = request.kind === 'file' ? await captureFile(request.file) : await captureScreenAudio();
      } catch (err) {
        // NotAllowedError = the user closed the share window; nothing to report.
        if (err instanceof DOMException && err.name === 'NotAllowedError') return;
        dispatch({ type: 'error', message: err instanceof Error ? err.message : 'Could not start listening.' });
        return;
      }

      const recorder = startRecorder(
        source.stream,
        (chunk) => socket.current?.sendAudio(chunk),
        () => {
          // Sharing stopped or the file finished.
          stopCapture();
          socket.current?.send({ type: 'session.stop' });
          dispatch({ type: 'listening.stopped' });
        },
      );
      capture.current = { source, recorder, kind: request.kind };
      backend.send({
        type: 'session.start',
        source: request.kind,
        mimeType: recorder.mimeType,
        preferences: toPreferences(settingsRef.current),
      });
      dispatch({ type: 'listening.started', recordId: newId('session') });
    },
    [session.connection, stopCapture],
  );

  const stopListening = () => {
    if (!capture.current) return;
    stopCapture();
    socket.current?.send({ type: 'session.stop' });
    dispatch({ type: 'listening.stopped' });
  };

  /** Tab and system audio restart in place; a file has to be picked again from the library. */
  const reconnect = () => {
    const last = lastSource.current;
    if (last.kind === 'file') void finishSession();
    else void startListening(last);
  };

  // ---- saving: the live session is written to the library as it goes
  const { startedAt, stoppedAt } = session;
  const elapsedSec = startedAt === null ? null : ((stoppedAt ?? now) - startedAt) / 1000;
  const toRecord = (s: SessionState, endedAt: number | null): SessionRecord | null =>
    s.recordId === null || s.startedAt === null
      ? null
      : {
          id: s.recordId,
          title: s.title === initialSession.title ? defaultTitle(s.startedAt) : s.title,
          startedAt: s.startedAt,
          endedAt,
          durationSec: Math.round(((s.stoppedAt ?? endedAt ?? Date.now()) - s.startedAt) / 1000),
          source: lastSource.current.kind,
          segments: s.segments,
          cards: s.cards,
          saved: s.saved,
          summary: s.summary.state === 'done' ? { ...s.summary.value, at: Date.now() } : undefined,
        };

  useEffect(() => {
    if (session.phase !== 'live') return;
    const timer = window.setTimeout(() => {
      const record = toRecord(session, null);
      if (record) historyStore.put(record).catch((err) => console.warn('[linaw] autosave failed:', err));
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
    // Save when content changes, not on every clock tick.
  }, [session.phase, session.recordId, session.title, session.segments, session.cards, session.saved, session.summary, session.status]);

  /** End the live session: save it, ask for a final summary, and open it in the library. */
  const finishSession = async () => {
    if (capture.current) {
      stopCapture();
      socket.current?.send({ type: 'session.stop' });
    }
    const record = toRecord(session, Date.now());
    if (record) {
      try {
        await historyStore.put(record);
      } catch (err) {
        console.warn('[linaw] could not save the session:', err);
      }
      const requestId = newRequestId();
      if (record.segments.length > 0 && socket.current?.send({ type: 'summary.request', requestId })) {
        pendingSummary.current = { recordId: record.id, requestId };
      }
      setLibraryView({ page: 'session', id: record.id });
    }
    dispatch({ type: 'session.reset' });
  };

  // ---- help and cards
  const openHelp = (kind: HelpKind | null) => {
    dispatch({ type: 'help.open', kind });
    if (kind === 'what_said') {
      const requestId = newRequestId();
      dispatch({ type: 'what_said.requested', requestId });
      socket.current?.send({ type: 'what_said.request', requestId, windowSec: WHAT_SAID_WINDOW_SEC });
    } else if (kind === 'summary') {
      const requestId = newRequestId();
      dispatch({ type: 'summary.requested', requestId });
      socket.current?.send({ type: 'summary.request', requestId });
    }
  };

  const ask = (question: string) => {
    const requestId = newRequestId();
    dispatch({ type: 'ask.requested', requestId, question });
    socket.current?.send({ type: 'ask', requestId, question });
  };

  const simplify = (card: Card) => {
    const requestId = newRequestId();
    dispatch({ type: 'simplify.requested', cardId: card.id, requestId });
    socket.current?.send({ type: 'card.simplify', requestId, cardId: card.id });
  };

  const speak = (card: Card) => {
    stopReading();
    readAloud(`${card.term}. ${card.meaning} ${card.example}`, card.language, SPEECH_RATE[settings.readSpeed]);
  };

  return {
    session,
    settings,
    setSettings,
    elapsedSec,
    stoppedAtSec: startedAt !== null && stoppedAt !== null ? (stoppedAt - startedAt) / 1000 : null,
    startListening,
    stopListening,
    reconnect,
    finishSession,
    libraryView,
    setLibraryView,
    clearError: () => dispatch({ type: 'error', message: null }),
    openHelp,
    ask,
    simplify,
    speak,
    toggleSaved: (card: Card) => dispatch({ type: 'card.toggleSaved', cardId: card.id }),
    /** Close any help sheet and show this transcript line (used by source quotes). */
    showSegment: (segmentId: string | null) => {
      window.clearTimeout(focusTimer.current);
      dispatch({ type: 'segment.focus', segmentId });
      if (!segmentId) return;
      setSettings((s) => (s.showTranscript ? s : { ...s, showTranscript: true }));
      // Keep the highlight long enough to find the line, then resume following new lines.
      focusTimer.current = window.setTimeout(() => dispatch({ type: 'segment.focus', segmentId: null }), FOCUS_MS);
    },
  };
}

function defaultTitle(startedAt: number): string {
  const when = new Date(startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `Hearing — ${when}`;
}

export type Linaw = ReturnType<typeof useLinaw>;

/** Current time, refreshed every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
