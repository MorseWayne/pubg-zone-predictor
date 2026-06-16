# 安全区训练第二阶段改造实施计划

> **给 agentic 执行者：** 实施本计划时必须使用 `superpowers:executing-plans` 或等价的任务逐项执行流程。所有生产代码改动必须先写失败测试，再实现最小代码让测试通过。

**目标：** 在不新增机器学习依赖的前提下，引入轻量特征模型和基于验证误差的模型选择，让预测优先使用更可信的历史模型。

**架构：** 在现有 median baseline artifact 上新增 `feature_model` 区块，按地图、阶段、目标类型和当前圈所在网格训练局部 offset。预测时优先使用 feature model，缺失时回退 median baseline，再缺失时回退 rule baseline。模型选择从“最新 completed run”改为“validation mean error 最低的可加载 completed run”。

**技术栈：** Python 3.12、FastAPI、SQLite、pytest、Vite/TypeScript、现有 GitNexus CLI。

---

## 任务 1：特征模型训练产物

**文件：**

- 修改：`backend/app/services/training.py`
- 测试：`backend/tests/services/test_training.py`

- [ ] 写失败测试：构造同地图同阶段但不同当前圈网格的样本，训练后 artifact 包含 `feature_model.groups`，且不同网格有不同 offset。
- [ ] 确认测试失败：运行 `.venv/bin/python -m pytest backend/tests/services/test_training.py::test_train_baseline_writes_feature_model_groups -q`。
- [ ] 实现：新增 `FeatureGroup` dataclass，按当前圈归一化坐标切为 `2 x 2` 网格，用中位数 offset 训练 `(map_id, current_phase, target_type, cell_x, cell_y)`。
- [ ] 写入 artifact：顶层 `algorithm` 改为 `weighted_feature_offset_v1`，保留 `groups` 作为 baseline，新增 `feature_model`。
- [ ] 运行训练测试：`.venv/bin/python -m pytest backend/tests/services/test_training.py -q`。

## 任务 2：预测优先使用特征模型

**文件：**

- 修改：`backend/app/services/prediction.py`
- 测试：`backend/tests/services/test_prediction.py`

- [ ] 写失败测试：artifact 同时包含 baseline group 和 feature group，输入落入 feature cell 时返回 `source == "feature_model"` 并使用 feature offset。
- [ ] 确认测试失败：运行 `.venv/bin/python -m pytest backend/tests/services/test_prediction.py::test_predict_prefers_feature_model_group_over_baseline_group -q`。
- [ ] 实现：新增 `FeatureModelGroup` 和 `LoadedModel.feature_groups`，加载 `feature_model.groups`，预测时先查 feature group，再查 baseline group。
- [ ] 保持兼容：没有 `feature_model` 的旧 artifact 仍按 baseline group 工作。
- [ ] 运行预测测试：`.venv/bin/python -m pytest backend/tests/services/test_prediction.py -q`。

## 任务 3：按验证误差选择模型

**文件：**

- 修改：`backend/app/services/prediction.py`
- 测试：`backend/tests/services/test_prediction.py`

- [ ] 写失败测试：创建两个 completed model run，较新的 validation error 更差，预测应选择较旧但 validation error 更低的 run。
- [ ] 确认测试失败：运行 `.venv/bin/python -m pytest backend/tests/services/test_prediction.py::test_predict_selects_completed_model_with_best_validation_error -q`。
- [ ] 实现：`_load_latest_model` 改为 `_load_best_model` 行为，查询同地图 completed run 后按 validation mean error 升序、created_at 降序排序。
- [ ] 没有 validation metrics 时兼容旧行为：没有指标的 run 排在有指标 run 后面，但仍可作为兜底候选。
- [ ] 运行预测测试：`.venv/bin/python -m pytest backend/tests/services/test_prediction.py -q`。

## 任务 4：展示模型算法和验证质量

**文件：**

- 修改：`frontend/src/app/components/DataPreparation.tsx`
- 测试：`npm --prefix frontend run build`

- [ ] 在预测模型卡片中展示 algorithm。
- [ ] 继续展示验证误差，若没有 validation metric 则不展示。
- [ ] 运行前端构建：`npm --prefix frontend run build`。

## 任务 5：最终验证

- [ ] 运行 `.venv/bin/ruff check backend/app/services/training.py backend/app/services/prediction.py backend/tests/services/test_training.py backend/tests/services/test_prediction.py`。
- [ ] 运行 `.venv/bin/python -m pytest backend/tests -q`。
- [ ] 运行 `npm --prefix frontend run build`。
- [ ] 运行 `node .gitnexus/run.cjs detect_changes --scope compare --base-ref main --repo pubg-zone-predictor`。
- [ ] 检查 `git status --short`，确认只包含计划内文件。

## 自查

- 计划不引入新依赖。
- 旧 artifact 兼容路径保留。
- 新行为有失败测试先行。
- 第二批只改训练、预测、前端模型状态展示和相关测试。
