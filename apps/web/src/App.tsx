import { useEffect, useState } from 'react';
import { PlugZap } from 'lucide-react';
import { SettingsDialog } from './components/SettingsDialog';
import { TopBar } from './components/TopBar';
import { desktop, isOverlay } from './lib/desktop';
import { LibraryApp } from './library/LibraryApp';
import { OverlayApp } from './overlay/OverlayApp';
import { LiveScreen } from './screens/LiveScreen';
import { useLinaw, type Linaw } from './state/useLinaw';

/**
 * Not listening: the library (start a session, past sessions).
 * Listening: the overlay beside the video (desktop shell, or `?overlay`), or
 * the full-window live layout in a browser tab.
 */
export function App() {
  const linaw = useLinaw();
  const live = linaw.session.phase === 'live';

  useEffect(() => {
    desktop?.setMode(live ? 'overlay' : 'app');
  }, [live]);

  if (!live) return <LibraryApp linaw={linaw} />;
  return isOverlay ? <OverlayApp linaw={linaw} /> : <FullLive linaw={linaw} />;
}

/** The full-window live layout from the design, for use in a browser tab. */
function FullLive({ linaw }: { linaw: Linaw }) {
  const { session, settings } = linaw;
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="app">
      <TopBar
        title={session.title}
        elapsedSec={linaw.elapsedSec}
        status={session.status}
        onOpenSettings={() => setSettingsOpen(true)}
        onFinish={() => void linaw.finishSession()}
      />

      {session.connection === 'closed' && (
        <div className="banner" role="alert">
          <PlugZap size={20} aria-hidden="true" />
          Can’t reach Linaw’s helper on this computer. Make sure it’s running. Trying again…
        </div>
      )}
      {session.error && (
        <div className="banner" role="alert">
          {session.error}
        </div>
      )}

      <LiveScreen
        session={session}
        language={settings.language}
        showTranscript={settings.showTranscript}
        showTranslation={settings.showTranslation}
        stoppedAtSec={linaw.stoppedAtSec}
        onShowTranscript={(show) => linaw.setSettings((s) => ({ ...s, showTranscript: show }))}
        onOpenHelp={linaw.openHelp}
        onAsk={linaw.ask}
        onAskAloud={(clip, mimeType) => void linaw.askAloud(clip, mimeType)}
        preparingVoiceId={linaw.preparingVoiceId}
        onError={linaw.reportError}
        onShowSegment={linaw.showSegment}
        onReadAloud={linaw.speak}
        speakingCardId={linaw.speakingCardId}
        onSimplify={linaw.simplify}
        onToggleSaved={linaw.toggleSaved}
        onReconnect={linaw.reconnect}
        onFinish={() => void linaw.finishSession()}
      />

      <SettingsDialog open={settingsOpen} settings={settings} onChange={linaw.setSettings} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
