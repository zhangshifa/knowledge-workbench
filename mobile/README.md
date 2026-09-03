# Android 端（Capacitor 封装网页）

APK 用 Capacitor 把 `web/` 前端打包进原生壳，**数据与检索全部由 Python 服务提供**。
首次打开 App 时，在「⚙ 服务设置」里填入你的 Python 服务地址即可（同一局域网或公网域名）。

```
┌─────────────────────────┐        HTTP /api        ┌──────────────────────────┐
│ Android APK (Capacitor) │  ───────────────────────▶ │ Python 服务 (server_py)  │
│ 内嵌 web/ 前端           │  ◀─────────────────────── │ 检索 / 同步 / 数据源      │
└─────────────────────────┘                          └──────────────────────────┘
```

## 一、准备

- Node.js ≥ 18
- JDK 17
- Android SDK（API 34 / build-tools 34.0.0）
- 先让 Python 服务跑起来：

```bash
# 局域网可访问（手机与电脑同一 WiFi）
cd server_py
python main.py serve --host 0.0.0.0 --port 8787
```

> 建议同时设置 `KB_API_TOKEN` 并在 App 的「服务设置」里填入相同 Token。

## 二、生成安卓工程并同步前端

```bash
cd mobile
npm install          # 安装 Capacitor CLI 与 Android 平台
npm run add:android  # 首次：生成 android/ 原生工程
npm run sync         # 之后：把 web/ 同步进 android 资源并更新插件
```

## 三、构建 APK

### 方式 A：本机构建（Windows，已装 JDK17 + Android SDK）

```bash
cd mobile
npm run build:debug
# 产物：mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

若工程缺少 Gradle Wrapper（部分模板不含 `gradlew`），改用独立 Gradle：

```bash
cd mobile/android
E:/android-dev/gradle-8.5/dist/gradle-8.5/bin/gradle assembleDebug
```

并确保 `mobile/android/local.properties` 中指向 SDK：

```
sdk.dir=E:/android-dev/android-sdk
```

### 方式 B：GitHub Actions 云端构建（无需本机环境）

推送 `main` 或手动触发 `.github/workflows/build-apk.yml`，
在 Actions 的 Artifacts 中下载 `knowledge-workbench-debug.apk`。

## 四、使用

1. 安装 APK，打开后点击右上角 **⚙**
2. 填入服务地址，例如 `http://192.168.1.10:8787`
3. 点「测试连接」确认连通 → 保存
4. 返回即可看到数据源列表、执行同步与全局检索

## 五、常见问题

| 现象 | 原因与处理 |
|---|---|
| 打开后提示「请先配置知识库服务地址」 | APK 内网页跑在 `https://localhost`，无同源后端；按上面步骤填地址即可 |
| 测试连接失败 | 手机与服务器是否同网；服务是否用 `--host 0.0.0.0` 启动；防火墙是否放行端口 |
| 页面空白 | 服务地址填错或网络不通；可用手机浏览器先访问 `http://<地址>:8787` 验证 |
| 明文 HTTP 被拦截 | 已在 `capacitor.config.json` 开启 `cleartext`；若仍失败请改用 HTTPS 域名 |
