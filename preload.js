const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  askModel: (data) => ipcRenderer.invoke("ask-model", data)
});
