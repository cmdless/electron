import { useState } from 'react';

export default function PickPrompt() {
  const [prompt, setPrompt] = useState('');

  return (
    <div>
      <h1>Pick a prompt</h1>
      <p>Type a prompt directly, or paste a path to a file to use its contents.</p>
      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        placeholder="Fix the failing tests in src/..."
        style={{ width: '100%', height: 120 }}
      />
      <div>
        <button type="button" disabled={!prompt} onClick={() => {
          window.cmdless.ipc.notify.resolve({ value: { prompt } });
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
