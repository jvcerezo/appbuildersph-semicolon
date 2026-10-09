import { useState } from 'react';
import { PlugZap } from 'lucide-react';
import { SettingsDialog } from './components/SettingsDialog';
import { TopBar } from './components/TopBar';
import { isOverlay } from './lib/desktop';
import { OverlayApp } from './overlay/OverlayApp';
import { LiveScreen } from './screens/LiveScreen';
import { ShareHelper, StartScreen } from './screens/StartScreen';
import { useLinaw, type Linaw } from './state/useLinaw';

export function App() {
  const linaw = useLinaw();
  return isOverlay ? <OverlayApp linaw={linaw} /> : <FullApp linaw={linaw} />;
}

/** The full-window layout from the design, for use in a browser tab. */
function FullApp({ linaw }: { linaw: Linaw }) {
  const { session, settings } = linaw;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const live = session.phase === 'live';

  return (
    <div className="app">
      <TopBar
        title={session.title}
        elapsedSec={live ? linaw.elapsedSec : null}
        status={live ? session.status : null}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {session.connection === 'closed' && (
        <div className="banner" role="alert">
          <PlugZap size={20} aria-hidden="true" />
          Can’t reach Linaw’s helper on this computer. Make sure it’s running. Trying again…
        </div>
      )}
      {session.error && live && (
        <div className="banner" role="alert">
          {session.error}
        </div>
      )}

      {session.phase === 'start' && (
        <StartScreen
          onChooseTab={() => linaw.goTo('share-helper')}
          onChooseFile={(file) => void linaw.startListening({ kind: 'file', file })}
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
          onShare={() => void linaw.startListening({ kind: 'tab' })}
          onBack={() => linaw.goTo('start')}
        />
      )}
      {live && (
        <LiveScreen
          session={session}
          language={settings.language}
          showTranscript={settings.showTranscript}
          showTranslation={settings.showTranslation}
          stoppedAtSec={linaw.stoppedAtSec}
          onShowTranscript={(show) => linaw.setSettings((s) => ({ ...s, showTranscript: show }))}
          onOpenHelp={linaw.openHelp}
          onAsk={linaw.ask}
          onShowSegment={linaw.showSegment}
          onReadAloud={linaw.speak}
          onSimplify={linaw.simplify}
          onToggleSaved={linaw.toggleSaved}
          onReconnect={linaw.reconnect}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onChange={linaw.setSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
