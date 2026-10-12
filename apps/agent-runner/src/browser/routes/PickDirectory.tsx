import { useState } from 'react';

export default function PickDirectory() {
  const [directory, setDirectory] = useState('');

  return (
    <div>
      <h1>Pick a directory</h1>
      <input
        value={directory}
        onChange={e => setDirectory(e.target.value)}
        placeholder="/path/to/project"
        style={{ width: '100%' }}
      />
      <div>
        <button type="button" disabled={!directory} onClick={() => {
          window.cmdless.ipc.notify.resolve({ value: { directory } });
        }}>
          OK
        </button>
        <button type="button" onClick={() => {
          window.cmdless.ipc.notify.resolve({ value: null });
        }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
