import { useAppState, useAppDispatch } from './state/AppContext';
import Step1TermRoster from './steps/Step1TermRoster';
import Step2SiteDirectory from './steps/Step2SiteDirectory';
import Step3Preferences from './steps/Step3Preferences';
import Step4ManualLocks from './steps/Step4ManualLocks';
import Step5Generate from './steps/Step5Generate';
import Step6Results from './steps/Step6Results';
import ProjectToolbar from './components/ProjectToolbar';

const STEPS = [
  { n: 1, label: 'Term Setup & Roster' },
  { n: 2, label: 'Site Directory' },
  { n: 3, label: 'Preferences' },
  { n: 4, label: 'Manual Locks' },
  { n: 5, label: 'Generate' },
  { n: 6, label: 'Results' },
];

function canReach(step, state) {
  if (step <= 1) return true;
  if (step === 2) return state.roster.length > 0 && state.term.weeks.length > 0;
  if (step >= 3 && step <= 5) return state.roster.length > 0 && state.term.weeks.length > 0;
  if (step === 6) return !!state.schedule;
  return true;
}

function StepNav() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  return (
    <nav className="step-nav">
      {STEPS.map((s) => {
        const reachable = canReach(s.n, state);
        return (
          <button
            key={s.n}
            className={`step-nav__item${state.step === s.n ? ' step-nav__item--active' : ''}`}
            disabled={!reachable}
            onClick={() => dispatch({ type: 'SET_STEP', step: s.n })}
          >
            <span className="step-nav__num">{s.n}</span>
            {s.label}
          </button>
        );
      })}
    </nav>
  );
}

function StepBody() {
  const state = useAppState();
  switch (state.step) {
    case 1:
      return <Step1TermRoster />;
    case 2:
      return <Step2SiteDirectory />;
    case 3:
      return <Step3Preferences />;
    case 4:
      return <Step4ManualLocks />;
    case 5:
      return <Step5Generate />;
    case 6:
      return <Step6Results />;
    default:
      return null;
  }
}

export default function App() {
  return (
    <div className="app">
      <header className="app__header">
        <h1>Pediatric Clerkship Scheduler</h1>
        <ProjectToolbar />
      </header>
      <StepNav />
      <main className="app__main">
        <StepBody />
      </main>
    </div>
  );
}
