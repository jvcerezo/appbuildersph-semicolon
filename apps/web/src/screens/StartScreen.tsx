import { useRef } from 'react';
import { ArrowLeft, FileAudio, MonitorPlay, Share2 } from 'lucide-react';

interface StartScreenProps {
  onChooseTab: () => void;
  onChooseFile: (file: File) => void;
}

export function StartScreen({ onChooseTab, onChooseFile }: StartScreenProps) {
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <main className="start">
      <div className="start__intro">
        <h2 className="start__headline">Understand what's being said.</h2>
        <p className="start__lede">
          Linaw listens to a hearing or trial with you and explains the hard words in simple Tagalog, as they are said.
        </p>
      </div>
      <div className="start__choices">
        <button type="button" className="choice" onClick={onChooseTab}>
          <MonitorPlay size={32} aria-hidden="true" />
          <span className="choice__title">Listen to a browser tab</span>
          <span className="choice__hint">For a live stream on YouTube, Facebook, or a news site.</span>
          <span className="choice__cta">Choose a tab</span>
        </button>
        <button type="button" className="choice" onClick={() => fileInput.current?.click()}>
          <FileAudio size={32} aria-hidden="true" />
          <span className="choice__title">Upload a video or audio file</span>
          <span className="choice__hint">For a recording saved on this computer.</span>
          <span className="choice__cta">Choose a file</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="audio/*,video/*"
          className="visually-hidden"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onChooseFile(file);
          }}
        />
      </div>
    </main>
  );
}

interface ShareHelperProps {
  error: string | null;
  onShare: () => void;
  onBack: () => void;
}

const STEPS = ['Pick “Chrome Tab”', 'Click the tab with the hearing', 'Turn on “Share tab audio”, then click Share'];

export function ShareHelper({ error, onShare, onBack }: ShareHelperProps) {
  return (
    <main className="start">
      <div className="start__intro">
        <h2 className="start__headline">Share the sound from your tab</h2>
        <p className="start__lede">Your browser will open a small window asking what to share. Here is what to pick.</p>
      </div>
      <ol className="steps">
        {STEPS.map((step, i) => (
          <li key={step} className="step">
            <span className="step__number" aria-hidden="true">
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <div className="start__buttons">
        <button type="button" className="outline-button outline-button--tall" onClick={onBack}>
          <ArrowLeft size={20} aria-hidden="true" />
          Back
        </button>
        <button type="button" className="solid-button solid-button--tall" onClick={onShare}>
          <Share2 size={20} aria-hidden="true" />
          Open the share window
        </button>
      </div>
    </main>
  );
}
