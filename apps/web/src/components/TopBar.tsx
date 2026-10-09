import { AudioLines, CircleStop, Clock, Headphones, Settings, VolumeX, WifiOff } from 'lucide-react';
import type { Status } from '@linaw/contract';
import { formatClock } from '../lib/format';

const STATUS_PILL: Record<Status, { label: string; icon: typeof Clock; variant: string }> = {
  listening: { label: 'Listening', icon: Headphones, variant: 'pill' },
  offline: { label: 'Offline mode — still working', icon: WifiOff, variant: 'pill' },
  waiting: { label: 'Waiting for audio', icon: AudioLines, variant: 'pill pill--muted' },
  stopped: { label: 'Audio stopped', icon: VolumeX, variant: 'pill pill--solid' },
};

interface TopBarProps {
  title: string;
  elapsedSec: number | null;
  status: Status | null;
  onOpenSettings: () => void;
  /** End the session, save it and go back to the library. */
  onFinish?: () => void;
}

export function TopBar({ title, elapsedSec, status, onOpenSettings, onFinish }: TopBarProps) {
  const pill = status ? STATUS_PILL[status] : null;
  return (
    <header className="topbar">
      <div className="topbar__brand">Linaw</div>
      <div className="topbar__divider" aria-hidden="true" />
      <h1 className="topbar__title">{title}</h1>
      {elapsedSec !== null && (
        <div className="topbar__timer" title="Time since you started listening">
          <Clock size={18} aria-hidden="true" />
          <span>{formatClock(elapsedSec)}</span>
        </div>
      )}
      {pill && (
        <div className={pill.variant} role="status">
          <pill.icon size={18} aria-hidden="true" />
          {pill.label}
        </div>
      )}
      {onFinish && (
        <button type="button" className="outline-button" onClick={onFinish}>
          <CircleStop size={18} aria-hidden="true" />
          End session
        </button>
      )}
      <button type="button" className="icon-button" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
        <Settings size={22} aria-hidden="true" />
      </button>
    </header>
  );
}
