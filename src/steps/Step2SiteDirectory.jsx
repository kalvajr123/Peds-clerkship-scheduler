import { useMemo, useState } from 'react';
import { useAppState, useAppDispatch } from '../state/AppContext';
import { validateSiteCapacity } from '../lib/scheduler';

function NumberField({ value, onChange, min = 0, style }) {
  return (
    <input
      type="number"
      min={min}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      style={{ width: 64, ...style }}
    />
  );
}

function PHMTable() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const update = (siteId, patch) => dispatch({ type: 'UPDATE_SITE', pool: 'phm', siteId, patch });

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Site</th>
            <th>Distance / day</th>
            <th>Days / week</th>
            <th>Capacity (per week)</th>
          </tr>
        </thead>
        <tbody>
          {state.sites.phm.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>
                <NumberField value={s.distancePerDay} onChange={(v) => update(s.id, { distancePerDay: v })} />
              </td>
              <td>
                <NumberField value={s.daysPerWeek} onChange={(v) => update(s.id, { daysPerWeek: v })} />
              </td>
              <td>
                <NumberField
                  value={s.capacity}
                  onChange={(v) => update(s.id, { capacity: v })}
                  style={{ width: 64 }}
                />
                {s.capacity == null && <span className="muted"> (unlimited / opt-in)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PEMTable() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const update = (siteId, patch) => dispatch({ type: 'UPDATE_SITE', pool: 'pem', siteId, patch });

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Site</th>
            <th>Distance / day</th>
            <th>Days at site</th>
            <th>Days at Main</th>
            <th>Capacity (per week)</th>
          </tr>
        </thead>
        <tbody>
          {state.sites.pem.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>
                <NumberField value={s.distancePerDay} onChange={(v) => update(s.id, { distancePerDay: v })} />
              </td>
              <td>
                {s.daysAtSite != null ? (
                  <NumberField value={s.daysAtSite} onChange={(v) => update(s.id, { daysAtSite: v })} />
                ) : (
                  <NumberField value={s.daysPerWeek} onChange={(v) => update(s.id, { daysPerWeek: v })} />
                )}
              </td>
              <td>{s.daysAtMain != null ? <NumberField value={s.daysAtMain} onChange={(v) => update(s.id, { daysAtMain: v })} /> : '—'}</td>
              <td>
                <NumberField value={s.capacity} onChange={(v) => update(s.id, { capacity: v })} />
                {s.capacity == null && <span className="muted"> (unlimited / opt-in)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewbornTable() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const update = (siteId, patch) => dispatch({ type: 'UPDATE_SITE', pool: 'newborn', siteId, patch });

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Site</th>
            <th>Capacity (per week)</th>
          </tr>
        </thead>
        <tbody>
          {state.sites.newborn.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>
                <NumberField value={s.capacity} onChange={(v) => update(s.id, { capacity: v })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Newborn sites have zero commute distance and are purely used to fill schedule gaps.</p>
    </div>
  );
}

function CommunityTable() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [filter, setFilter] = useState('');
  const [newSiteName, setNewSiteName] = useState('');
  const [newSiteDistance, setNewSiteDistance] = useState(0);

  const update = (siteId, patch) => dispatch({ type: 'UPDATE_SITE', pool: 'community', siteId, patch });

  const toggleWeek = (site, week) => {
    const weeksOpen = site.weeksOpen.includes(week)
      ? site.weeksOpen.filter((w) => w !== week)
      : [...site.weeksOpen, week].sort((a, b) => a - b);
    update(site.id, { weeksOpen });
  };

  const setCapacity = (site, week, value) => {
    update(site.id, { capacityByWeek: { ...site.capacityByWeek, [week]: value } });
  };

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return state.sites.community;
    return state.sites.community.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.category || '').toLowerCase().includes(q)
    );
  }, [state.sites.community, filter]);

  const handleAddSite = () => {
    if (!newSiteName.trim()) return;
    const id = `custom-${Date.now()}`;
    dispatch({
      type: 'ADD_COMMUNITY_SITE',
      site: {
        id,
        name: newSiteName.trim(),
        category: 'Custom',
        distance: Number(newSiteDistance) || 0,
        isSubspecialty: false,
        isAustin: false,
        requiresSpanish: false,
        preceptors: [],
        available: true,
        weeksOpen: [1, 2, 3, 4, 5, 6],
        capacityByWeek: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 },
      },
    });
    setNewSiteName('');
    setNewSiteDistance(0);
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <input
          type="text"
          placeholder="Filter sites by name/category..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 260 }}
        />
        <span className="muted">{filtered.length} of {state.sites.community.length} sites</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Available</th>
              <th>Site</th>
              <th>Category</th>
              <th>Distance</th>
              <th>Subspecialty (1-wk max)</th>
              <th>Austin</th>
              <th>Requires Spanish</th>
              {[1, 2, 3, 4, 5, 6].map((w) => (
                <th key={w}>W{w} open / cap</th>
              ))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={s.available}
                    onChange={(e) => update(s.id, { available: e.target.checked })}
                  />
                </td>
                <td>
                  {s.name}
                  {s.preceptors?.length > 0 && (
                    <div className="muted">{s.preceptors.join('; ')}</div>
                  )}
                </td>
                <td>{s.category}</td>
                <td>
                  <NumberField value={s.distance} onChange={(v) => update(s.id, { distance: v })} />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={s.isSubspecialty}
                    onChange={(e) => update(s.id, { isSubspecialty: e.target.checked })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={s.isAustin}
                    onChange={(e) => update(s.id, { isAustin: e.target.checked })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={s.requiresSpanish}
                    onChange={(e) => update(s.id, { requiresSpanish: e.target.checked })}
                  />
                </td>
                {[1, 2, 3, 4, 5, 6].map((w) => (
                  <td key={w}>
                    <div className="row" style={{ gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={s.weeksOpen.includes(w)}
                        disabled={!s.available}
                        onChange={() => toggleWeek(s, w)}
                        title={`Open in week ${w}?`}
                      />
                      <NumberField
                        value={s.capacityByWeek[w] ?? 0}
                        onChange={(v) => setCapacity(s, w, v ?? 0)}
                        style={{ width: 44 }}
                      />
                    </div>
                  </td>
                ))}
                <td>
                  <button onClick={() => dispatch({ type: 'REMOVE_COMMUNITY_SITE', siteId: s.id })}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <input
          type="text"
          placeholder="New site name"
          value={newSiteName}
          onChange={(e) => setNewSiteName(e.target.value)}
        />
        <input
          type="number"
          placeholder="Distance"
          value={newSiteDistance}
          onChange={(e) => setNewSiteDistance(e.target.value)}
          style={{ width: 80 }}
        />
        <button onClick={handleAddSite}>Add community site</button>
      </div>
    </div>
  );
}

export default function Step2SiteDirectory() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const warnings = useMemo(
    () => validateSiteCapacity(state.sites, state.roster.length),
    [state.sites, state.roster.length]
  );

  return (
    <div>
      <div className="panel">
        <h2>PHM sites</h2>
        <PHMTable />
      </div>
      <div className="panel">
        <h2>PEM sites</h2>
        <PEMTable />
      </div>
      <div className="panel">
        <h2>Newborn sites</h2>
        <NewbornTable />
      </div>
      <div className="panel">
        <h2>Community sites</h2>
        <p className="muted">
          The full master list of community sites, preceptors, and distances is pre-loaded from
          historical data. Each term, just toggle availability, weeks open, and per-week capacity
          below — no need to re-enter the site list.
        </p>
        <CommunityTable />
      </div>

      {warnings.length > 0 && (
        <div className="panel">
          {warnings.map((w, i) => (
            <div key={i} className="badge badge--warning" style={{ display: 'block', marginBottom: 6 }}>
              {w}
            </div>
          ))}
        </div>
      )}

      <div className="actions">
        <button onClick={() => dispatch({ type: 'SET_STEP', step: 1 })}>Back</button>
        <button className="primary" onClick={() => dispatch({ type: 'SET_STEP', step: 3 })}>
          Next: Preferences
        </button>
      </div>
    </div>
  );
}
