import { useHashRoute } from './router';
import PickDirectory from './routes/PickDirectory';
import PickPrompt from './routes/PickPrompt';
import PickAgent from './routes/PickAgent';
import Permission from './routes/Permission';
import Elicitation from './routes/Elicitation';
import Conversation from './routes/Conversation';
import SessionConfig from './routes/SessionConfig';

const routes: Record<string, () => React.JSX.Element> = {
  '/pick-directory': PickDirectory,
  '/pick-prompt': PickPrompt,
  '/pick-agent': PickAgent,
  '/permission': Permission,
  '/elicitation': Elicitation,
  '/conversation': Conversation,
  '/session-config': SessionConfig,
};

function App() {
  const route = useHashRoute();
  const Route = routes[route];
  return Route ? <Route /> : <p>Unknown route: {route}</p>;
}

export default App;
