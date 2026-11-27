import './styles/theme.css';
import { DetailView } from './detail/DetailView';
import { HudView } from './hud/HudView';

function resolveCurrentView(): 'hud' | 'detail' {
  const params = new URLSearchParams(window.location.search);
  return params.get('view') === 'detail' ? 'detail' : 'hud';
}

export function App() {
  const view = resolveCurrentView();
  return view === 'detail' ? <DetailView /> : <HudView />;
}
