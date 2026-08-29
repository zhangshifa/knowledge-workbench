# 桌面端（Electron）

桌面端是一个**轻量壳**：本机拉起 `server/src/index.js`，再用窗口加载 `http://127.0.0.1:8787`。
这样桌面端、Web 端、移动端共享同一套服务端代码与同一份数据（`data/`）。

## 前提
- 本机已安装 Node.js ≥ 18，且在 `PATH` 中（如不在，设置环境变量 `KB_NODE_BIN` 指定 node 路径）。
- 已 `cd` 到仓库根目录（本目录与 `server/` 同级）。

## 运行
```bash
cd desktop
npm install        # 仅安装 electron 开发依赖
npm run desktop    # 启动桌面窗口
```

## 打包（可选）
```bash
npm install -D @electron/packager
npx electron-packager . knowledge-workbench --out=dist --overwrite
```

> 说明：本端默认绑定 `127.0.0.1`，服务进程随窗口关闭而退出，数据落在 `../data`。
