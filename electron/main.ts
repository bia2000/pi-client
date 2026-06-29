import { app, BrowserWindow } from "electron";
import path from "node:path";
import "./main/agents"; // 触发内置 Agent 注册（boss-recruit 等）
import { RecruitmentAgent } from "./main/agent-core";
import { closeDb, initDb } from "./main/db/sqlite";
import { makeTimelineSender, registerIpc } from "./main/ipc";
import { loadSettings } from "./main/settings-store";

let mainWindow: BrowserWindow | null = null;
let dbError: string | undefined;

app.whenReady().then(async () => {
  // 1) 初始化本地牛人库（原生模块加载失败时记录错误，不阻断其余功能）
  try {
    initDb(path.join(app.getPath("userData"), "pi-agent.db"));
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
    console.error("[main] SQLite 初始化失败：", dbError);
  }

  // 2) 加载设置 + 创建招聘 Agent
  loadSettings();
  const getWindow = () => mainWindow;
  const agent = new RecruitmentAgent(app.getAppPath(), {
    onTimeline: makeTimelineSender(getWindow),
    getSettings: () => loadSettings().crawler,
  });

  // 3) 注册 IPC
  registerIpc({ getWindow, agent, dbError });

  // 4) 创建窗口
  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

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

app.on("window-all-closed", () => {
  closeDb();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  closeDb();
});
