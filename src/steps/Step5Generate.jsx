import { useState } from 'react';
import { useAppState, useAppDispatch } from '../state/AppContext';
import { runScheduler } from '../lib/scheduler';
import { parseAllPreferences } from '../lib/preferences';

const RESTARTS = 200;

export default function Step5Generate() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [progress, setProgress] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  const handleGenerate = async () => {
    setRunning(true);
    setError(null);
    setProgress({ completed: 0, total: RESTARTS });
    try {
      const preferences = parseAllPreferences(state.preferencesText, state.roster);
      const result = await runScheduler({
        roster: state.roster,
        sitesState: state.sites,
        preferences,
        locks: state.manualLocks,
        restarts: RESTARTS,
        onProgress: setProgress,
      });
      dispatch({ type: 'SET_SCHEDULE', schedule: result });
      dispatch({ type: 'SET_STEP', step: 6 });
    } catch (err) {
      console.error(err);
      setError(err.message || String(err));
    } finally {
      setRunning(false);
    }
  };

  const pct = progress ? Math.round((progress.completed / progress.total) * 100) : 0;

  return (
    <div>
      <div className="panel">
        <h2>Generate schedule</h2>
        <p className="muted">
          Runs the balancing algorithm: hard preferences (FCFS), manual locks, greedy fill
          (PHM → PEM → Community), local-search cleanup, and {RESTARTS} random restarts, keeping
          the lowest-variance result.
        </p>
        <ul>
          <li>{state.roster.length} students</li>
          <li>{state.sites.community.filter((s) => s.available).length} available community sites</li>
          <li>{state.manualLocks.length} manual locks</li>
        </ul>
        <button className="primary" onClick={handleGenerate} disabled={running || state.roster.length === 0}>
          {running ? 'Generating…' : 'Generate Schedule'}
        </button>
        {progress && (
          <div style={{ marginTop: 12 }}>
            <div className="progress-bar">
              <div className="progress-bar__fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="muted">
              {progress.completed} / {progress.total} restarts ({pct}%)
            </p>
          </div>
        )}
        {error && <div className="badge badge--danger" style={{ display: 'block' }}>{error}</div>}
      </div>

      <div className="actions">
        <button onClick={() => dispatch({ type: 'SET_STEP', step: 4 })}>Back</button>
        <span />
      </div>
    </div>
  );
}
