// The page's door to the shell (src/shell.ts): request/answer over one IPC
// channel, and the shell's unasked events. Nothing else crosses: the page
// runs with context isolation and the sandbox on.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('claerbout', {
  request: (message) => ipcRenderer.invoke('claerbout:request', message),
  // The path of a File the page holds (from a handle's getFile(), a
  // drop, a picker): a File object crosses the bridge, and the path is
  // the one thing a page that keeps files by handle (Plass) cannot learn
  // itself. '' when Chromium has none for it. A page sends the path back
  // as a `document` request so the shell knows the window's file.
  pathOf: (file) => {
    try {
      return webUtils.getPathForFile(file) ?? '';
    } catch {
      return '';
    }
  },
  on: (event, listener) => {
    const relay = (_ipc, name, detail) => {
      if (name === event) listener(detail);
    };
    ipcRenderer.on('claerbout:event', relay);
    return () => ipcRenderer.removeListener('claerbout:event', relay);
  },
});
