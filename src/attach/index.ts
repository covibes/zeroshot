/** tmux-style attach/detach session management for tasks and clusters. */
import AttachClient from './attach-client';
import AttachServer from './attach-server';
import protocol from './protocol';
import RingBuffer from './ring-buffer';
import sendInputModule from './send-input';
import socketDiscovery from './socket-discovery';

const { sendInput } = sendInputModule;

export = {
  AttachServer,
  AttachClient,
  RingBuffer,
  protocol,
  socketDiscovery,
  sendInput,
};
