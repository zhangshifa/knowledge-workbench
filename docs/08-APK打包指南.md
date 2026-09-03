# 08 · APK 打包指南（Capacitor 封装网页）

Android 端用 Capacitor 把 `web/` 前端打包进原生壳，**数据与检索仍由 Python / Node 服务提供**。

```
APK（内嵌 web/ 前端，运行于 https://localhost）
   │
   │  用户在「⚙ 服务设置」填入地址 + Token
   ▼
Python 服务（server_py） ── 数据源同步 / BM25 检索 / MCP
```

## 一、前置条件

| 项 | 本机（Windows） | 云端（GitHub Actions） |
|---|---|---|
| Node ≥ 18 | ✅ | ✅ 自动 |
| JDK 17 | `E:/android-dev/jdk-17` | ✅ 自动 |
| Android SDK | `E:/android-dev/android-sdk` | ✅ 自动 |
| Gradle | `E:/android-dev/gradle-8.5`（无 wrapper 时用） | 使用工程 `gradlew` |

## 二、首次生成安卓工程

```bash
cd mobile
npm install
npm run add:android      # 等价于：同步 web → npx cap add android
```

会生成 `mobile/android/` 原生工程。若缺少 `local.properties`，手动创建：

```
sdk.dir=E:/android-dev/android-sdk
```

## 三、同步前端

每次改完 `web/` 后执行：

```bash
cd mobile
npm run sync             # 同步 web/ 到 android 资源目录并更新插件
```

`scripts/sync-web.mjs` 会把 `web/` 复制到 `mobile/public/`（Capacitor 的 webDir），
保证 **Web / 移动 PWA / 桌面 / APK 四端共用同一份前端代码**。

## 四、构建

```bash
# 有 gradlew（Capacitor 模板通常自带）
cd mobile && npm run build:debug
# 产物：mobile/android/app/build/outputs/apk/debug/app-debug.apk

# 无 gradlew 时用独立 Gradle
cd mobile/android
E:/android-dev/gradle-8.5/dist/gradle-8.5/bin/gradle assembleDebug
```

云端构建：推送 `main`（改动 `web/**` 或 `mobile/**`）即触发
`.github/workflows/build-apk.yml`，在 Actions Artifacts 下载 `knowledge-workbench-debug.apk`。

## 五、配置应用信息

`mobile/capacitor.config.json`：

- `appId`：包名，如 `com.zhangshifa.knowledgeworkbench`
- `appName`：桌面显示名「知识库工作台」
- `server.androidScheme`：WebView 使用的协议（默认 https）
- `cleartext`：允许明文 HTTP（便于连内网服务；公网请改用 HTTPS）

## 六、联网与安全建议

- 局域网调试：服务用 `--host 0.0.0.0` 启动，手机填 `http://192.168.x.x:8787`
- 公网部署：务必配置 `KB_API_TOKEN`，并在 App 设置里填同一个 Token
- 生产环境建议 Nginx + HTTPS，避免明文传输凭证与内容

## 七、常见问题

| 现象 | 处理 |
|---|---|
| 打开提示「请先配置知识库服务地址」 | APK 内网页无同源后端，点 ⚙ 填服务地址 |
| 测试连接失败 | 检查手机与服务器同网、服务 `--host 0.0.0.0`、防火墙放行端口 |
| 构建报 SDK 路径错误 | 检查 `mobile/android/local.properties` 的 `sdk.dir` |
| 构建报 Gradle 版本不匹配 | 用独立 Gradle（见上），或调整 `android/gradle/wrapper/gradle-wrapper.properties` |
