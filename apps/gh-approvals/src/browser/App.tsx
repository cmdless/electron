import Approvals from './Approvals';
import LogViewer from './LogViewer';
import Shortcuts from './Shortcuts';

// the page the tray opens, by the route after the # in its URL
export default function App() {
  const route = window.location.hash.replace(/^#/, '');
  if (route === '/approvals') return <Approvals />;
  if (route === '/log') return <LogViewer />;
  if (route === '/shortcuts') return <Shortcuts />;
  return <p>Nothing here: {route || '/'}</p>;
}
