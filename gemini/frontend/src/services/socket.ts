import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    const token = localStorage.getItem('token');
    const socketUrl = window.location.origin;
    socket = io(socketUrl, {
      auth: { token },
      autoConnect: false,
    });
  }
  return socket;
}

export function connectSocket(): void {
  const s = getSocket();
  if (!s.connected) {
    const token = localStorage.getItem('token');
    s.auth = { token };
    s.connect();
  }
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function joinProject(projectId: string): void {
  const s = getSocket();
  if (s.connected) {
    s.emit('join:project', projectId);
  } else {
    s.once('connect', () => s.emit('join:project', projectId));
  }
}

export function leaveProject(projectId: string): void {
  const s = getSocket();
  s.emit('leave:project', projectId);
}
