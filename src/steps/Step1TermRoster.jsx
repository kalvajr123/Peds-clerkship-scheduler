import { useState } from 'react';
import { useAppState, useAppDispatch } from '../state/AppContext';
import { isMonday } from '../lib/weeks';
import { parseRosterCSV, parseRosterTextarea } from '../lib/csv';

export default function Step1TermRoster() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [rosterText, setRosterText] = useState(state.roster.map((s) => s.name).join('\n'));

  const startISO = state.term.startDate;
  const mondayOk = !startISO || isMonday(startISO);

  const handleDateChange = (e) => {
    dispatch({ type: 'SET_TERM_START_DATE', startISO: e.target.value });
  };

  const handleCSVUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const names = parseRosterCSV(text);
    setRosterText(names.join('\n'));
    dispatch({ type: 'SET_ROSTER_NAMES', names });
    e.target.value = '';
  };

  const handleTextareaBlur = () => {
    const names = parseRosterTextarea(rosterText);
    dispatch({ type: 'SET_ROSTER_NAMES', names });
  };

  const canProceed =
    state.term.startDate &&
    (mondayOk || state.term.confirmedNonMonday) &&
    state.roster.length > 0;

  return (
    <div>
      <div className="panel">
        <h2>Term start date</h2>
        <div className="field">
          <label htmlFor="term-start">Term start date (Monday of week 1)</label>
          <input id="term-start" type="date" value={startISO} onChange={handleDateChange} />
        </div>
        {startISO && !mondayOk && !state.term.confirmedNonMonday && (
          <div className="badge badge--warning" style={{ display: 'block', marginBottom: 8 }}>
            Term start date is not a Monday — please confirm this is correct.
            <div style={{ marginTop: 6 }}>
              <button onClick={() => dispatch({ type: 'CONFIRM_NON_MONDAY' })}>
                Confirm and continue anyway
              </button>
            </div>
          </div>
        )}
        {state.term.weeks.length > 0 && (
          <>
            <h3>Term weeks</h3>
            <ul className="week-list">
              {state.term.weeks.map((w) => (
                <li key={w.index}>{w.label}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="panel">
        <h2>Student roster</h2>
        <p className="muted">
          Upload a CSV (one column of names) or paste one name per line below. Each student is
          assigned an anonymized ID (S1, S2, ...) in this order.
        </p>
        <div className="field">
          <label htmlFor="roster-csv">Upload CSV</label>
          <input id="roster-csv" type="file" accept=".csv,text/csv" onChange={handleCSVUpload} />
        </div>
        <div className="field" style={{ maxWidth: 'none' }}>
          <label htmlFor="roster-textarea">Or paste one name per line</label>
          <textarea
            id="roster-textarea"
            value={rosterText}
            onChange={(e) => setRosterText(e.target.value)}
            onBlur={handleTextareaBlur}
            placeholder={'Jane Doe\nJohn Smith\n...'}
          />
        </div>
        {state.roster.length > 0 && (
          <p className="muted">{state.roster.length} students loaded (IDs S1–S{state.roster.length}).</p>
        )}
      </div>

      <div className="actions">
        <span />
        <button className="primary" disabled={!canProceed} onClick={() => dispatch({ type: 'SET_STEP', step: 2 })}>
          Next: Site Directory
        </button>
      </div>
    </div>
  );
}
