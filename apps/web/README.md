# NightStudy Web alpha

React + TypeScript + Vite 源码前端。原创SVG窗边场景和独立CSS构建雨夜、玻璃面板、琥珀操作的视觉；没有复制旧bundle，也不依赖未知许可照片。

业务数据全部来自同源 `/api/v2`，认证通过 `/api/auth` 的真实Cookie会话。根服务在HTML模块加载前注入 `window.__NIGHTSTUDY_CONFIG__={basePath}`；Router、API与认证使用同一个base。Vite生产构建采用相对资源URL，服务端负责按挂载前缀提供HTML资源路径。开发服务代理至127.0.0.1:5198。

当前页面包含词书/计划、服务器学习组与四档评分、组末拼写、到期复习、演示内容查词/生词本、熟词批次预览确认撤销与导出、目标基线和推荐计划、真实FSRS点的SVG曲线、账号/设置、首管理员初始化、基本后台。

内置词书为原创演示内容，不表示完整考试语料。无状态的个人记忆显示空态，曲线不使用随机或手绘默认数据；词间分布不称准确率置信区间。

Alpha边界：词书后台提供新建、元数据/状态编辑与词条编辑；扩展大词典、复杂词书发布、完整账户注销/全部历史导出、单词级曲线筛选和全面离线持续学习尚未包含。已实现网络写入持久重试，队列按本站用户隔离，服务器处理幂等与revision。

运行、数据库、版本和依赖由仓库根脚本管理。请从根执行 `pnpm dev:web`、`pnpm --filter @nightstudy/web typecheck`、`pnpm --filter @nightstudy/web build`。
