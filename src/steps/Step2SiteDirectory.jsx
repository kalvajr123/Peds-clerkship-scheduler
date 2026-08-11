import { useMemo, useState } from 'react';
import { useAppState, useAppDispatch } from '../state/AppContext';
import { validateSiteCapacity, WEEK_BLOCKS } from '../lib/scheduler';

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

/** One open/capacity cell for a single week (used by PEM and Community tables). */
function WeekOpenCapCell({ site, week, onToggle, onCapacity, disabled }) {
  return (
    <td>
      <div className="row" style={{ gap: 4 }}>
        <input
          type="checkbox"
          checked={site.weeksOpen.includes(week)}
          disabled={disabled}
          onChange={() => onToggle(site, week)}
          title={`Open in week ${week}?`}
        />
        <NumberField
          value={site.capacityByWeek[week] ?? 0}
          onChange={(v) => onCapacity(site, week, v ?? 0)}
          style={{ width: 44 }}
        />
      </div>
    </td>
  );
}

/** One open/capacity cell for a whole 2-week block (used by the PHM table). */
function BlockOpenCapCell({ site, block, onToggleBlock, onCapacityBlock }) {
  const bothOpen = block.every((w) => site.weeksOpen.includes(w));
  return (
    <td>
      <div className="row" style={{ gap: 4 }}>
        <input
          type="checkbox"
          checked={bothOpen}
          onChange={() => onToggleBlock(site, block)}
          title={`Open for weeks ${block.join('-')}?`}
        />
        <NumberField
          value={site.capacityByWeek[block[0]] ?? 0}
          onChange={(v) => onCapacityBlock(site, block, v ?? 0)}
          style={{ width: 44 }}
        />
      </div>
    </td>
  );
}

function PHMTable() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const update = (siteId, patch) => dispatch({ type: 'UPDATE_SITE', pool: 'phm', siteId, patch });

  const toggleBlock = (site, block) => {
    const bothOpen = block.every((w) => site.weeksOpen.includes(w));
    const weeksOpen = bothOpen
      ? site.weeksOpen.filter((w) => !block.includes(w))
      : [...new Set([...site.weeksOpen, ...block])].sort((a, b) => a - b);
    update(site.id, { weeksOpen });
  };

  const setBlockCapacity = (site, block, value) => {
    const capacityByWeek = { ...site.capacityByWeek };
    block.forEach((w) => {
      capacityByWeek[w] = value;
    });
    update(site.id, { capacityByWeek });
  };

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Site</th>
            <th>Distance / day</th>
            <th>Days / week</th>
            {WEEK_BLOCKS.map((block) => (
              <th key={block.join('-')}>Weeks {block.join('-')} open / cap</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.sites.phm.map((s) => (
            <tr key={s.id}>
              <td>
                {s.name}
                {s.note && <div className="muted">{s.note}</div>}
              </td>
              <td>
                <NumberField value={s.distancePerDay} onChange={(v) => update(s.id, { distancePerDay: v })} />
              </td>
              <td>
                <NumberField value={s.daysPerWeek} onChange={(v) => update(s.id, { daysPerWeek: v })} />
              </td>
              {WEEK_BLOCKS.map((block) => (
                <BlockOpenCapCell
                  key={block.join('-')}
                  site={s}
                  block={block}
                  onToggleBlock={toggleBlock}
                  onCapacityBlock={setBlockCapacity}
                />
              ))}
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

  const toggleWeek = (site, week) => {
    const weeksOpen = site.weeksOpen.includes(week)
      ? site.weeksOpen.filter((w) => w !== week)
      : [...site.weeksOpen, week].sort((a, b) => a - b);
    update(site.id, { weeksOpen });
  };

  const setCapacity = (site, week, value) => {
    update(site.id, { capacityByWeek: { ...site.capacityByWeek, [week]: value } });
  };

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Site</th>
            <th>Distance / day</th>
            <th>Days at site</th>
            <th>Days at Main</th>
            {[1, 2, 3, 4, 5, 6].map((w) => (
              <th key={w}>W{w} open / cap</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.sites.pem.map((s) => (
            <tr key={s.id}>
              <td>
                {s.name}
                {s.note && <div className="muted">{s.note}</div>}
              </td>
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
              {[1, 2, 3, 4, 5, 6].map((w) => (
                <WeekOpenCapCell key={w} site={s} week={w} onToggle={toggleWeek} onCapacity={setCapacity} />
              ))}
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

function CommunitySiteRow({ s, isSubRow, update, toggleWeek, setCapacity, onRemove, onAvailableChange }) {
  return (
    <tr className={isSubRow ? 'community-subrow' : undefined}>
      <td>
        <input
          type="checkbox"
          checked={s.available}
          onChange={(e) => (onAvailableChange ? onAvailableChange(e.target.checked) : update(s.id, { available: e.target.checked }))}
        />
      </td>
      <td className={isSubRow ? 'community-subrow__name' : undefined}>
        {isSubRow ? `↳ ${s.preceptors?.[0] || s.name}` : s.name}
        {!isSubRow && s.preceptors?.length > 0 && <div className="muted">{s.preceptors.join('; ')}</div>}
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
        <input type="checkbox" checked={s.isAustin} onChange={(e) => update(s.id, { isAustin: e.target.checked })} />
      </td>
      <td>
        <input
          type="checkbox"
          checked={s.requiresSpanish}
          onChange={(e) => update(s.id, { requiresSpanish: e.target.checked })}
        />
      </td>
      {[1, 2, 3, 4, 5, 6].map((w) => (
        <WeekOpenCapCell key={w} site={s} week={w} onToggle={toggleWeek} onCapacity={setCapacity} disabled={!s.available} />
      ))}
      <td>
        <button onClick={onRemove}>Remove</button>
      </td>
    </tr>
  );
}

const COMMUNITY_TABLE_COLSPAN = 15;

function CommunityTable() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [filter, setFilter] = useState('');
  const [newSiteName, setNewSiteName] = useState('');
  const [newSiteDistance, setNewSiteDistance] = useState(0);
  const [newSitePreceptor, setNewSitePreceptor] = useState('');
  const [newDoctorByParent, setNewDoctorByParent] = useState({});

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

  const families = useMemo(() => {
    const list = state.sites.community;
    const parents = list.filter((s) => !s.splitFromId);
    return parents.map((parent) => ({
      parent,
      children: list.filter((s) => s.splitFromId === parent.id),
    }));
  }, [state.sites.community]);

  const filteredFamilies = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return families;
    return families.filter(({ parent, children }) => {
      const haystack = [
        parent.name,
        parent.category,
        ...(parent.preceptors || []),
        ...children.flatMap((c) => [c.name, ...(c.preceptors || [])]),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [families, filter]);

  const shownCount = filteredFamilies.reduce((n, f) => n + 1 + f.children.length, 0);

  const handleAddSite = () => {
    if (!newSiteName.trim()) return;
    const id = `custom-${Date.now()}`;
    const preceptor = newSitePreceptor.trim();
    dispatch({
      type: 'ADD_COMMUNITY_SITE',
      site: {
        id,
        name: preceptor ? `${newSiteName.trim()} — ${preceptor}` : newSiteName.trim(),
        category: 'Custom',
        distance: Number(newSiteDistance) || 0,
        isSubspecialty: false,
        isAustin: false,
        requiresSpanish: false,
        preceptors: preceptor ? [preceptor] : [],
        available: true,
        weeksOpen: [1, 2, 3, 4, 5, 6],
        capacityByWeek: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 },
      },
    });
    setNewSiteName('');
    setNewSiteDistance(0);
    setNewSitePreceptor('');
  };

  const handleAddDoctor = (parent) => {
    const name = (newDoctorByParent[parent.id] || '').trim();
    if (!name) return;
    dispatch({
      type: 'ADD_COMMUNITY_SITE',
      site: {
        id: `${parent.id}--custom-${Date.now()}`,
        name: `${parent.name} — ${name}`,
        category: parent.category,
        distance: parent.distance,
        isSubspecialty: parent.isSubspecialty,
        isAustin: parent.isAustin,
        requiresSpanish: false,
        preceptors: [name],
        available: true,
        weeksOpen: [1, 2, 3, 4, 5, 6],
        capacityByWeek: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 },
        isBackupPreceptor: false,
        splitFromId: parent.id,
      },
    });
    setNewDoctorByParent((prev) => ({ ...prev, [parent.id]: '' }));
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <input
          type="text"
          placeholder="Filter sites by name/category/doctor..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ width: 260 }}
        />
        <span className="muted">{shownCount} of {state.sites.community.length} sites</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Available</th>
              <th>Site / Doctor</th>
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
            {filteredFamilies.map(({ parent, children }) => (
              <FamilyGroup
                key={parent.id}
                parent={parent}
                children={children}
                update={update}
                toggleWeek={toggleWeek}
                setCapacity={setCapacity}
                onRemove={(id) => dispatch({ type: 'REMOVE_COMMUNITY_SITE', siteId: id })}
                newDoctorName={newDoctorByParent[parent.id] || ''}
                onNewDoctorNameChange={(v) => setNewDoctorByParent((prev) => ({ ...prev, [parent.id]: v }))}
                onAddDoctor={() => handleAddDoctor(parent)}
              />
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
          type="text"
          placeholder="Doctor name (optional)"
          value={newSitePreceptor}
          onChange={(e) => setNewSitePreceptor(e.target.value)}
          style={{ width: 200 }}
        />
        <input
          type="number"
          placeholder="Distance"
          value={newSiteDistance}
          onChange={(e) => setNewSiteDistance(e.target.value)}
          style={{ width: 80 }}
        />
        <button onClick={handleAddSite}>Add new site</button>
      </div>
      <p className="muted">
        Use "Add new site" for a brand-new practice. To add another doctor at an existing site, use
        the "+ Add doctor" row underneath that site instead.
      </p>
    </div>
  );
}

function FamilyGroup({ parent, children, update, toggleWeek, setCapacity, onRemove, newDoctorName, onNewDoctorNameChange, onAddDoctor }) {
  const handleParentAvailableChange = (checked) => {
    update(parent.id, { available: checked });
    // Unchecking the site closes it for every doctor too. Re-checking it
    // does NOT auto re-enable doctors — the coordinator opts each back in,
    // so a doctor who actually left the practice doesn't silently reappear.
    if (!checked) {
      children.forEach((child) => update(child.id, { available: false }));
    }
  };

  return (
    <>
      <CommunitySiteRow
        s={parent}
        isSubRow={false}
        update={update}
        toggleWeek={toggleWeek}
        setCapacity={setCapacity}
        onRemove={() => onRemove(parent.id)}
        onAvailableChange={handleParentAvailableChange}
      />
      {children.map((child) => (
        <CommunitySiteRow
          key={child.id}
          s={child}
          isSubRow
          update={update}
          toggleWeek={toggleWeek}
          setCapacity={setCapacity}
          onRemove={() => onRemove(child.id)}
        />
      ))}
      <tr className="community-subrow community-subrow--add">
        <td colSpan={COMMUNITY_TABLE_COLSPAN}>
          <div className="row">
            <input
              type="text"
              placeholder={`+ Add another doctor at ${parent.name}...`}
              value={newDoctorName}
              onChange={(e) => onNewDoctorNameChange(e.target.value)}
              style={{ width: 260 }}
            />
            <button onClick={onAddDoctor}>+ Add doctor</button>
          </div>
        </td>
      </tr>
    </>
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
