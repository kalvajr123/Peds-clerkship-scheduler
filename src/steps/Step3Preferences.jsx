import { useMemo, useState } from 'react';
import { useAppState, useAppDispatch } from '../state/AppContext';
import { PREFERENCE_CATEGORIES, parseAllPreferences } from '../lib/preferences';

export default function Step3Preferences() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [showConfirm, setShowConfirm] = useState(false);

  const parsed = useMemo(
    () => parseAllPreferences(state.preferencesText, state.roster),
    [state.preferencesText, state.roster]
  );

  const totalUnmatched = PREFERENCE_CATEGORIES.reduce(
    (sum, cat) => sum + (parsed[cat.key]?.unmatched?.length || 0),
    0
  );

  const handleTextChange = (key, text) => {
    dispatch({ type: 'SET_PREFERENCE_TEXT', key, text });
  };

  const nameOf = (id) => state.roster.find((s) => s.id === id)?.name || id;

  const handleContinue = () => {
    if (totalUnmatched > 0 && !showConfirm) {
      setShowConfirm(true);
      return;
    }
    dispatch({ type: 'SET_PARSED_PREFERENCES', parsed });
    dispatch({ type: 'SET_STEP', step: 4 });
  };

  return (
    <div>
      {PREFERENCE_CATEGORIES.map((cat) => {
        const result = parsed[cat.key];
        return (
          <div className="panel" key={cat.key}>
            <h2>{cat.label}</h2>
            {cat.isChristus && (
              <p className="muted">
                One entry per line, e.g. "Jane Doe - PHM and Community". Rotation keywords PHM /
                Community / PEM are detected automatically.
              </p>
            )}
            <textarea
              value={state.preferencesText[cat.key]}
              onChange={(e) => handleTextChange(cat.key, e.target.value)}
              placeholder={cat.isChristus ? 'Jane Doe - PHM, Community\nJohn Smith: PEM' : 'Jane Doe, John Smith\n...'}
            />
            <p className="muted">
              {result.order.length} matched, in entry order:{' '}
              {result.order.map((id) => nameOf(id)).join(', ') || '—'}
            </p>
            {result.unmatched.length > 0 && (
              <div className="badge badge--warning" style={{ display: 'block' }}>
                {result.unmatched.length} entr{result.unmatched.length === 1 ? 'y' : 'ies'} need review:
                <ul>
                  {result.unmatched.map((u, i) => (
                    <li key={i}>
                      "{u.raw}"{u.reason ? ` — ${u.reason}` : ''}
                      {u.suggestionName ? ` (did you mean "${u.suggestionName}"?)` : ' (no close match found)'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}

      {showConfirm && totalUnmatched > 0 && (
        <div className="panel">
          <p>
            There are still {totalUnmatched} unmatched name(s) across the boxes above. Fix any typos
            in the text boxes, or continue anyway — unmatched entries will simply be ignored by the
            algorithm.
          </p>
        </div>
      )}

      <div className="actions">
        <button onClick={() => dispatch({ type: 'SET_STEP', step: 2 })}>Back</button>
        <button className="primary" onClick={handleContinue}>
          {totalUnmatched > 0 && !showConfirm ? 'Review unmatched names' : 'Next: Manual Locks'}
        </button>
      </div>
    </div>
  );
}
