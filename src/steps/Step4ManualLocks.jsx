import { useMemo, useState } from 'react';
import { useAppState, useAppDispatch } from '../state/AppContext';
import { buildDisplayNames } from '../lib/csv';
import { WEEK_BLOCKS } from '../lib/scheduler';

const ROTATION_OPTIONS = [
  { key: 'PHM', label: 'PHM', pool: 'phm', granularity: 'block' },
  { key: 'PEM', label: 'PEM', pool: 'pem', granularity: 'week' },
  { key: 'Community1', label: 'Community week 1', pool: 'community', granularity: 'block' },
  { key: 'Community2', label: 'Community week 2', pool: 'community', granularity: 'block' },
  { key: 'Newborn', label: 'Newborn', pool: 'newborn', granularity: 'week' },
];

function timingLabel(rotation, timing) {
  if (timing == null) return 'Any';
  if (rotation.granularity === 'block') return `Weeks ${WEEK_BLOCKS[timing].join('-')}`;
  return `Week ${timing}`;
}

function TimingSelect({ rotation, value, onChange }) {
  const options =
    rotation.granularity === 'block'
      ? WEEK_BLOCKS.map((block, i) => ({ value: String(i), label: `Weeks ${block.join('-')}` }))
      : [1, 2, 3, 4, 5, 6].map((w) => ({ value: String(w), label: `Week ${w}` }));
  const anyLabel = rotation.granularity === 'block' ? 'Any block' : 'Any week';
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{anyLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export default function Step4ManualLocks() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [studentQuery, setStudentQuery] = useState('');
  const [studentId, setStudentId] = useState('');
  const [rotationKey, setRotationKey] = useState('PHM');
  const [timing, setTiming] = useState(''); // '' = any, else block index (0-2) or week (1-6) as string
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
  const siteNameOf = (pool, id) => (id ? state.sites[pool].find((s) => s.id === id)?.name || id : 'Any (algorithm chooses)');

  const existingLockFor = (sId, rKey) =>
    state.manualLocks.find((l) => l.studentId === sId && l.rotationKey === rKey);

  const timingValue = timing === '' ? null : Number(timing);
  const canLock = !!studentId && (timingValue != null || !!siteId);

  const handleAddLock = () => {
    if (!canLock) return;
    if (existingLockFor(studentId, rotationKey)) {
      alert('That student already has a lock for this rotation. Remove it first to change.');
      return;
    }
    dispatch({
      type: 'ADD_LOCK',
      lock: {
        id: `lock-${Date.now()}`,
        studentId,
        rotationKey,
        timing: timingValue,
        siteId: siteId || null,
        pool: rotation.pool,
      },
    });
    setSiteId('');
    setTiming('');
  };

  return (
    <div>
      <div className="panel">
        <h2>Add a manual lock</h2>
        <p className="muted">
          Pick a student and a rotation slot, then fix a timing (which block/week), a specific site,
          or both — either one alone is enough to create a lock. Locked assignments are treated as
          fixed inputs and excluded from the balancing algorithm; anything left blank is still
          chosen by the algorithm.
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
          <select
            value={rotationKey}
            onChange={(e) => {
              setRotationKey(e.target.value);
              setSiteId('');
              setTiming('');
            }}
          >
            {ROTATION_OPTIONS.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
          <TimingSelect rotation={rotation} value={timing} onChange={setTiming} />
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} style={{ width: 220 }}>
            <option value="">Any site (algorithm chooses)</option>
            {sitePool.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="primary" onClick={handleAddLock} disabled={!canLock}>
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
                <th>Timing</th>
                <th>Site</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {state.manualLocks.map((l) => {
                const lockRotation = ROTATION_OPTIONS.find((r) => r.key === l.rotationKey);
                return (
                  <tr key={l.id}>
                    <td>{nameOf(l.studentId)}</td>
                    <td>{lockRotation?.label}</td>
                    <td>{timingLabel(lockRotation, l.timing)}</td>
                    <td>{siteNameOf(l.pool, l.siteId)}</td>
                    <td>
                      <button onClick={() => dispatch({ type: 'REMOVE_LOCK', lockId: l.id })}>Remove</button>
                    </td>
                  </tr>
                );
              })}
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
