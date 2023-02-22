import { app, BrowserWindow, ipcMain, IpcMainEvent } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as proc from 'child_process';

const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const cache_dir = path.join(app.getPath("temp"),"gisst");
const resource_dir = path.resolve(__dirname, 'resources');
const config_dir = app.getPath("userData");
const content_dir = path.join(cache_dir, "content");
const saves_dir = path.join(cache_dir, "saves");
const states_dir = path.join(cache_dir, "states")

const createWindow = (): void => {
  //app.setAsDefaultProtocolClient(protocol[, path, args]);

  fs.mkdirSync(path.join(cache_dir, "core-options"), {recursive:true});
  fs.mkdirSync(path.join(cache_dir, "cache"), {recursive:true});
  fs.mkdirSync(path.join(cache_dir, "screenshots"), {recursive:true});
  fs.mkdirSync(path.join(config_dir, "remaps"), {recursive:true});

  fs.rmSync(content_dir, {recursive:true,force:true});
  // TODO replace with downloading from a URL in handle_run_retroarch
  fs.cpSync(path.join(resource_dir,"content"), content_dir, {recursive:true});

  let cfg = fs.readFileSync(path.join(resource_dir, 'ra-config-base.cfg'), {encoding:"utf8"});
  cfg = cfg.replace(/\$RESOURCE/g, resource_dir);
  cfg = cfg.replace(/\$CACHE/g, cache_dir);
  cfg = cfg.replace(/\$CONFIG/g, config_dir);
  fs.writeFileSync(path.join(cache_dir, "retroarch.cfg"),cfg);

  fs.chmodSync(path.join(resource_dir,"binaries","retroarch"),"777");
  //TODO: chmod +x retroarch bin
  
  ipcMain.on('gisst:run', handle_run_retroarch);

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    height: 600,
    width: 800,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  // and load the index.html of the app.
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

let save_listener:fs.FSWatcher = null;
let state_listener:fs.FSWatcher = null;

function handle_run_retroarch(evt:IpcMainEvent, core:string,content:string,entryState:boolean,movie:boolean) {
  console.assert(!(entryState && movie), "It is invalid to have both an entry state and play back a movie");
  const content_base = content.substring(0, content.lastIndexOf("."));
  let retro_args = ["-v", "-c", path.join(cache_dir, "retroarch.cfg"), "--appendconfig", path.join(content_dir, "retroarch.cfg"), "-L", core];
  if (entryState) {
    retro_args.push("-e");
    retro_args.push("1");
  }
  if (movie) {
    retro_args.push("-P");
    retro_args.push(path.join(content_dir,"/movie.bsv"));
  } else {
    retro_args.push("-R");
    retro_args.push(path.join(content_dir, "/movie.bsv"));
  }
  retro_args.push(path.join(content_dir, content));
  console.log(retro_args);
  if (entryState) {
    fs.cpSync(path.join(content_dir, "entry_state"), path.join(cache_dir, "states", content_base+".state1.entry"));
  }

  if(save_listener != null) {
    save_listener.close();
    save_listener = null;
  }
  if(state_listener != null) {
    state_listener.close();
    state_listener = null;
  }
  fs.rmSync(saves_dir, {recursive:true,force:true});
  fs.rmSync(states_dir, {recursive:true,force:true});
  fs.mkdirSync(saves_dir, {recursive:true});
  fs.mkdirSync(states_dir, {recursive:true});
  const seenSaves:string[] = [];
  save_listener = fs.watch(saves_dir, {"persistent":false}, function(_file_evt, name) {
    console.log("saves",_file_evt,name);
    if(!seenSaves.includes(name)) {
      seenSaves.push(name);
      evt.sender.send('gisst:saves_changed', {
        "file":name,
      });
    }
  });
  const seenStates:Record<string, Uint8Array> = {};
  state_listener = fs.watch(states_dir, {"persistent":false}, function(_file_evt, name) {
    console.log("states",_file_evt,name);
    if(name.endsWith(".png")) {
      const img_path = path.join(states_dir,name);
      console.log("img",img_path,fs.statSync(img_path));
      const file_name = name.substring(0, name.length-4);
      if(file_name in seenStates) {
        console.log("seen image already");
        return;
      }
      if(fs.statSync(img_path).size == 0) {
        console.log("image file is empty");
        return;
      }
      console.log("image ready, send along",fs.statSync(img_path));
      const image_data = fs.readFileSync(img_path);
      seenStates[file_name] = image_data;
      evt.sender.send('gisst:states_changed', {
        "file": file_name,
        "thumbnail_png_b64": image_data.toString('base64')
      });
    }
  });

  const is_darwin = process.platform === "darwin";
  let binary;
  if(is_darwin) {
    binary = "open";
    const open_args = ["-a", path.join(resource_dir,"binaries","RetroArch.app"), "--args"];
    retro_args = open_args + retro_args;
  } else {
    binary = path.join(resource_dir,"binaries","retroarch");
  }
  const proc = proc.spawn(binary, retro_args, {"windowsHide":true,"detached":false});
  proc.stdout.on('data', (data) => console.log("out",data.toString()));
  proc.stderr.on('data', (data) => console.log("err",data.toString()));
  proc.on('close', (exit_code) => console.log("exit",exit_code));
  proc.on('error', (error) => console.error("failed to start RA",error));
}

