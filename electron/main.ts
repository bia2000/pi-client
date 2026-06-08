import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { PiChatService } from "./pi-chat-service";

let mainWindow: BrowserWindow | null = null;
const chatService = new PiChatService();

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 760,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#07111f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  ipcMain.handle("chat:runtime-info", async () => chatService.getRuntimeInfo());

  ipcMain.handle("chat:reset-session", async () => chatService.reset());

  ipcMain.handle("chat:send-message", async (_event, prompt: string) => {
    if (!mainWindow) {
      return;
    }

    await chatService.sendPrompt(prompt, {
      onDelta: (payload) => {
        mainWindow?.webContents.send("chat:assistant-delta", payload);
      },
      onDone: (payload) => {
        mainWindow?.webContents.send("chat:assistant-done", payload);
      },
      onError: (payload) => {
        mainWindow?.webContents.send("chat:assistant-error", payload);
      },
    });
  });

  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
