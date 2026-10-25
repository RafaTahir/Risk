import { io, type Socket } from 'socket.io-client';
import type { RoomState, ServerResponse, Session } from '../../shared/types';

type Listener = (...args: any[]) => void;
type Response = ServerResponse & { state?: RoomState };
type Ack = (error: Error | null, result: ServerResponse) => void;

/** Keeps the UI protocol shared by the Node socket server and the durable HTTP Worker. */
export class CampaignTransport {
  private listeners = new Map<string, Listener[]>();
  private socket: Socket | null = null;
  private session: Session | null = null;
  private desired = false;
  private online = false;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activePoll: number | null = null;
  private pollSequence = 0;
  private pollDelay = 1200;
  private failures = 0;
  private lastState: RoomState | null = null;
  private mode: 'http' | 'socket' | null = null;

  get connected() { return this.socket?.connected ?? this.online; }
  on(event: string, listener: Listener) { this.listeners.set(event, [...(this.listeners.get(event) || []), listener]); return this; }
  private notify(event: string, ...args: any[]) { for (const listener of this.listeners.get(event) || []) listener(...args); }
  connect() {
    if (this.desired) return this;
    this.desired = true;
    if (this.socket) this.socket.connect();
    else void this.open(++this.epoch);
    return this;
  }
  disconnect() {
    this.desired = false; this.epoch++;
    clearTimeout(this.timer); this.timer = undefined;
    this.activePoll = null;
    this.socket?.disconnect();
    if (this.online) { this.online = false; this.notify('disconnect'); }
    return this;
  }
  timeout(milliseconds: number) { return { emit: (event: string, payload: unknown, ack: Ack) => void this.send(event, payload, ack, milliseconds) }; }
  private async json(path: string, payload: unknown, milliseconds = 8000): Promise<{ response: globalThis.Response; body: Response }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), milliseconds);
    try {
      const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(payload), signal: controller.signal });
      const body = await response.json() as Response;
      if (typeof body.ok !== 'boolean') throw new Error('Invalid command-server response.');
      return { response, body };
    } finally { clearTimeout(timeout); }
  }
  private deliver(state: RoomState) {
    if (this.lastState?.code === state.code) {
      if (state.revision < this.lastState.revision) return;
      if (state.revision === this.lastState.revision) {
        const presence = (room: RoomState) => room.players.map(p => `${p.id}:${p.connected}`).join('|');
        if (presence(state) === presence(this.lastState)) return;
      }
    }
    this.lastState = state;
    this.notify('room:state', state);
  }
  private async open(epoch: number) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/transport', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('The command server is unavailable.');
      const config = await response.json() as { mode: string; persistence?: string; pollIntervalMs?: number };
      if (!this.desired || epoch !== this.epoch) return;
      this.notify('configuration', config);
      if (config.mode === 'http') {
        this.mode = 'http'; this.pollDelay = Math.max(500, Math.min(5000, config.pollIntervalMs || 1200));
        this.online = true; this.failures = 0; this.notify('connect'); this.schedulePoll();
      } else if (config.mode === 'socket') {
        this.mode = 'socket'; this.socket = io({ autoConnect: false, reconnection: true });
        for (const event of ['connect', 'disconnect', 'connect_error', 'room:removed', 'session:replaced']) this.socket.on(event, (...args: any[]) => this.notify(event, ...args));
        this.socket.on('room:state', (state: RoomState) => this.deliver(state));
        this.socket.connect();
      } else throw new Error('Unsupported command-server transport.');
    } catch (error) {
      if (this.desired && epoch === this.epoch) {
        this.online = false; this.notify('connect_error', error);
        this.timer = setTimeout(() => void this.open(epoch), Math.min(10000, 1200 * 2 ** Math.min(this.failures++, 3)));
      }
    } finally { clearTimeout(timeout); }
  }
  private async send(event: string, payload: unknown, ack: Ack, milliseconds: number) {
    if (this.socket) { this.socket.timeout(milliseconds).emit(event, payload, ack); return; }
    if (!this.desired || this.mode !== 'http' || !this.online) { ack(new Error('Disconnected.'), { ok: false }); return; }
    const epoch = this.epoch;
    const authentication = event === 'room:resume' ? payload as Session : this.session;
    try {
      const { response, body } = await this.json('/api/command', { event, payload, ...(authentication ? { session: authentication } : {}) }, milliseconds);
      if (!this.desired || epoch !== this.epoch) { ack(new Error('Connection changed.'), { ok: false }); return; }
      if (response.status >= 500) throw new Error(body.error || 'The command server is unavailable.');
      if (body.ok && body.session) { this.session = body.session; this.lastState = null; }
      if (body.state) this.deliver(body.state);
      if (body.ok && event === 'room:leave') { this.session = null; this.lastState = null; clearTimeout(this.timer); }
      ack(null, body);
      if (this.session) this.schedulePoll();
    } catch (error) { ack(error instanceof Error ? error : new Error('Connection failed.'), { ok: false }); }
  }
  private schedulePoll(delay?: number) {
    clearTimeout(this.timer);
    if (!this.desired || !this.session || this.activePoll !== null || this.mode !== 'http') return;
    const game = this.lastState?.game;
    const thinking = game?.phase !== 'gameover' && game?.players[game.currentPlayer]?.isAI;
    const interval = document.hidden ? 5000 : thinking ? 450 : this.pollDelay;
    this.timer = setTimeout(() => void this.poll(), delay ?? interval);
  }
  private async poll() {
    if (this.activePoll !== null || !this.desired || !this.session) return;
    const epoch = this.epoch; const session = this.session;
    const ticket = ++this.pollSequence;
    this.activePoll = ticket;
    let retry = this.pollDelay;
    try {
      const { response, body } = await this.json('/api/poll', { session, revision: this.lastState?.revision });
      if (!this.desired || epoch !== this.epoch || session !== this.session) return;
      if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 410) {
        this.session = null; this.lastState = null; this.notify('room:removed', body.error || 'This room has expired. Start a new campaign.'); return;
      }
      if (!response.ok || !body.ok) throw new Error(body.error || 'Room synchronization failed.');
      this.failures = 0;
      if (!this.online) { this.online = true; this.notify('connect'); }
      if (body.state) this.deliver(body.state);
    } catch (error) {
      if (this.desired && epoch === this.epoch) {
        if (this.online) { this.online = false; this.notify('disconnect'); }
        this.notify('connect_error', error); retry = Math.min(10000, 1200 * 2 ** Math.min(this.failures++, 3));
      }
    } finally { if (this.activePoll === ticket) this.activePoll = null; if (this.desired && epoch === this.epoch) this.schedulePoll(this.failures ? retry : undefined); }
  }
}
