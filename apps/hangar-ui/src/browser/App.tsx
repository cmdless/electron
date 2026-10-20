import { useHashRoute } from './router'
import Agents from './routes/Agents'
import Chat from './routes/Chat'
import Placeholder from './routes/Placeholder'

const screens: Record<string, () => React.JSX.Element> = {
  '/agents': Agents,
  '/providers': () => <Placeholder title="Providers" text="pi's model providers will be managed here." />,
  '/mcp': () => <Placeholder title="MCP" text="MCP servers will be managed here." />,
  '/chat': Chat,
}

function App() {
  const route = useHashRoute()
  const Screen = screens[route] ?? Agents
  return <Screen />
}

export default App
