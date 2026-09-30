// The page's door to the shell (src/shell.ts): request/answer over one IPC
// channel, and the shell's unasked events. Nothing else crosses: the page
// runs with context isolation and the sandbox on.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claerbout', {
  request: (message) => ipcRenderer.invoke('claerbout:request', message),
  on: (event, listener) => {
    const relay = (_ipc, name, detail) => {
      if (name === event) listener(detail);
    };
    ipcRenderer.on('claerbout:event', relay);
    return () => ipcRenderer.removeListener('claerbout:event', relay);
  },
});
