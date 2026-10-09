import { CircleHelp, FileText, MessageCircleQuestion } from 'lucide-react';
import type { HelpKind } from '../state/session';

interface ActionBarProps {
  onOpen: (kind: HelpKind) => void;
  disabled: boolean;
}

export function ActionBar({ onOpen, disabled }: ActionBarProps) {
  return (
    <div className="action-bar">
      <button type="button" className="big-button big-button--primary" onClick={() => onOpen('what_said')} disabled={disabled}>
        <CircleHelp size={24} aria-hidden="true" />
        What did they say?
      </button>
      <button type="button" className="big-button" onClick={() => onOpen('summary')} disabled={disabled}>
        <FileText size={24} aria-hidden="true" />
        Summary
      </button>
      <button type="button" className="big-button" onClick={() => onOpen('ask')} disabled={disabled}>
        <MessageCircleQuestion size={24} aria-hidden="true" />
        Ask a question
      </button>
    </div>
  );
}
