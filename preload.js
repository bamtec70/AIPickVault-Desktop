const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  askModel: (data) => ipcRenderer.invoke("ask-model", data),

  onAskModelNote: (callback) => {
    const handler = (_event, payload) => {
      if (typeof callback === "function") callback(payload);
    };
    ipcRenderer.on("ask-model-note", handler);
    return () => ipcRenderer.removeListener("ask-model-note", handler);
  },

  onAskModelChunk: (callback) => {
    const handler = (_event, payload) => {
      if (typeof callback === "function") callback(payload);
    };
    ipcRenderer.on("ask-model-chunk", handler);
    return () => ipcRenderer.removeListener("ask-model-chunk", handler);
  },

  onAskModelDone: (callback) => {
    const handler = (_event, payload) => {
      if (typeof callback === "function") callback(payload);
    };
    ipcRenderer.on("ask-model-done", handler);
    return () => ipcRenderer.removeListener("ask-model-done", handler);
  },

  onAskModelError: (callback) => {
    const handler = (_event, payload) => {
      if (typeof callback === "function") callback(payload);
    };
    ipcRenderer.on("ask-model-error", handler);
    return () => ipcRenderer.removeListener("ask-model-error", handler);
  }
});
