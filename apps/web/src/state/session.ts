import type { Card, ServerMessage, Status, SummaryEvent, TermRef } from '@linaw/contract';
import type { ConnectionState } from '../lib/socket';

export type Phase = 'start' | 'share-helper' | 'live';
export type HelpKind = 'what_said' | 'summary' | 'ask';

export interface Segment {
  id: string;
  t: number;
  speaker: string;
  text: string;
  terms: TermRef[];
  final: boolean;
}

export interface PendingCard {
  id: string;
  term: string;
  t: number;
}

type Loadable<T> = { state: 'idle' } | { state: 'loading'; requestId: string } | { state: 'done'; value: T };

export interface QA {
  requestId: string;
  question: string;
  answer?: string;
}

export interface SessionState {
  connection: ConnectionState;
  phase: Phase;
  status: Status;
  title: string;
  /** Local clock: when listening started, for the top-bar timer. */
  startedAt: number | null;
  stoppedAt: number | null;
  segments: Segment[];
  /** Newest first. */
  cards: Card[];
  pending: PendingCard[];
  saved: string[];
  /** Cards waiting for a simpler rewrite. */
  simplifying: { cardId: string; requestId: string }[];
  help: HelpKind | null;
  whatSaid: Loadable<{ windowSec: number; points: string[] }>;
  summary: Loadable<{ overview: string; events: SummaryEvent[]; openIssue?: string }>;
  questions: QA[];
  error: string | null;
}

export const initialSession: SessionState = {
  connection: 'connecting',
  phase: 'start',
  status: 'waiting',
  title: 'New session',
  startedAt: null,
  stoppedAt: null,
  segments: [],
  cards: [],
  pending: [],
  saved: [],
  simplifying: [],
  help: null,
  whatSaid: { state: 'idle' },
  summary: { state: 'idle' },
  questions: [],
  error: null,
};

export type SessionAction =
  | { type: 'connection'; state: ConnectionState }
  | { type: 'server'; message: ServerMessage }
  | { type: 'phase'; phase: Phase }
  | { type: 'listening.started' }
  | { type: 'listening.stopped' }
  | { type: 'help.open'; kind: HelpKind | null }
  | { type: 'what_said.requested'; requestId: string }
  | { type: 'summary.requested'; requestId: string }
  | { type: 'ask.requested'; requestId: string; question: string }
  | { type: 'simplify.requested'; cardId: string; requestId: string }
  | { type: 'card.toggleSaved'; cardId: string }
  | { type: 'error'; message: string | null };

const without = (list: string[], id: string) => list.filter((x) => x !== id);

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.state };
    case 'phase':
      return { ...state, phase: action.phase, error: null };
    case 'listening.started':
      return {
        ...state,
        phase: 'live',
        status: 'waiting',
        startedAt: state.startedAt ?? Date.now(),
        stoppedAt: null,
        error: null,
      };
    case 'listening.stopped':
      return { ...state, status: 'stopped', stoppedAt: Date.now() };
    case 'help.open':
      return { ...state, help: action.kind };
    case 'what_said.requested':
      return { ...state, whatSaid: { state: 'loading', requestId: action.requestId } };
    case 'summary.requested':
      return { ...state, summary: { state: 'loading', requestId: action.requestId } };
    case 'ask.requested':
      return { ...state, questions: [...state.questions, { requestId: action.requestId, question: action.question }] };
    case 'simplify.requested':
      return {
        ...state,
        simplifying: [
          ...state.simplifying.filter((s) => s.cardId !== action.cardId),
          { cardId: action.cardId, requestId: action.requestId },
        ],
      };
    case 'card.toggleSaved':
      return {
        ...state,
        saved: state.saved.includes(action.cardId)
          ? without(state.saved, action.cardId)
          : [...state.saved, action.cardId],
      };
    case 'error':
      return { ...state, error: action.message };
    case 'server':
      return applyServerMessage(state, action.message);
  }
}

function applyServerMessage(state: SessionState, message: ServerMessage): SessionState {
  switch (message.type) {
    case 'status':
      // A local stop wins over a late "listening" from the backend.
      if (state.status === 'stopped' && message.status !== 'stopped' && state.stoppedAt !== null) {
        return { ...state, title: message.title ?? state.title };
      }
      return { ...state, status: message.status, title: message.title ?? state.title };

    case 'transcript.segment': {
      const { v: _v, type: _type, ...segment } = message;
      const index = state.segments.findIndex((s) => s.id === segment.id);
      const segments =
        index === -1
          ? [...state.segments, segment]
          : state.segments.map((s, i) => (i === index ? segment : s));
      return { ...state, segments };
    }

    case 'card.pending':
      if (state.pending.some((p) => p.id === message.id) || state.cards.some((c) => c.id === message.id)) {
        return state;
      }
      return { ...state, pending: [{ id: message.id, term: message.term, t: message.t }, ...state.pending] };

    case 'card': {
      const { card } = message;
      const exists = state.cards.some((c) => c.id === card.id);
      return {
        ...state,
        cards: exists ? state.cards.map((c) => (c.id === card.id ? card : c)) : [card, ...state.cards],
        pending: state.pending.filter((p) => p.id !== card.id),
        simplifying: state.simplifying.filter((s) => s.cardId !== card.id),
      };
    }

    case 'what_said.result':
      if (state.whatSaid.state !== 'loading' || state.whatSaid.requestId !== message.requestId) return state;
      return { ...state, whatSaid: { state: 'done', value: { windowSec: message.windowSec, points: message.points } } };

    case 'summary.result':
      if (state.summary.state !== 'loading' || state.summary.requestId !== message.requestId) return state;
      return {
        ...state,
        summary: {
          state: 'done',
          value: { overview: message.overview, events: message.events, openIssue: message.openIssue },
        },
      };

    case 'answer':
      return {
        ...state,
        questions: state.questions.map((q) =>
          q.requestId === message.requestId ? { ...q, answer: message.text } : q,
        ),
      };

    case 'error': {
      const next = { ...state, error: message.message };
      if (!message.requestId) return next;
      const id = message.requestId;
      return {
        ...next,
        whatSaid: next.whatSaid.state === 'loading' && next.whatSaid.requestId === id ? { state: 'idle' } : next.whatSaid,
        summary: next.summary.state === 'loading' && next.summary.requestId === id ? { state: 'idle' } : next.summary,
        questions: next.questions.filter((q) => q.requestId !== id),
        simplifying: next.simplifying.filter((s) => s.requestId !== id),
      };
    }
  }
}
