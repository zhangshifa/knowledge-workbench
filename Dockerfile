# 知识库工作台 — 零依赖镜像（Node 内置模块即可，无需 npm install）
FROM node:20-slim

# 仅用于运行时，无需 npm install（所有依赖均为 Node 内置模块）
WORKDIR /app

COPY server/ ./server/
COPY web/ ./web/
COPY docs/ ./docs/

ENV KB_HOST=0.0.0.0 \
    KB_PORT=8787 \
    KB_DATA_DIR=/app/data \
    NODE_ENV=production

# 数据持久化：挂载 /app/data 卷
VOLUME ["/app/data"]

EXPOSE 8787

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
