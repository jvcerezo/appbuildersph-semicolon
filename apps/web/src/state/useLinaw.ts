import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Card } from '@linaw/contract';
import { captureFileAudio, captureScreenAudio, startRecorder, type AudioSource, type Recorder } from '../lib/audio';
import { newRequestId } from '../lib/format';
import { historyStore, newId, type SessionRecord } from '../lib/history';
import { loadSettings, saveSettings, SPEECH_RATE, TEXT_SCALE, toPreferences, type Settings } from '../lib/settings';
import { BackendSocket } from '../lib/socket';
import { playCloudAudio, readAloud, stopReading } from '../lib/speech';
import { toBase64 } from '../lib/voice';
import { initialSession, sessionReducer, type HelpKind, type SessionState } from './session';

const WHAT_SAID_WINDOW_SEC = 120;
const FOCUS_MS = 6000;
const AUTOSAVE_MS = 800;
// Soniox's non-streaming TTS call alone measures ~5-6 s for a card-length clip, though the speech
// service has occasionally taken much longer to respond despite Soniox itself succeeding. Kept
// comfortably above the backend's own 30 s fetch timeout (backend/src/tts/client.ts) so a `tts.failed`
// from a real backend timeout is the common path, not a race with this one.
const SPEAK_TIMEOUT_MS = 35000;
// Generous backstop in case a playback promise never settles (a missed/unsupported browser event) —
// mirrors the existing MAX_DUCK_MS safety net in apps/desktop/src/volume.cjs.
const MAX_PLAYBACK_MS = 20000;

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
  /** The one in-flight cloud read-aloud request for a card; resolved by its audio, rejected by `tts.failed` or a timeout. */
  const pendingSpeak = useRef<{ requestId: string; resolve: (blob: Blob) => void; reject: () => void } | null>(null);
  /** Card currently waiting on cloud read-aloud, so its button can show a loading state. */
  const [speakingCardId, setSpeakingCardId] = useState<string | null>(null);
  /** The one in-flight auto-voice request for a QA answer; same shape as pendingSpeak. */
  const pendingAnswerVoice = useRef<{ requestId: string; resolve: (blob: Blob) => void; reject: () => void } | null>(null);
  /** The one in-flight auto-voice request for a "What did they say?" result; same shape as pendingSpeak. */
  const pendingWhatSaidVoice = useRef<{ requestId: string; resolve: (blob: Blob) => void; reject: () => void } | null>(null);
  /** Request (question or "what did they say?") whose voice is being prepared, so its bubble can say
   * "Getting ready to speak…" instead of its usual loading label. */
  const [preparingVoiceId, setPreparingVoiceId] = useState<string | null>(null);
  const [libraryView, setLibraryView] = useState<LibraryView>({ page: 'home' });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const startedAtRef = useRef<number | null>(null);
  startedAtRef.current = session.startedAt;
  /** Closed/open windows, in the same "seconds since session start" basis as transcript.segment's `t`,
   * during which Linaw's own voice (not the hearing) was audible. */
  const suppressWindows = useRef<{ from: number; to: number }[]>([]);

  function elapsedNow(): number | null {
    const startedAt = startedAtRef.current;
    return startedAt === null ? null : (Date.now() - startedAt) / 1000;
  }

  /** Brackets a playback promise with a suppression window, so any transcript segment that lands
   * inside it is almost certainly Linaw's own voice, not the hearing. No-op when not listening. */
  function markPlayback(promise: Promise<void>): void {
    if (capture.current === null) return;
    const from = elapsedNow();
    if (from === null) return;
    const win = { from, to: Infinity };
    suppressWindows.current.push(win);
    const close = () => {
      if (win.to === Infinity) win.to = elapsedNow() ?? win.from;
    };
    const safety = window.setTimeout(close, MAX_PLAYBACK_MS);
    void promise.finally(() => {
      window.clearTimeout(safety);
      close();
      const cutoff = (elapsedNow() ?? 0) - 60;
      suppressWindows.current = suppressWindows.current.filter((w) => w.to > cutoff);
    });
  }

  function isSuppressed(t: number): boolean {
    return suppressWindows.current.some((w) => t >= w.from && t <= w.to);
  }

  type PendingVoice = { requestId: string; resolve: (blob: Blob) => void; reject: () => void };
  const pendingVoiceRefs = [pendingSpeak, pendingAnswerVoice, pendingWhatSaidVoice];

  function resolvePendingVoice(requestId: string, blob: Blob): void {
    for (const ref of pendingVoiceRefs) {
      if (ref.current?.requestId === requestId) {
        const pending = ref.current;
        ref.current = null;
        pending.resolve(blob);
        return;
      }
    }
  }

  function rejectPendingVoice(requestId: string): void {
    for (const ref of pendingVoiceRefs) {
      if (ref.current?.requestId === requestId) {
        const pending = ref.current;
        ref.current = null;
        pending.reject();
        return;
      }
    }
  }

  /**
   * Holds `reveal` back until Linaw's own voice is ready (cloud TTS, or the on-device fallback once
   * that's decided) so text and voice arrive together, falling back on failure, "not connected", or a
   * timeout. Shared by QA answers and "What did they say?" results.
   */
  function autoVoice(requestId: string, text: string, pendingRef: { current: PendingVoice | null }, reveal: () => void): void {
    if (!settingsRef.current.autoVoiceAnswers) {
      reveal();
      return;
    }
    const rate = SPEECH_RATE[settingsRef.current.readSpeed];
    const fallback = () => readAloud(text, settingsRef.current.language, rate);
    if (!socket.current?.send({ type: 'tts.request', requestId, text, language: settingsRef.current.language })) {
      reveal(); // not connected; reveal with the on-device voice right away
      markPlayback(fallback());
      return;
    }
    setPreparingVoiceId(requestId);
    const timer = window.setTimeout(() => {
      if (pendingRef.current?.requestId === requestId) {
        pendingRef.current = null;
        setPreparingVoiceId(null);
        reveal();
        markPlayback(fallback());
      }
    }, SPEAK_TIMEOUT_MS);
    pendingRef.current = {
      requestId,
      resolve: (blob) => {
        window.clearTimeout(timer);
        setPreparingVoiceId(null);
        reveal();
        markPlayback(playCloudAudio(blob, rate).catch(fallback));
      },
      reject: () => {
        window.clearTimeout(timer);
        setPreparingVoiceId(null);
        reveal();
        markPlayback(fallback());
      },
    };
  }

  // ---- backend connection
  useEffect(() => {
    const backend = new BackendSocket(
      (message) => {
        if (message.type === 'transcript.segment' && isSuppressed(message.t)) {
          return; // very likely Linaw's own voice, not the hearing
        }
        if (message.type === 'tts.failed') {
          rejectPendingVoice(message.requestId);
          return;
        }
        const pending = pendingSummary.current;
        if (pending && 'requestId' in message && message.requestId === pending.requestId) {
          pendingSummary.current = null;
          if (message.type === 'summary.result') {
            const { overview, events, openIssue } = message;
            void historyStore.update(pending.recordId, (r) => ({ ...r, summary: { overview, events, openIssue, at: Date.now() } }));
          }
          return;
        }
        if (message.type === 'answer') {
          autoVoice(message.requestId, message.text, pendingAnswerVoice, () => dispatch({ type: 'server', message }));
          return;
        }
        if (message.type === 'what_said.result') {
          autoVoice(message.requestId, message.points.join(' '), pendingWhatSaidVoice, () => dispatch({ type: 'server', message }));
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
      (requestId, blob) => resolvePendingVoice(requestId, blob),
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
        source = request.kind === 'file' ? await captureFileAudio(request.file) : await captureScreenAudio();
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
          // Sharing stopped.
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

  const reconnect = () => {
    void startListening(lastSource.current);
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

  /** Push to talk: send the recorded question; the answer brings the words the backend heard. */
  const askAloud = async (clip: Blob, mimeType: string) => {
    const requestId = newRequestId();
    dispatch({ type: 'ask.requested', requestId, question: '', voice: true });
    try {
      const audio = await toBase64(clip);
      if (!socket.current?.send({ type: 'ask.audio', requestId, mimeType, audio })) throw new Error('not connected');
    } catch {
      dispatch({ type: 'server', message: { v: 1, type: 'error', code: 'internal', message: 'Linaw couldn’t send your question. Try again.', requestId } });
    }
  };

  const simplify = (card: Card) => {
    const requestId = newRequestId();
    dispatch({ type: 'simplify.requested', cardId: card.id, requestId });
    socket.current?.send({ type: 'card.simplify', requestId, cardId: card.id });
  };

  /** Read aloud: try Soniox (cloud) first, falling back to the on-device voice if it's unavailable or slow. */
  const speak = (card: Card) => {
    stopReading();
    setSpeakingCardId(null); // clears any previous card's now-abandoned loading state
    const text = `${card.term}. ${card.meaning} ${card.example}`;
    const rate = SPEECH_RATE[settings.readSpeed];
    const fallback = () => readAloud(text, card.language, rate);
    const requestId = newRequestId();
    if (!socket.current?.send({ type: 'tts.request', requestId, text, language: card.language })) {
      markPlayback(fallback()); // not connected at all; don't even wait, so there's nothing to show loading for
      return;
    }
    setSpeakingCardId(card.id);
    const timer = window.setTimeout(() => {
      if (pendingSpeak.current?.requestId === requestId) {
        pendingSpeak.current = null;
        setSpeakingCardId(null);
        markPlayback(fallback());
      }
    }, SPEAK_TIMEOUT_MS);
    pendingSpeak.current = {
      requestId,
      resolve: (blob) => {
        window.clearTimeout(timer);
        setSpeakingCardId(null);
        markPlayback(playCloudAudio(blob, rate).catch(fallback));
      },
      reject: () => {
        window.clearTimeout(timer);
        setSpeakingCardId(null);
        markPlayback(fallback());
      },
    };
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
    askAloud,
    reportError: (message: string) => dispatch({ type: 'error', message }),
    simplify,
    speak,
    speakingCardId,
    preparingVoiceId,
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
