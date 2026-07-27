import { useMemo, useState } from 'react';
import { useAppState, useAppDispatch } from '../state/AppContext';
import { buildDisplayNames } from '../lib/csv';

const ROTATION_OPTIONS = [
  { key: 'PHM', label: 'PHM', pool: 'phm' },
  { key: 'PEM', label: 'PEM', pool: 'pem' },
  { key: 'Community1', label: 'Community week 1', pool: 'community' },
  { key: 'Community2', label: 'Community week 2', pool: 'community' },
];

export default function Step4ManualLocks() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [studentQuery, setStudentQuery] = useState('');
  const [studentId, setStudentId] = useState('');
  const [rotationKey, setRotationKey] = useState('PHM');
  const [siteId, setSiteId] = useState('');

  const filteredStudents = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    if (!q) return state.roster;
    return state.roster.filter(
      (s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
    );
  }, [state.roster, studentQuery]);

  const rotation = ROTATION_OPTIONS.find((r) => r.key === rotationKey);
  const sitePool = state.sites[rotation.pool].filter((s) => rotation.pool !== 'community' || s.available);

  const displayNames = useMemo(() => buildDisplayNames(state.roster), [state.roster]);
  const nameOf = (id) => displayNames[id] || id;
  const siteNameOf = (pool, id) => state.sites[pool].find((s) => s.id === id)?.name || id;

  const existingLockFor = (sId, rKey) =>
    state.manualLocks.find((l) => l.studentId === sId && l.rotationKey === rKey);

  const handleAddLock = () => {
    if (!studentId || !siteId) return;
    if (existingLockFor(studentId, rotationKey)) {
      alert('That student already has a lock for this rotation. Remove it first to change.');
      return;
    }
    dispatch({
      type: 'ADD_LOCK',
      lock: { id: `lock-${Date.now()}`, studentId, rotationKey, siteId, pool: rotation.pool },
    });
    setSiteId('');
  };

  return (
    <div>
      <div className="panel">
        <h2>Add a manual lock</h2>
        <p className="muted">
          Pick a student, a rotation slot, and a specific site to fix that assignment. Locked
          assignments are treated as fixed inputs and excluded from the balancing algorithm.
        </p>
        <div className="row">
          <input
            type="text"
            placeholder="Search student..."
            value={studentQuery}
            onChange={(e) => setStudentQuery(e.target.value)}
            style={{ width: 180 }}
          />
          <select value={studentId} onChange={(e) => setStudentId(e.target.value)} style={{ width: 200 }}>
            <option value="">Select student...</option>
            {filteredStudents.map((s) => (
              <option key={s.id} value={s.id}>
                {nameOf(s.id)}
              </option>
            ))}
          </select>
          <select value={rotationKey} onChange={(e) => { setRotationKey(e.target.value); setSiteId(''); }}>
            {ROTATION_OPTIONS.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} style={{ width: 220 }}>
            <option value="">Select site...</option>
            {sitePool.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="primary" onClick={handleAddLock} disabled={!studentId || !siteId}>
            Lock
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Current locks ({state.manualLocks.length})</h2>
        {state.manualLocks.length === 0 ? (
          <p className="muted">No manual locks yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Student</th>
                <th>Rotation</th>
                <th>Site</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {state.manualLocks.map((l) => (
                <tr key={l.id}>
                  <td>{nameOf(l.studentId)}</td>
                  <td>{ROTATION_OPTIONS.find((r) => r.key === l.rotationKey)?.label}</td>
                  <td>{siteNameOf(l.pool, l.siteId)}</td>
                  <td>
                    <button onClick={() => dispatch({ type: 'REMOVE_LOCK', lockId: l.id })}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="actions">
        <button onClick={() => dispatch({ type: 'SET_STEP', step: 3 })}>Back</button>
        <button className="primary" onClick={() => dispatch({ type: 'SET_STEP', step: 5 })}>
          Next: Generate Schedule
        </button>
      </div>
    </div>
  );
}
