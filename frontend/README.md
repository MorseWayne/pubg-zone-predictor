# PUBG 回放中心前端

界面使用 React、Astryx 和 Tailwind CSS，由 Vite 构建。页面通过同源的 `/api` 访问 FastAPI 后端。

在仓库根目录运行 `make dev` 可同时启动前后端。运行 `npm --prefix frontend run typecheck` 检查类型，运行 `make build` 生成 `frontend/dist/`。首次安装和数据库初始化见[项目说明](../README.md)。
