# UI 地图 Canvas 优化设计

日期：2026-06-06

## 背景

当前 MVP 前端地图工作台使用静态 `<img>` 加 DOM overlay 绘制圈、热点、路线和标记。用户希望优化 UI 显示：地图支持拖动与缩放，默认使用 high-res 地图资源，并且 MVP 当前地图应为 Miramar，而不是 Erangel。

已确认的产品决策：

- 采用 Canvas 地图渲染方案，而不是继续使用 DOM overlay。
- 地图交互采用：单击标点、拖拽平移、滚轮缩放。
- 缩放范围为 `0.5×` 到 `4×`，提供“重置视图”。
- 默认 high-res 资源使用带地名文字的 `high` 版本。
- high-res 加载失败时严格失败：禁用地图，不自动回退 low-res。
- 保留 Erangel 配置，但前端默认选择 Miramar。

## 目标

1. 前端地图默认显示 Miramar。
2. 地图使用 high-res 带文字资源。
3. high-res 资源失败时给出明确错误并禁用地图交互。
4. Canvas 支持缩放、拖动、重置视图和单击标点。
5. 圈、热点、路线和 marker 在缩放/拖动后仍与底图对齐。
6. 现有预测、热点生成、模型训练和解释流程继续可用。

## 非目标

本次不做以下内容：

- 触摸屏双指缩放。
- 惯性拖动。
- 小地图 overview。
- 地形、道路、桥梁、水域的真实寻路。
- 地图文字/no-text 资源的 UI 切换。
- Canvas 图层开关面板。
- 多候选圈预测或概率热区。

## 架构设计

新增一个专门的 Canvas 地图组件，例如 `InteractiveMapCanvas`。组件边界如下：

- `App` 继续负责业务状态：
  - 加载地图配置、Zone 配置和地图资产。
  - 管理 `currentCircleCenter`、`teamArea`、`prediction`、`currentPhase` 和点击模式。
  - 调用热点生成、训练和预测 API。
  - 将地图渲染所需数据传给 Canvas 组件。
- `InteractiveMapCanvas` 负责地图渲染与交互：
  - 加载并解码地图图片。
  - 维护 pan/zoom 视图状态。
  - 处理鼠标单击、拖拽和滚轮缩放。
  - 提供 world、normalized、map pixel 和 canvas screen 坐标转换。
  - 绘制底图、热点、当前圈、预测圈、最终圈、路线和 marker。
- 后端继续负责资源解析和缓存：
  - 读取地图配置中的资产路径。
  - 准备本地缓存。
  - 对 high-res 请求执行严格失败策略。

这样保持职责清晰：React 管业务状态，Canvas 管地图渲染和交互变换，后端管资源和缓存。

## 前端组件设计

`InteractiveMapCanvas` 建议接收以下核心 props：

```ts
type InteractiveMapCanvasProps = {
  map: MapConfig;
  imageUrl: string | null;
  enabled: boolean;
  currentPhaseRadius: number;
  currentCircleCenter: Point | null;
  teamArea: Point | null;
  prediction: PredictionResult | null;
  clickMode: ClickMode;
  onSetCurrentCircleCenter: (point: Point) => void;
  onSetTeamArea: (point: Point) => void;
  onImageError: (message: string) => void;
};
```

组件内部维护：

```ts
type ViewTransform = {
  fitScale: number;   // 让整张图片适配 canvas 的基础倍率
  zoom: number;       // 相对 fitScale 的用户缩放倍率，范围 0.5 到 4
  offsetX: number;    // canvas 像素偏移
  offsetY: number;
};
```

`effectiveScale = fitScale * zoom`。本文所有“0.5× 到 4×”都指相对全图适配视图的 `zoom`，而不是原始图片像素到 canvas 像素的绝对倍率。这样即使 high-res 图片远大于容器，重置视图也能稳定显示完整地图。

交互规则：

- 鼠标按下和松开之间移动距离小于阈值（例如 `4px`）时视为单击。
- 单击会按当前点击模式设置当前圈中心或战队位置。
- 移动超过阈值后进入拖拽状态，只更新 `offsetX` / `offsetY`，不会设置 marker。
- 滚轮缩放以鼠标所在点为锚点。
- 缩放范围 clamp 到 `0.5` 到 `4` 的相对 `zoom`。
- `+` / `−` 控件同样调整相对 `zoom`，默认步长可使用 1.2 倍。
- “重置视图”恢复为 `zoom = 1` 且图片居中的全图适配状态。
- 图片加载完成后，根据 canvas 尺寸与图片原始尺寸计算初始适配 transform。
- canvas 容器尺寸、设备像素比或窗口尺寸变化时，使用 `ResizeObserver` 重新计算 `fitScale` 和 backing store 尺寸；同时监听 `window.resize`，并在浏览器支持时通过 `matchMedia` 针对当前 `devicePixelRatio` 注册变化监听。DPR 变化后必须更新 canvas backing store 宽高、重新应用 `ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)` 或等价缩放策略，再重绘地图。
- resize/DPR 重算时，优先保持当前视图中心对应的 world 坐标不变；如果图片或容器状态不足以保持中心，则回退到全图适配。

## 坐标模型

Canvas 使用明确的转换链：

```text
world 坐标
  ↔ normalized 坐标（0..1）
  ↔ map pixel 坐标（基于原始 high-res 图片尺寸）
  ↔ canvas screen 坐标（应用 scale + offset）
```

转换约束：

- world 与 normalized 继续使用 `MapConfig.coordinate`。
- `y_axis` 必须沿用现有配置逻辑。
- map pixel 基于图片原始 `naturalWidth` / `naturalHeight`，不依赖 CSS 尺寸。
- 所有绘制都从 world 或 tile 数据转换到 map pixel，再通过 `ViewTransform` 转为 canvas screen。
- 单击标点时反向从 canvas screen 转回 map pixel，再转 normalized 和 world。

这种模型能避免 pan/zoom 后 DOM overlay 和底图错位。

## Canvas 绘制层级

Canvas 每次重绘按以下顺序：

1. **底图层**
   - 绘制 high-res 地图图片。
   - 开启 `imageSmoothingEnabled`。
   - 图片未加载时显示 disabled/loading 状态。

2. **热点层**
   - 使用 `prediction.hotspot_summary.top_tiles`。
   - 按 `grid_size` 计算 tile 范围。
   - 使用半透明红/橙色，透明度随 `hotspot_score` 提高。

3. **圈层**
   - 当前圈、下一圈、最终圈使用不同颜色。
   - 当前圈：蓝色。
   - 下一圈：绿色。
   - 最终圈：金色或紫色。
   - 线宽按 zoom 做轻微补偿，保证可读。

4. **路线层**
   - 绘制 `prediction.route.waypoints` polyline。
   - 使用高对比描边：深色外描边 + 亮色内线。

5. **标记层**
   - 绘制当前圈心和队伍位置。
   - marker 图标和文字使用屏幕尺寸，不随地图无限放大。

6. **辅助 HUD**
   - 右上角提供 `−`、当前倍率、`+`、`重置`。
   - 左下角显示“单击标点 · 拖拽移动 · 滚轮缩放”。
   - 顶部 toolbar 保留“设置当前圈中心 / 设置战队位置”。

HUD 可以用普通 React DOM 控件覆盖在 canvas 上；地图图层本身由 canvas 绘制。

## 后端配置与资源策略

### `config/maps.yaml`

新增 `miramar`：

- `display_name: Miramar`
- `telemetry_names` 使用官方 telemetry 主地图名：`Desert_Main`。
- `world_size: 816000`
- 坐标范围：`0..816000`，`y_axis: down`
- assets 包含：
  - `no_text_low: Assets/Maps/Miramar_Main_No_Text_Low_Res.png`
  - `low: Assets/Maps/Miramar_Main_Low_Res.png`
  - `no_text_high: Assets/Maps/Miramar_Main_No_Text_High_Res.png`
  - `high: Assets/Maps/Miramar_Main_High_Res.png`

保留现有 `erangel`。

### `config/zone_phases.yaml`

新增 `miramar` 的默认 Zone 半径配置。第一版可复用现有 Erangel 半径表，保证 Miramar 的 UI 和预测流程可运行。后续若有 Miramar 专门圈阶段参数，再单独校准。

### AssetManager

需要同步修改服务层、API 层和测试里的默认资产契约，避免前端仍隐式拿到低清资源：

- `backend/app/services/assets.py`
  - `DEFAULT_ASSET_KEY` 从 `no_text_low` 改为 `high`。
  - `_fallback_keys("high")` 只返回 `["high"]`。
  - `_fallback_keys("no_text_high")` 只返回 `["no_text_high"]`。
  - `_fallback_keys("low")` / `_fallback_keys("no_text_low")` 可以继续保留低清候选链，方便显式低清请求和测试。
- `backend/app/api/assets.py`
  - `GET /api/assets/maps/{map_id}`、`POST /api/assets/maps/{map_id}/ensure`、`GET /api/assets/maps/{map_id}/image` 的默认 `asset_key` 必须与 `DEFAULT_ASSET_KEY` 保持一致，推荐直接导入常量，避免重复字符串。
- 后端测试需要同步更新默认资源断言，并新增 strict high-res 断言。

严格策略：

- 对 high-res 请求（`high` / `no_text_high`）只尝试请求的原始 key。
- 配置缺失、下载失败、缓存无效或 PNG 校验失败时返回 `ASSET_UNAVAILABLE`，`details.asset_key` 保持原始请求 key。
- 不自动回退到 low-res，也不返回 low-res 的 `image_url`。
- 对显式 low-res 请求可以保留原有低清 fallback 行为，方便测试和维护。
- 前端默认调用 `/api/assets/maps/{map_id}/ensure` 时不传 key，因此应获得 `high`。

## 前端默认地图策略

- `selectedMapId` 初始值改为 `miramar`。
- 加载 `/api/config/maps` 后，如果返回列表包含 `miramar`，保持默认 Miramar。
- 如果后端配置异常、没有 Miramar，则回退到第一张可用地图，避免页面完全空白。
- 用户仍可通过地图下拉切换到 Erangel。

## 错误处理

- 地图配置加载失败：控制面板显示错误，地图区域禁用。
- Zone 配置加载失败：控制面板显示错误，地图区域可以展示底图但预测不可用。
- high-res 资源准备失败：地图区域显示“地图资源不可用”，展示后端错误，禁用点击、拖动、缩放和预测，并保留“重试加载地图”按钮。
- 图片解码失败：Canvas 触发 `onImageError`，进入 disabled 状态。
- 拖动与单击冲突：通过移动阈值区分，拖动结束不设置 marker。

## 测试与验证

后端验证：

- `AssetManager` 默认 asset key 为 `high`。
- API 层三个资产端点的默认 `asset_key` 与 `DEFAULT_ASSET_KEY` 一致。
- 请求 `high` 或 `no_text_high` 时只尝试原始 key，不回退 low-res。
- 显式请求 low-res 时仍能按低清策略工作。
- `miramar` 能通过 `/api/config/maps` 返回。
- Miramar high-res 资源路径为 `Assets/Maps/Miramar_Main_High_Res.png`。
- `/api/config/zone-phases?map_id=miramar` 可返回配置。

前端自动验证：

- `npm run build:frontend` 通过。
- 默认地图为 `miramar`。
- Canvas 组件 TypeScript 编译通过。
- 提取坐标和 transform 计算到纯函数模块，并用轻量前端测试覆盖：
  - world ↔ normalized ↔ map pixel ↔ canvas screen 往返转换。
  - 拖拽阈值不会误触发标点。
  - 以鼠标所在点为锚点缩放后，该点对应的 map pixel 不漂移。
  - `zoom` clamp 到 `0.5..4` 且 `fitScale` 不被误当作用户倍率。
- 如果实现阶段不引入完整浏览器 E2E，本次只要求纯函数自动测试加手动交互验证；Playwright/Cypress 留到后续。
- high-res 失败时地图禁用且预测不可用。

手动验证：

- 打开工作台默认显示 Miramar。
- 首次 Miramar high-res 下载或本地缓存读取成功后，底图是带文字 high-res。
- 滚轮可缩放。
- 拖动可平移。
- 单击可设置当前圈心和队伍位置。
- 缩放/拖动后 marker、圈、热点和路线仍与底图对齐。
- 调整窗口大小或设备像素比变化后，底图与绘制层仍对齐。
- “重置视图”恢复全图适配。
- high-res 资源失败时不自动回退 low-res。
- 若本地已有 Miramar telemetry 样本，热点生成、训练和预测 smoke 验证应返回 Miramar 相关结果；若没有样本，前端仍应展示现有降级 warning，而不是误报资源或 Canvas 错误。

## 风险与缓解

- **Canvas 重绘复杂度高于 DOM overlay。** 缓解：保持绘制层级简单，所有绘制函数只接收明确数据和转换函数。
- **坐标错位风险。** 缓解：统一使用 world ↔ normalized ↔ map pixel ↔ canvas screen 转换链，避免混用 CSS 尺寸。
- **high-res 文件较大，加载较慢。** 缓解：保留 loading/disabled 状态和重试按钮；不在本次实现自动降级。
- **Miramar 官方资源路径可能配置错误。** 缓解：在配置中写明 `Desert_Main` 资源路径，新增 API 测试覆盖路径；手动验证首次下载。
- **Miramar telemetry 名称配置错误会导致热点/训练样本为空。** 缓解：明确使用 `Desert_Main`，并在有样本时做 Miramar 热点/训练/预测 smoke 验证；无样本时只接受现有降级 warning。

## 实施顺序建议

1. 更新配置和 AssetManager 策略，先让 Miramar high-res API 可用。
2. 新增 Canvas 地图组件和坐标转换函数。
3. 将 `App` 从 DOM overlay 接入 Canvas 组件。
4. 补齐样式和 HUD 控件。
5. 运行后端测试、前端构建和手动交互验证。
