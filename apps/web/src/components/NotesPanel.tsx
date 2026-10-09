import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Pencil, Plus, StickyNote, Trash2 } from 'lucide-react';
import { formatClock } from '../lib/format';
import type { Note } from '../lib/history';

interface NotesPanelProps {
  notes: Note[];
  onAdd: (text: string) => void;
  onUpdate: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  /** Shown above the input, e.g. that live notes get the hearing time. */
  hint?: string;
}

/** Notes on a session: add, edit and delete, oldest first like a notebook. */
export function NotesPanel({ notes, onAdd, onUpdate, onDelete, hint }: NotesPanelProps) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [notes.length]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onAdd(text);
    setDraft('');
  };

  return (
    <div className="notes">
      <div className="notes__list">
        {notes.length === 0 ? (
          <div className="notes__empty">
            <StickyNote size={28} aria-hidden="true" />
            <p>No notes yet. Write down what you want to remember or ask someone about later.</p>
          </div>
        ) : (
          notes.map((note) => <NoteItem key={note.id} note={note} onUpdate={onUpdate} onDelete={onDelete} />)
        )}
        <div ref={endRef} />
      </div>

      <form className="notes__form" onSubmit={submit}>
        {hint && <p className="notes__hint">{hint}</p>}
        <label htmlFor="note-draft" className="visually-hidden">
          New note
        </label>
        <textarea
          id="note-draft"
          className="notes__input"
          rows={2}
          placeholder="Write a note…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
          }}
        />
        <button type="submit" className="solid-button" disabled={!draft.trim()}>
          <Plus size={18} aria-hidden="true" />
          Add note
        </button>
      </form>
    </div>
  );
}

function NoteItem({ note, onUpdate, onDelete }: { note: Note; onUpdate: NotesPanelProps['onUpdate']; onDelete: NotesPanelProps['onDelete'] }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [text, setText] = useState(note.text);

  const when =
    note.t !== undefined
      ? formatClock(note.t)
      : new Date(note.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <article className="note">
      <div className="note__meta">
        <span title={note.t !== undefined ? 'Time in the hearing' : 'Added after the hearing'}>{when}</span>
        {!editing && !confirmDelete && (
          <span className="note__actions">
            <button type="button" className="note__action" aria-label="Edit note" title="Edit" onClick={() => setEditing(true)}>
              <Pencil size={16} aria-hidden="true" />
            </button>
            <button type="button" className="note__action" aria-label="Delete note" title="Delete" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={16} aria-hidden="true" />
            </button>
          </span>
        )}
      </div>

      {editing ? (
        <form
          className="note__edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onUpdate(note.id, text.trim());
            setEditing(false);
          }}
        >
          <textarea className="notes__input" rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <div className="note__buttons">
            <button type="button" className="outline-button" onClick={() => { setText(note.text); setEditing(false); }}>
              Cancel
            </button>
            <button type="submit" className="solid-button" disabled={!text.trim()}>
              Save
            </button>
          </div>
        </form>
      ) : (
        <p className="note__text">{note.text}</p>
      )}

      {confirmDelete && (
        <div className="note__confirm" role="alert">
          Delete this note?
          <button type="button" className="outline-button" onClick={() => setConfirmDelete(false)}>
            Keep
          </button>
          <button type="button" className="solid-button" onClick={() => onDelete(note.id)}>
            Delete
          </button>
        </div>
      )}
    </article>
  );
}
