import { createContext, useContext, useReducer, useMemo } from 'react';
import defaultSites from '../data/defaultSites.json';
import { generateTermWeeks, isMonday } from '../lib/weeks';
import { assignStudentIds } from '../lib/csv';
import { parseAllPreferences } from '../lib/preferences';
import { recomputeStats } from '../lib/scheduler';

export const PREFERENCE_TEXT_DEFAULTS = {
  spanish: '',
  christus: '',
  austin: '',
  katyPHM: '',
  katyPEM: '',
  woodlandsPEM: '',
};

function cloneDefaultSites() {
  return {
    phm: defaultSites.phmSites.map((s) => ({ ...s })),
    pem: defaultSites.pemSites.map((s) => ({ ...s })),
    newborn: defaultSites.newbornSites.map((s) => ({ ...s })),
    community: defaultSites.communitySites.map((s) => ({
      ...s,
      weeksOpen: [...s.weeksOpen],
      capacityByWeek: { ...s.capacityByWeek },
      preceptors: [...(s.preceptors || [])],
    })),
  };
}

export function initialState() {
  return {
    step: 1,
    term: {
      startDate: '',
      confirmedNonMonday: false,
      weeks: [],
    },
    roster: [],
    sites: cloneDefaultSites(),
    preferencesText: { ...PREFERENCE_TEXT_DEFAULTS },
    preferencesParsed: null,
    manualLocks: [],
    schedule: null,
    zThreshold: 1.5,
  };
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_STEP':
      return { ...state, step: action.step };

    case 'SET_TERM_START_DATE': {
      const startISO = action.startISO;
      return {
        ...state,
        term: {
          startDate: startISO,
          confirmedNonMonday: isMonday(startISO) ? true : state.term.confirmedNonMonday,
          weeks: generateTermWeeks(startISO),
        },
        schedule: null,
      };
    }

    case 'CONFIRM_NON_MONDAY':
      return { ...state, term: { ...state.term, confirmedNonMonday: true } };

    case 'SET_ROSTER_NAMES':
      return { ...state, roster: assignStudentIds(action.names), schedule: null, manualLocks: [] };

    case 'UPDATE_SITE': {
      const { pool, siteId, patch } = action;
      return {
        ...state,
        sites: {
          ...state.sites,
          [pool]: state.sites[pool].map((s) => (s.id === siteId ? { ...s, ...patch } : s)),
        },
        schedule: null,
      };
    }

    case 'ADD_COMMUNITY_SITE': {
      return {
        ...state,
        sites: { ...state.sites, community: [...state.sites.community, action.site] },
        schedule: null,
      };
    }

    case 'REMOVE_COMMUNITY_SITE': {
      return {
        ...state,
        sites: {
          ...state.sites,
          community: state.sites.community.filter((s) => s.id !== action.siteId),
        },
        schedule: null,
      };
    }

    case 'SET_PREFERENCE_TEXT':
      return {
        ...state,
        preferencesText: { ...state.preferencesText, [action.key]: action.text },
        schedule: null,
      };

    case 'SET_PARSED_PREFERENCES':
      return { ...state, preferencesParsed: action.parsed };

    case 'ADD_LOCK':
      return { ...state, manualLocks: [...state.manualLocks, action.lock], schedule: null };

    case 'REMOVE_LOCK':
      return {
        ...state,
        manualLocks: state.manualLocks.filter((l) => l.id !== action.lockId),
        schedule: null,
      };

    case 'SET_SCHEDULE':
      return { ...state, schedule: action.schedule };

    case 'SET_Z_THRESHOLD':
      return { ...state, zThreshold: action.threshold };

    case 'OVERRIDE_ASSIGNMENT': {
      if (!state.schedule) return state;
      const { studentId, weekIndex, siteId, siteName, distance, rotation } = action;
      const schedule = state.schedule;
      const weekly = {
        ...schedule.weekly,
        [studentId]: {
          ...schedule.weekly[studentId],
          [weekIndex]: { rotation, siteId, siteName, distance },
        },
      };
      const mileage = { ...schedule.mileage };
      let total = 0;
      for (let w = 1; w <= 6; w++) {
        total += weekly[studentId][w]?.distance || 0;
      }
      mileage[studentId] = total;
      const studentIds = state.roster.map((s) => s.id);
      const stats = recomputeStats(studentIds, mileage);
      return {
        ...state,
        schedule: {
          ...schedule,
          weekly,
          mileage,
          rank: stats.rank,
          zScore: stats.zScore,
          mean: stats.mean,
          std: stats.std,
        },
      };
    }

    case 'LOAD_PROJECT':
      return action.state;

    case 'RESET':
      return initialState();

    default:
      return state;
  }
}

const AppStateContext = createContext(null);
const AppDispatchContext = createContext(null);

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>{children}</AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within AppProvider');
  return ctx;
}

export function useAppDispatch() {
  const ctx = useContext(AppDispatchContext);
  if (!ctx) throw new Error('useAppDispatch must be used within AppProvider');
  return ctx;
}

/** Recomputes fuzzy-matched preferences whenever text or roster changes. */
export function useParsedPreferences() {
  const state = useAppState();
  return useMemo(
    () => parseAllPreferences(state.preferencesText, state.roster),
    [state.preferencesText, state.roster]
  );
}
