import LogViewer from './LogViewer';

// the page the tray opens, by the route after the # in its URL
export default function App() {
  const route = window.location.hash.replace(/^#/, '');
  if (route === '/log') return <LogViewer />;
  return <p>Nothing here: {route || '/'}</p>;
}
