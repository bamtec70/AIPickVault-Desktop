const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile("index.html");
}

async function callOllama(messages, model = "llama3") {
  const response = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false
    })
  });

  const data = await response.json();

  return data.message?.content || "";
}

ipcMain.handle("ask-model", async (event, data) => {
  try {
    const result = await callOllama(
      [
        {
          role: "user",
          content: data.message
        }
      ],
      data.model || "llama3"
    );

    return {
      text: result,
      model: data.model || "llama3"
    };
  } catch (err) {
    console.error(err);

    return {
      text: `Error: ${err.message}`,
      model: "Error"
    };
  }
});

app.whenReady().then(createWindow);