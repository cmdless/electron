import { useHashRoute } from './router';
import Agents from './routes/Agents';

const routes: Record<string, () => React.JSX.Element> = {
  '/': Agents,
  '/agents': Agents,
};

function App() {
  const route = useHashRoute();
  const Route = routes[route];
  return Route ? <Route /> : <p>Unknown route: {route}</p>;
}

export default App;
