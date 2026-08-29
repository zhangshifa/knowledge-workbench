# 统一知识库工作台 · 云端镜像
# 零第三方依赖，构建阶段不执行任何安装命令，构建快、体积小、供应链风险低。
FROM node:20-slim

LABEL org.opencontainers.image.title="knowledge-workbench"
LABEL org.opencontainers.image.description="统一知识库工作台：ShowDoc / GitHub / Gitee / 禅道 / 印象笔记 / 腾讯文档 / MCP"
LABEL org.opencontainers.image.source="https://github.com/zhangshifa/knowledge-workbench"

ENV NODE_ENV=production \
    KB_HOST=0.0.0.0 \
    KB_PORT=8787 \
    KB_DATA_DIR=/app/data \
    KB_WEB_DIR=/app/web

WORKDIR /app

COPY server ./server
COPY web ./web
COPY package.json ./package.json

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8787

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KB_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
