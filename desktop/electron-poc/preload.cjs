const { contextBridge, ipcRenderer } = require('electron');
// No filesystem/path arguments or generic IPC are exposed to the renderer.
contextBridge.exposeInMainWorld('paperEchoFirstRun', Object.freeze({
  status: () => ipcRenderer.invoke('first-run-directory', 'status'),
  choose: () => ipcRenderer.invoke('first-run-directory', 'choose'),
}));
contextBridge.exposeInMainWorld('paperEchoLoginStartup', Object.freeze({
  status: () => ipcRenderer.invoke('login-startup', 'status'),
  set: enabled => ipcRenderer.invoke('login-startup', 'set', enabled),
}));
