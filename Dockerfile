# 每日AI打卡平台 - 容器镜像 (零依赖 Node 服务)
FROM node:18-alpine

WORKDIR /app

# 仅复制运行所需文件 (本项目零 npm 依赖)
COPY package.json ./
RUN npm install
COPY server.js ./
COPY public ./public

# 数据持久化: 云端需把磁盘/卷挂载到 /data
ENV PORT=3000
ENV DATA_DIR=/data
ENV UPLOAD_DIR=/data/uploads
ENV ADMIN_PASSWORD=admin123
RUN mkdir -p /data/uploads

EXPOSE 3000
CMD ["node", "server.js"]
