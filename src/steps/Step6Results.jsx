import { useState } from 'react';
import { useAppState, useAppDispatch } from '../state/AppContext';
import { exportResultsToExcel } from '../lib/excelExport';

const TABS = ['Schedule', 'Mileage Summary', 'Student Key'];

const OVERFLOW_LABELS = {
  katyPHM: 'Katy (PHM)',
  katyPEM: 'Katy (PEM)',
  woodlandsPEM: 'Woodlands (PEM)',
  austin: 'Austin (Community)',
  christusPHM: 'Christus (PHM)',
  christusPEM: 'Christus (PEM)',
  christusCommunity: 'Christus (Community)',
};

function poolForRotation(rotation) {
  if (rotation === 'PHM') return 'phm';
  if (rotation === 'PEM') return 'pem';
  if (rotation === 'Community') return 'community';
  return 'newborn';
}

function ScheduleTab() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [editingCell, setEditingCell] = useState(null); // {studentId, week}
  const schedule = state.schedule;

  const nameOf = (id) => state.roster.find((s) => s.id === id)?.name || id;

  const handleCellClick = (studentId, week) => {
    setEditingCell({ studentId, week });
  };

  const handleReassign = (studentId, week, rotation, siteId) => {
    const pool = poolForRotation(rotation);
    const site = state.sites[pool].find((s) => s.id === siteId);
    if (!site) return;
    const distance =
      rotation === 'PHM'
        ? (site.distancePerDay || 0) * (site.daysPerWeek || 0)
        : rotation === 'PEM'
        ? site.daysAtSite != null
          ? (site.distancePerDay || 0) * site.daysAtSite
          : (site.distancePerDay || 0) * (site.daysPerWeek || 0)
        : rotation === 'Community'
        ? site.distance || 0
        : 0;
    dispatch({
      type: 'OVERRIDE_ASSIGNMENT',
      studentId,
      weekIndex: week,
      siteId: site.id,
      siteName: site.name,
      distance,
      rotation,
    });
    setEditingCell(null);
  };

  if (!schedule) return <p className="muted">No schedule generated yet.</p>;

  const overflowByCategory = {};
  schedule.overflow.forEach((o) => {
    overflowByCategory[o.category] = overflowByCategory[o.category] || [];
    overflowByCategory[o.category].push(o);
  });

  return (
    <div>
      {schedule.unfilledCount > 0 && (
        <div className="panel">
          <div className="badge badge--danger" style={{ display: 'block' }}>
            {schedule.unfilledCount} slot(s) could not be filled automatically (site capacity was
            exhausted) — look for "UNFILLED" cells below and assign them manually via a lock or an
            inline override.
          </div>
        </div>
      )}
      {schedule.overflow.length > 0 && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Requested but not assigned — needs coordinator follow-up</h3>
          {Object.entries(overflowByCategory).map(([cat, entries]) => (
            <div key={cat} style={{ marginBottom: 8 }}>
              <strong>{OVERFLOW_LABELS[cat] || cat}:</strong>{' '}
              {entries
                .sort((a, b) => a.order - b.order)
                .map((e) => nameOf(e.studentId))
                .join(', ')}
            </div>
          ))}
        </div>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Student</th>
              {[1, 2, 3, 4, 5, 6].map((w) => (
                <th key={w}>Week {w}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.roster.map((s) => (
              <tr key={s.id}>
                <td>{s.id}</td>
                {[1, 2, 3, 4, 5, 6].map((w) => {
                  const cell = schedule.weekly[s.id]?.[w];
                  const isEditing = editingCell?.studentId === s.id && editingCell?.week === w;
                  const pool = cell ? poolForRotation(cell.rotation) : 'community';
                  const options = state.sites[pool].filter((site) => pool !== 'community' || site.available);
                  return (
                    <td key={w} className="cell-editable" onClick={() => !isEditing && handleCellClick(s.id, w)}>
                      {isEditing ? (
                        <select
                          autoFocus
                          defaultValue={cell?.siteId}
                          onBlur={() => setEditingCell(null)}
                          onChange={(e) => handleReassign(s.id, w, cell.rotation, e.target.value)}
                        >
                          {options.map((site) => (
                            <option key={site.id} value={site.id}>
                              {site.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <>
                          <div>{cell?.siteName}</div>
                          <div className="muted">
                            {cell?.rotation} · {cell?.distance}mi
                          </div>
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MileageSummaryTab() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const schedule = state.schedule;
  if (!schedule) return null;

  const sorted = [...state.roster].sort((a, b) => schedule.rank[a.id] - schedule.rank[b.id]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <label htmlFor="z-threshold">Outlier |z| threshold:</label>
        <input
          id="z-threshold"
          type="number"
          step="0.1"
          value={state.zThreshold}
          onChange={(e) => dispatch({ type: 'SET_Z_THRESHOLD', threshold: Number(e.target.value) })}
          style={{ width: 70 }}
        />
      </div>
      <table>
        <thead>
          <tr>
            <th>Student ID</th>
            <th>Total Distance</th>
            <th>Rank</th>
            <th>Z-Score</th>
            <th>Flag</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => {
            const z = schedule.zScore[s.id];
            const flag = z > state.zThreshold ? 'HIGH' : z < -state.zThreshold ? 'LOW' : '';
            return (
              <tr key={s.id} className={flag === 'HIGH' ? 'flag-high' : flag === 'LOW' ? 'flag-low' : ''}>
                <td>{s.id}</td>
                <td>{Math.round(schedule.mileage[s.id] * 10) / 10}</td>
                <td>{schedule.rank[s.id]}</td>
                <td>{z.toFixed(2)}</td>
                <td>{flag}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StudentKeyTab() {
  const state = useAppState();
  return (
    <table>
      <thead>
        <tr>
          <th>Student ID</th>
          <th>Student Name</th>
        </tr>
      </thead>
      <tbody>
        {state.roster.map((s) => (
          <tr key={s.id}>
            <td>{s.id}</td>
            <td>{s.name}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Step6Results() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [tab, setTab] = useState('Schedule');
  const schedule = state.schedule;

  const handleExport = () => {
    if (!schedule) return;
    exportResultsToExcel({
      roster: state.roster,
      weekly: schedule.weekly,
      mileage: schedule.mileage,
      rank: schedule.rank,
      zScore: schedule.zScore,
      threshold: state.zThreshold,
    });
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? 'tabs__active' : ''} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>
        <button className="primary" onClick={handleExport} disabled={!schedule}>
          Export to Excel
        </button>
      </div>

      {tab === 'Schedule' && <ScheduleTab />}
      {tab === 'Mileage Summary' && <MileageSummaryTab />}
      {tab === 'Student Key' && <StudentKeyTab />}

      <div className="actions">
        <button onClick={() => dispatch({ type: 'SET_STEP', step: 5 })}>Back</button>
        <span />
      </div>
    </div>
  );
}
