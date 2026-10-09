import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { PlugZap } from 'lucide-react';
import type { Card } from '@linaw/contract';
import { SettingsDialog } from './components/SettingsDialog';
import { TopBar } from './components/TopBar';
import { captureFile, captureTab, startRecorder, type AudioSource, type Recorder } from './lib/audio';
import { newRequestId } from './lib/format';
import { loadSettings, saveSettings, SPEECH_RATE, TEXT_SCALE, toPreferences, type Settings } from './lib/settings';
import { BackendSocket } from './lib/socket';
import { readAloud, stopReading } from './lib/speech';
import { LiveScreen } from './screens/LiveScreen';
import { ShareHelper, StartScreen } from './screens/StartScreen';
import { initialSession, sessionReducer, type HelpKind } from './state/session';

const WHAT_SAID_WINDOW_SEC = 120;

type SourceKind = 'tab' | 'file';
type SourceRequest = { kind: 'tab' } | { kind: 'file'; file: File };

export function App() {
  const [session, dispatch] = useReducer(sessionReducer, initialSession);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const now = useNow(session.phase === 'live' && session.status !== 'stopped');

  const socket = useRef<BackendSocket | null>(null);
  const capture = useRef<{ source: AudioSource; recorder: Recorder; kind: SourceKind } | null>(null);
  const lastKind = useRef<SourceKind>('tab');
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // ---- backend connection
  useEffect(() => {
    const backend = new BackendSocket(
      (message) => dispatch({ type: 'server', message }),
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
    root.lang = 'en';
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
      const { kind } = request;
      lastKind.current = kind;

      let source: AudioSource;
      try {
        source = request.kind === 'tab' ? await captureTab() : await captureFile(request.file);
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
          // The tab stopped sharing or the file finished.
          stopCapture();
          socket.current?.send({ type: 'session.stop' });
          dispatch({ type: 'listening.stopped' });
        },
      );
      capture.current = { source, recorder, kind };
      backend.send({
        type: 'session.start',
        source: kind,
        mimeType: recorder.mimeType,
        preferences: toPreferences(settingsRef.current),
      });
      dispatch({ type: 'listening.started' });
    },
    [session.connection, stopCapture],
  );

  const reconnect = () => {
    if (lastKind.current === 'tab') void startListening({ kind: 'tab' });
    else dispatch({ type: 'phase', phase: 'start' });
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

  const elapsedSec = session.startedAt === null ? null : ((session.stoppedAt ?? now) - session.startedAt) / 1000;
  const live = session.phase === 'live';

  return (
    <div className="app">
      <TopBar
        title={session.title}
        elapsedSec={live ? elapsedSec : null}
        status={live ? session.status : null}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {session.connection === 'closed' && (
        <div className="banner" role="alert">
          <PlugZap size={20} aria-hidden="true" />
          Can’t reach Linaw’s helper on this computer. Make sure it’s running. Trying again…
        </div>
      )}
      {session.error && session.phase === 'live' && (
        <div className="banner" role="alert">
          {session.error}
        </div>
      )}

      {session.phase === 'start' && (
        <StartScreen
          onChooseTab={() => dispatch({ type: 'phase', phase: 'share-helper' })}
          onChooseFile={(file) => void startListening({ kind: 'file', file })}
        />
      )}
      {session.phase === 'start' && session.error && (
        <p className="notice notice--floating" role="alert">
          {session.error}
        </p>
      )}
      {session.phase === 'share-helper' && (
        <ShareHelper
          error={session.error}
          onShare={() => void startListening({ kind: 'tab' })}
          onBack={() => dispatch({ type: 'phase', phase: 'start' })}
        />
      )}
      {live && (
        <LiveScreen
          session={session}
          language={settings.language}
          showTranscript={settings.showTranscript}
          stoppedAtSec={session.stoppedAt !== null && session.startedAt !== null ? (session.stoppedAt - session.startedAt) / 1000 : null}
          onShowTranscript={(show) => setSettings((s) => ({ ...s, showTranscript: show }))}
          onOpenHelp={openHelp}
          onAsk={ask}
          onReadAloud={speak}
          onSimplify={simplify}
          onToggleSaved={(card) => dispatch({ type: 'card.toggleSaved', cardId: card.id })}
          onReconnect={reconnect}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onChange={setSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

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
