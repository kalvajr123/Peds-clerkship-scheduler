const PROJECT_VERSION = 1;

/** Serializes the whole app state to a downloadable JSON file. */
export function saveProjectAsJSON(state, fileName = 'clerkship_project.json') {
  const payload = { version: PROJECT_VERSION, savedAt: new Date().toISOString(), state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Reads a project JSON File object and resolves to the saved state. */
export function loadProjectFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(reader.result);
        resolve(payload.state || payload);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
