import { useLayoutEffect, useRef } from 'react';
import { logProtocol } from '../shared/protocols';
import { useBackend, useChannel } from './backend';

// how close to the bottom counts as at it, in pixels
const STUCK_WITHIN = 24;

// the tray's log, as it grows: it stays at the bottom while it's scrolled
// there, and stays put while it's scrolled up to read something
export default function LogViewer() {
  const { client, error } = useBackend(logProtocol);
  const log = useChannel(client?.state.log);
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stuck.current) element.scrollTop = element.scrollHeight;
  }, [log]);

  const onScroll = () => {
    const element = scroller.current;
    if (element) stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight <= STUCK_WITHIN;
  };

  return (
    <main className="log">
      <header>{error ?? log?.file ?? 'Connecting…'}</header>
      <div className="lines" ref={scroller} onScroll={onScroll}>
        <pre>{log?.lines.join('\n')}</pre>
      </div>
    </main>
  );
}
