import { useEffect, useRef, type ReactNode } from 'react';
import { Check, Contrast, Gauge, Globe, Info, Languages, Layers, PanelRightOpen, Type, Volume2 } from 'lucide-react';
import type { Settings } from '../lib/settings';

interface SettingsDialogProps {
  open: boolean;
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
}

export function SettingsDialog({ open, settings, onChange, onClose }: SettingsDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value });

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="settings-title" onClose={onClose}>
      <div className="dialog__header">
        <h2 id="settings-title">Settings</h2>
        <button type="button" className="solid-button" onClick={onClose}>
          <Check size={20} aria-hidden="true" />
          Done
        </button>
      </div>

      <div className="dialog__body">
        <Row icon={<Type size={24} />} label="Text size">
          <Segmented
            label="Text size"
            value={settings.textSize}
            onChange={(v) => set('textSize', v)}
            options={[
              { value: 'normal', label: 'A', className: 'seg--a' },
              { value: 'large', label: 'A+', className: 'seg--a1' },
              { value: 'larger', label: 'A++', className: 'seg--a2' },
            ]}
          />
        </Row>
        <Row icon={<Contrast size={24} />} label="High contrast" hint="White text on black, thicker lines">
          <Switch label="High contrast" checked={settings.highContrast} onChange={(v) => set('highContrast', v)} />
        </Row>
        <Row icon={<Gauge size={24} />} label="Read-aloud speed">
          <Segmented
            label="Read-aloud speed"
            value={settings.readSpeed}
            onChange={(v) => set('readSpeed', v)}
            options={[
              { value: 'slower', label: 'Slower' },
              { value: 'normal', label: 'Normal' },
              { value: 'faster', label: 'Faster' },
            ]}
          />
        </Row>
        <Row icon={<Volume2 size={24} />} label="Read answers aloud automatically" hint="Ask a question and hear the answer, not just read it">
          <Switch label="Read answers aloud automatically" checked={settings.autoVoiceAnswers} onChange={(v) => set('autoVoiceAnswers', v)} />
        </Row>
        <Row icon={<Layers size={24} />} label="Explanation level">
          <Segmented
            label="Explanation level"
            value={settings.level}
            onChange={(v) => set('level', v)}
            options={[
              { value: 'simple', label: 'Simple' },
              { value: 'detailed', label: 'Detailed' },
            ]}
          />
        </Row>
        <Row icon={<PanelRightOpen size={24} />} label="Show transcript">
          <Switch label="Show transcript" checked={settings.showTranscript} onChange={(v) => set('showTranscript', v)} />
        </Row>
        <Row icon={<Languages size={24} />} label="Show translation" hint="Your language under lines spoken in English">
          <Switch label="Show translation" checked={settings.showTranslation} onChange={(v) => set('showTranslation', v)} />
        </Row>
        <Row icon={<Globe size={24} />} label="Explanation language" last>
          <Segmented
            label="Explanation language"
            value={settings.language}
            onChange={(v) => set('language', v)}
            options={[
              { value: 'tl', label: 'Tagalog' },
              { value: 'en', label: 'English' },
            ]}
          />
        </Row>
      </div>

      <div className="dialog__footer">
        <Info size={20} aria-hidden="true" />
        Linaw explains terms. It is not legal advice.
      </div>
    </dialog>
  );
}

function Row({ icon, label, hint, last, children }: { icon: ReactNode; label: string; hint?: string; last?: boolean; children: ReactNode }) {
  return (
    <div className={last ? 'setting' : 'setting setting--divided'}>
      <div className="setting__label">
        <span aria-hidden="true">{icon}</span>
        <div>
          <div className="setting__name">{label}</div>
          {hint && <div className="setting__hint">{hint}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

interface Option<T extends string> {
  value: T;
  label: string;
  className?: string;
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Option<T>[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={['segmented__option', option.className].filter(Boolean).join(' ')}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)}>
      <span className="switch__thumb" />
    </button>
  );
}
