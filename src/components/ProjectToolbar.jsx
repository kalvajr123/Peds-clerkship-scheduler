import { useRef } from 'react';
import { useAppState, useAppDispatch } from '../state/AppContext';
import { saveProjectAsJSON, loadProjectFromFile } from '../lib/projectIO';

export default function ProjectToolbar() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const fileInputRef = useRef(null);

  const handleSave = () => {
    saveProjectAsJSON(state);
  };

  const handleLoadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const loaded = await loadProjectFromFile(file);
      dispatch({ type: 'LOAD_PROJECT', state: loaded });
    } catch (err) {
      alert('Could not load project file: ' + err.message);
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="project-toolbar">
      <button type="button" onClick={handleSave}>
        Save Project as JSON
      </button>
      <button type="button" onClick={handleLoadClick}>
        Load Project from JSON
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </div>
  );
}
