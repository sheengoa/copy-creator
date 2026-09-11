# domain/ 领域层

全项目领域规则的**唯一事实源**（DOMAIN_ARCHITECTURE_PLAN.md）。三个窗口（主窗口/径向菜单/新建窗口）的组件只做布局与交互，一切"这条记录是什么、能做什么、怎么显示"的判定都在本目录。

## 新规则归属决策表

要新增一条领域规则时，按问题类型对号入座：

| 问题 | 归属 |
|:---|:---|
| 某内容**是什么类型**（媒体类型、扩展名判定） | `mediaKind.ts` |
| 某记录**能做什么**（能否展开、粘贴路由、是否资源/文件承载文本） | `records.ts` |
| 预览 **segments 怎么生成** | `preview.ts` |
| 本地路径→**可显示/可播放 URL** | `mediaUrl.ts`（`convertFileSrc`/媒体服务 token 全项目仅此处可用） |
| **文件名**切分、重命名资格 | `fileName.ts` |
| 分组树的**组织与排序** | `groups.ts` |
| 组装视图模型 `RecordView` | `recordView.ts`（**组装-only**：只调用上述模块，不得新增判定） |
| 上述都不是的展示辅助（格式化、列宽计算） | 不进 domain，留在各页面的工具文件 |

硬性约束：
- **禁止**在 `components/`、`pages/` 中新写扩展名判断、媒体类型分支、能力判定——一律 import domain；
- `recordView.ts` 内禁止扩展名字面量、`record.type === "…"` 判定、`endsWith/startsWith` 推断（架构守卫规则 6）；
- `domain/**` 禁止 import `stores/*` 与组件（规则 12）；叶子组件禁止 import `stores/*`（规则 10）；
- 拆分触发条件：单一文件出现第二个不相关主题，或超过约 400 行。

## 缺陷 → 守卫闭环

今后每出现"功能在某界面有、另一界面没有"或重复实现类缺陷，修复时必须：
1. 把根因规则收进 domain；
2. 若 `src/architectureGuard.test.ts` 尚不能拦住该模式，补一条对应断言。

守卫失败信息会指向本 README 对应章节；新增豁免必须修改守卫测试（= 强制过评审）。
