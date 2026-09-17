import { useEffect, useState } from 'react';
import { ReasoningTranscript } from './ReasoningTranscript';
import { formatElapsed, type PhaseEntry } from '../utils/phaseTranscript';

interface ActivityCardProps {
  title: string;
  phases: PhaseEntry[];
  isActive: boolean;
}

/**
 * The in-progress run, shown in the thread as a single card.
 *
 * Everything below the header is the transcript: one entry per step, each holding
 * the reasoning it produced. The previous fixed step list plus a single shared
 * text box could show either the stage or the reasoning but never tie one to the
 * other, and finished steps lost their reasoning entirely.
 */
export function ActivityCard({ title, phases, isActive }: ActivityCardProps) {
  const startedAt = phases[0]?.startedAt;
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  const elapsed = startedAt ? Date.now() - startedAt : 0;

  return (
    <section className="activity" aria-label={title}>
      <header className="activity__head">
        <span className="activity__spinner" aria-hidden="true" />
        <span className="activity__title">{title}</span>
        {startedAt && <span className="activity__elapsed">{formatElapsed(elapsed)}</span>}
      </header>
      {phases.length === 0 ? (
        <p className="activity__waiting">キューに入りました。まもなく開始します…</p>
      ) : (
        <ReasoningTranscript phases={phases} isActive={isActive} />
      )}
    </section>
  );
}
