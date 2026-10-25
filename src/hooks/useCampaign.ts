import { useCallback, useEffect, useRef, useState } from 'react';
import { CampaignTransport } from '../lib/campaignTransport';
import type { GameAction, RoomState, ServerResponse, Session } from '../../shared/types';
const KEY = 'risk-world-command-session';
// Unlike randomUUID, getRandomValues also works on ordinary LAN HTTP origins.
function commandId(): string { return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); }
function stored(key = KEY): Session | null { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } }
export function useCampaign() {
  const [session, setSession] = useState<Session | null>(() => stored());
  const sessionRef = useRef(session);
  const [savedSession, setSavedSession] = useState<Session | null>(() => stored(`${KEY}-saved`));
  const [room, setRoom] = useState<RoomState | null>(null);
  const [connected, setConnected] = useState(false);
  const [persistence, setPersistence] = useState<'memory' | 'd1'>('memory');
  const [restoring, setRestoring] = useState(Boolean(session));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const socketRef = useRef<CampaignTransport | null>(null);
  const remember = useCallback((next: Session | null) => {
    sessionRef.current = next; setSession(next);
    try { if (next) sessionStorage.setItem(KEY, JSON.stringify(next)); else sessionStorage.removeItem(KEY); } catch { /* Session remains usable without browser storage. */ }
  }, []);
  useEffect(() => {
    const socket = new CampaignTransport(); socketRef.current = socket;
    socket.on('configuration', (config: { persistence?: string }) => setPersistence(config.persistence === 'd1' ? 'd1' : 'memory'));
    socket.on('room:state', (state: RoomState) => setRoom(state));
    socket.on('connect', () => {
      setConnected(true); setError('');
      if (sessionRef.current) {
        setRestoring(true);
        socket.timeout(8000).emit('room:resume', sessionRef.current, (err: Error | null, result: ServerResponse) => {
          setRestoring(false);
          if (err) setError('Connection restored, but the table could not be recovered. Retry reconnect.');
          else if (!result.ok) { remember(null); setRoom(null); setError(result.error || 'This table has expired. Start a new campaign.'); }
          else if (result.session) remember(result.session);
        });
      } else setRestoring(false);
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => { setConnected(false); setError('The command server is unavailable. Reconnecting automatically…'); });
    socket.on('room:removed', (message?: string) => { remember(null); setRoom(null); setError(message || 'The host removed you from the lobby.'); });
    socket.on('session:replaced', () => { remember(null); setRoom(null); setError('Your seat is now open in another tab.'); });
    socket.connect();
    return () => { socket.disconnect(); socketRef.current = null; };
  }, [remember]);
  const request = useCallback(async (event: string, payload: unknown = {}): Promise<ServerResponse> => {
    const socket = socketRef.current;
    if (!socket?.connected) { const response = { ok: false, error: 'Reconnect before issuing orders.' }; setError(response.error); return response; }
    setPending(true); setError('');
    return new Promise(resolve => socket.timeout(8000).emit(event, payload, (err: Error | null, result: ServerResponse) => {
      setPending(false);
      if (err) { const response = { ok: false, error: 'The server did not confirm this order. Check the updated board before retrying.' }; setError(response.error); resolve(response); return; }
      if (!result.ok) setError(result.error || 'The order could not be completed.');
      if (result.session) remember(result.session);
      resolve(result);
    }));
  }, [remember]);
  const act = useCallback((action: GameAction) => request('game:action', { id: commandId(), revision: room?.revision, action }), [request, room?.revision]);
  const leave = useCallback(async () => {
    const result = await request('room:leave');
    if (result.ok) {
      if (room?.status === 'playing' && sessionRef.current) {
        setSavedSession(sessionRef.current);
        try { sessionStorage.setItem(`${KEY}-saved`, JSON.stringify(sessionRef.current)); } catch { /* optional recovery storage */ }
      }
      remember(null); setRoom(null);
    }
    return result;
  }, [request, remember, room?.status]);
  const resumeSaved = useCallback(async () => {
    if (!savedSession) return;
    const result = await request('room:resume', savedSession);
    if (result.ok || result.error?.includes('expired')) {
      setSavedSession(null);
      try { sessionStorage.removeItem(`${KEY}-saved`); } catch { /* optional recovery storage */ }
    }
  }, [savedSession, request]);
  const reconnect = useCallback(() => { socketRef.current?.disconnect().connect(); }, []);
  return { session, savedSession, resumeSaved, room, connected, persistence, restoring, pending, error, setError, request, act, leave, reconnect };
}
