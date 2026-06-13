# 安全区训练第一阶段改造实施计划

> **给 agentic 执行者：** 实施本计划时必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。所有步骤使用复选框语法，便于逐项追踪。

**目标：** 在不引入复杂机器学习依赖的前提下，把当前 PUBG 安全区统计基线训练改造成更可信、更可验证、更安全的模型训练链路。

**架构：** 保留现有 `TrainingService`、`PredictionService` 和 JSON artifact 产物模式。第一阶段不引入 `scikit-learn`、XGBoost 或神经网络，只强化当前统计基线：加合法缩圈约束、artifact 版本协议、训练/验证集指标，以及更稳健的偏移拟合方式。

**技术栈：** Python 3.12、FastAPI、SQLite、pytest、现有 GitNexus CLI、现有前端 API 类型。

---

## 范围

本计划只覆盖第一批改造：

- 给预测结果增加合法缩圈几何约束。
- 给模型 artifact 增加版本和结构校验。
- 按 `match_id` 做训练/验证集拆分，并记录验证指标。
- 从平均偏移改成更稳健的中位数偏移。
- 后端 API 和前端类型最小化展示模型质量指标。

本计划不覆盖：

- 引入 `scikit-learn`、XGBoost 或神经网络模型。
- 把训练改成后台任务。
- 新增数据采集策略。
- 大规模 UI 重构。

## 文件结构

- 修改 `backend/app/services/prediction.py`
  - 增加合法缩圈中心约束 helper。
  - 加载模型 artifact 前校验 schema/version。
  - artifact 不可用时继续回退到 `rule_baseline`。
- 修改 `backend/app/services/training.py`
  - 增加 artifact schema 常量。
  - 按 `match_id` 拆分训练/验证样本。
  - 使用中位数偏移拟合 group。
  - 分别评估训练集和验证集。
  - 写入更完整的 artifact 元数据。
- 修改 `backend/app/db/migrations/001_initial_schema.sql`
  - 给 `model_metrics` 增加 `split` 字段。
- 新增 `backend/app/db/migrations/002_model_metric_splits.sql`
  - 给已有数据库补充兼容迁移。
- 修改 `backend/tests/services/test_prediction.py`
  - 覆盖合法缩圈约束和 artifact 校验回退。
- 修改 `backend/tests/services/test_training.py`
  - 覆盖 split metrics、中位数偏移、artifact 元数据和低样本 warning。
- 修改 `backend/tests/test_training_api.py`
  - 覆盖训练 API 返回 `split` 字段。
- 修改 `frontend/src/app/api.ts`
  - 更新 `ModelMetric` 类型。
- 修改 `frontend/src/app/components/DataPreparation.tsx`
  - 展示验证误差，保持现有页面结构。

## 必须先做的 GitNexus 检查

修改任何符号前，先运行：

```bash
node .gitnexus/run.cjs impact "Method:backend/app/services/prediction.py:PredictionService._predict_circle#1" --repo pubg-zone-predictor
node .gitnexus/run.cjs impact "Method:backend/app/services/prediction.py:PredictionService._load_latest_model#1" --repo pubg-zone-predictor
node .gitnexus/run.cjs impact "Method:backend/app/services/training.py:TrainingService.train_baseline#1" --repo pubg-zone-predictor
node .gitnexus/run.cjs impact "Method:backend/app/services/training.py:TrainingService._fit_groups#1" --repo pubg-zone-predictor
node .gitnexus/run.cjs impact "Method:backend/app/services/training.py:TrainingService._evaluate#2" --repo pubg-zone-predictor
```

处理规则：

- 如果 GitNexus 返回 `HIGH` 或 `CRITICAL`，先停止并向用户报告影响范围。
- 如果风险较低，继续实施，但只修改本计划列出的文件。

提交前必须运行：

```bash
node .gitnexus/run.cjs detect_changes --scope compare --base-ref main --repo pubg-zone-predictor
```

预期结果：影响范围只包含训练、预测、训练 API/类型和相关测试。

---

## 任务 1：约束预测安全区中心

**文件：**

- 修改：`backend/app/services/prediction.py`
- 测试：`backend/tests/services/test_prediction.py`

- [ ] **步骤 1：先写失败测试**

目标：证明模型 offset 或规则回退都不能把目标圈放到当前圈的合法包含范围之外。

```python
def test_predict_clamps_model_circle_inside_current_circle(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    run_id = _seed_model(
        migrated_connection,
        tmp_path,
        [
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "next",
                "offset_x": 800000,
                "offset_y": 0,
                "sample_count": 5,
            },
            {
                "map_id": "erangel",
                "current_phase": 1,
                "target_type": "final",
                "offset_x": 800000,
                "offset_y": 0,
                "sample_count": 5,
            },
        ],
    )
    service = _service(migrated_connection, tmp_path)

    result = service.predict(_input())

    assert result.model_run_id == run_id
    assert result.next_circle.source == "model_artifact"
    assert _distance(result.next_circle.center, Point(x=100000, y=100000)) <= 170000
    assert _distance(result.final_circle.center, Point(x=100000, y=100000)) <= 392300
```

如果测试文件里没有 `_distance`，新增本地 helper：

```python
def _distance(start: Point, end: Point) -> float:
    return ((start.x - end.x) ** 2 + (start.y - end.y) ** 2) ** 0.5
```

- [ ] **步骤 2：确认测试失败**

```bash
.venv/bin/python -m pytest backend/tests/services/test_prediction.py::test_predict_clamps_model_circle_inside_current_circle -q
```

预期：失败，因为当前 `_predict_circle` 只 clamp 到地图边界。

- [ ] **步骤 3：增加合法中心约束 helper**

在 `PredictionService` 中靠近 `_clamp_world_point` 的位置新增：

```python
    @staticmethod
    def _constrain_target_circle_center(
        transformer: CoordinateTransformer,
        current_center: Point,
        current_radius: float,
        target_center: Point,
        target_radius: float,
    ) -> Point:
        clamped_target = PredictionService._clamp_world_point(transformer, target_center)
        max_distance = max(0.0, current_radius - target_radius)
        dx = clamped_target.x - current_center.x
        dy = clamped_target.y - current_center.y
        distance = sqrt(dx * dx + dy * dy)
        if distance <= max_distance or distance == 0:
            return clamped_target
        scale = max_distance / distance
        return PredictionService._clamp_world_point(
            transformer,
            Point(
                x=current_center.x + dx * scale,
                y=current_center.y + dy * scale,
            ),
        )
```

更新 `_predict_circle` 签名，新增 `current_radius: float`。

在 `predict` 中取当前圈半径：

```python
current_radius = float(phases[prediction_input.current_phase]["radius"])
```

调用 `_predict_circle` 时传入：

```python
current_radius=current_radius,
```

模型路径下用约束后的中心：

```python
center = self._constrain_target_circle_center(
    transformer,
    current_center,
    current_radius,
    Point(x=current_center.x + group.offset_x, y=current_center.y + group.offset_y),
    target_radius,
)
```

规则回退路径也走同一个约束：

```python
center = self._constrain_target_circle_center(
    transformer,
    current_center,
    current_radius,
    self._rule_baseline_center(transformer, current_center, fallback_shift),
    target_radius,
)
```

- [ ] **步骤 4：运行预测测试**

```bash
.venv/bin/python -m pytest backend/tests/services/test_prediction.py -q
```

预期：全部通过。

---

## 任务 2：版本化并校验模型 Artifact

**文件：**

- 修改：`backend/app/services/training.py`
- 修改：`backend/app/services/prediction.py`
- 测试：`backend/tests/services/test_training.py`
- 测试：`backend/tests/services/test_prediction.py`

- [ ] **步骤 1：写 artifact 元数据失败测试**

在 `test_train_baseline_writes_model_run_metrics_and_artifact` 中增加：

```python
    payload = json.loads(Path(run.model_path).read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert payload["algorithm"] == "statistical_median_offset_v1"
    assert payload["training_data"]["sample_count"] == 5
    assert payload["training_data"]["maps_included"] == ["erangel"]
```

如果需要，文件顶部新增：

```python
import json
```

- [ ] **步骤 2：写无效 artifact 回退测试**

在 `backend/tests/services/test_prediction.py` 中新增：

```python
def test_predict_falls_back_when_model_artifact_schema_is_invalid(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    artifact_path = tmp_path / "invalid-model.json"
    artifact_path.write_text(
        json.dumps({"algorithm": "unknown", "groups": []}),
        encoding="utf-8",
    )
    repo = SQLiteRepository(migrated_connection)
    repo.insert_or_ignore(
        "model_runs",
        {
            "id": "model-invalid",
            "created_at": "2026-06-05T00:00:00+00:00",
            "maps_included": json.dumps(["erangel"]),
            "phases_included": json.dumps([1]),
            "sample_count": 5,
            "algorithm": "unknown",
            "model_path": str(artifact_path),
            "status": "completed",
        },
    )
    migrated_connection.commit()
    service = _service(migrated_connection, tmp_path)

    result = service.predict(_input())

    assert result.model_run_id is None
    assert result.next_circle.source == "rule_baseline"
    assert "model_artifact_invalid" in result.warnings
    assert "rule_baseline_used" in result.warnings
```

- [ ] **步骤 3：确认测试失败**

```bash
.venv/bin/python -m pytest \
  backend/tests/services/test_training.py::test_train_baseline_writes_model_run_metrics_and_artifact \
  backend/tests/services/test_prediction.py::test_predict_falls_back_when_model_artifact_schema_is_invalid \
  -q
```

预期：失败，因为 artifact 元数据和 schema 校验还不存在。

- [ ] **步骤 4：写入新版 artifact**

在 `backend/app/services/training.py` 中替换算法常量：

```python
ARTIFACT_SCHEMA_VERSION = 1
ALGORITHM = "statistical_median_offset_v1"
```

更新 `_write_artifact` payload：

```python
        payload = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "id": run_id,
            "created_at": created_at,
            "algorithm": ALGORITHM,
            "training_data": {
                "maps_included": maps_included,
                "phases_included": phases_included,
                "sample_count": len(samples),
            },
            "maps_included": maps_included,
            "phases_included": phases_included,
            "sample_count": len(samples),
            "warnings": warnings,
            "groups": [
                {
                    "map_id": group.map_id,
                    "current_phase": group.current_phase,
                    "target_type": group.target_type,
                    "offset_x": _round(group.offset_x),
                    "offset_y": _round(group.offset_y),
                    "sample_count": group.sample_count,
                }
                for group in groups
            ],
        }
```

保留顶层 `maps_included`、`phases_included`、`sample_count`，兼容旧读取逻辑和人工排查。

- [ ] **步骤 5：预测侧校验 artifact**

在 `backend/app/services/prediction.py` 常量区新增：

```python
SUPPORTED_MODEL_SCHEMA_VERSION = 1
SUPPORTED_MODEL_ALGORITHMS = {"statistical_mean_offset_v1", "statistical_median_offset_v1"}
```

在 `_load_latest_model` 读取 JSON 后增加：

```python
        if payload.get("schema_version", 1) != SUPPORTED_MODEL_SCHEMA_VERSION:
            warnings.extend(["model_artifact_invalid", "rule_baseline_used"])
            return None
        if payload.get("algorithm") not in SUPPORTED_MODEL_ALGORITHMS:
            warnings.extend(["model_artifact_invalid", "rule_baseline_used"])
            return None
        groups_payload = payload.get("groups")
        if not isinstance(groups_payload, list):
            warnings.extend(["model_artifact_invalid", "rule_baseline_used"])
            return None
```

后续遍历 `groups_payload`，不要再直接遍历 `payload.get("groups", [])`。

- [ ] **步骤 6：运行 artifact 相关测试**

```bash
.venv/bin/python -m pytest backend/tests/services/test_training.py backend/tests/services/test_prediction.py -q
```

预期：全部通过。

---

## 任务 3：增加 Match 级验证集指标

**文件：**

- 修改：`backend/app/services/training.py`
- 修改：`backend/app/db/migrations/001_initial_schema.sql`
- 新增：`backend/app/db/migrations/002_model_metric_splits.sql`
- 测试：`backend/tests/services/test_training.py`
- 测试：`backend/tests/db/test_migrations.py`

- [ ] **步骤 1：写训练/验证指标失败测试**

在 `backend/tests/services/test_training.py` 中新增：

```python
def test_train_baseline_records_train_and_validation_metrics(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    _seed_circle_training_samples(migrated_connection, match_count=10)
    service = TrainingService(migrated_connection, ConfigService(Path("config")), tmp_path)

    run = service.train_baseline("erangel")

    metric_splits = {metric.split for metric in run.metrics}
    assert metric_splits == {"train", "validation"}
    assert all(metric.sample_count > 0 for metric in run.metrics)
```

- [ ] **步骤 2：写迁移失败测试**

在 `backend/tests/db/test_migrations.py` 中增加：

```python
    columns = {
        row["name"]
        for row in migrated_connection.execute("PRAGMA table_info(model_metrics)").fetchall()
    }
    assert "split" in columns
```

- [ ] **步骤 3：确认测试失败**

```bash
.venv/bin/python -m pytest \
  backend/tests/services/test_training.py::test_train_baseline_records_train_and_validation_metrics \
  backend/tests/db/test_migrations.py \
  -q
```

预期：失败，因为 `ModelMetric.split` 和 DB 字段还不存在。

- [ ] **步骤 4：扩展数据库 schema**

在 `backend/app/db/migrations/001_initial_schema.sql` 的 `model_metrics` 表中增加：

```sql
    split TEXT NOT NULL DEFAULT 'train' CHECK (split IN ('train', 'validation')),
```

更新唯一约束：

```sql
    UNIQUE (model_run_id, split, map_id, current_phase, target_type)
```

新增 `backend/app/db/migrations/002_model_metric_splits.sql`：

```sql
ALTER TABLE model_metrics
ADD COLUMN split TEXT NOT NULL DEFAULT 'train'
CHECK (split IN ('train', 'validation'));
```

如果当前迁移 runner 不支持这种 SQLite `ALTER TABLE` 写法，则改成重建表迁移：创建 `model_metrics_new`、复制旧数据并填充 `split = 'train'`、删除旧表、重命名新表。

- [ ] **步骤 5：给模型指标加 split 字段**

更新 `ModelMetric`：

```python
@dataclass(frozen=True)
class ModelMetric:
    split: str
    map_id: str
    current_phase: int
    target_type: str
    sample_count: int
    mean_center_error: float
    median_center_error: float
    p90_center_error: float | None
```

写入 `model_metrics` 时增加：

```python
                    "split": metric.split,
```

更新 `get_metrics` 查询：

```sql
SELECT split, map_id, current_phase, target_type, sample_count,
       mean_center_error, median_center_error, p90_center_error
FROM model_metrics
WHERE model_run_id = ?
ORDER BY split ASC, map_id ASC, current_phase ASC, target_type ASC
```

更新 `_metric_from_row`：

```python
split=row["split"],
```

- [ ] **步骤 6：按 match_id 拆分样本**

在 `TrainingService` 中新增：

```python
    @staticmethod
    def _split_samples_by_match(
        samples: list[TrainingSample],
        validation_ratio: float = 0.2,
    ) -> tuple[list[TrainingSample], list[TrainingSample]]:
        match_ids = sorted({sample.match_id for sample in samples})
        if len(match_ids) < 5:
            return samples, []
        validation_count = max(1, round(len(match_ids) * validation_ratio))
        validation_ids = set(match_ids[-validation_count:])
        train_samples = [sample for sample in samples if sample.match_id not in validation_ids]
        validation_samples = [sample for sample in samples if sample.match_id in validation_ids]
        return train_samples, validation_samples
```

在 `train_baseline` 中把：

```python
groups = self._fit_groups(samples)
metrics = self._evaluate(groups, samples)
```

替换为：

```python
train_samples, validation_samples = self._split_samples_by_match(samples)
groups = self._fit_groups(train_samples)
metrics = self._evaluate(groups, train_samples, split="train")
if validation_samples:
    metrics.extend(self._evaluate(groups, validation_samples, split="validation"))
else:
    warnings.append("validation split unavailable: fewer than 5 matches")
```

更新 `_evaluate` 签名，增加 `split: str`，并创建 `ModelMetric(split=split, ...)`。

- [ ] **步骤 7：运行训练和迁移测试**

```bash
.venv/bin/python -m pytest backend/tests/services/test_training.py backend/tests/db/test_migrations.py -q
```

预期：全部通过。

---

## 任务 4：改用中位数偏移基线

**文件：**

- 修改：`backend/app/services/training.py`
- 测试：`backend/tests/services/test_training.py`

- [ ] **步骤 1：写离群点测试**

在 `backend/tests/services/test_training.py` 中新增：

```python
def test_train_baseline_uses_median_offset_to_reduce_outlier_impact(
    migrated_connection: sqlite3.Connection,
    tmp_path: Path,
) -> None:
    _seed_circle_training_samples(migrated_connection, match_count=5)
    repo = SQLiteRepository(migrated_connection)
    repo.execute(
        """
        UPDATE circle_phases
        SET center_x = center_x + 500000
        WHERE match_id = 'match-5' AND phase = 2
        """
    )
    migrated_connection.commit()
    service = TrainingService(migrated_connection, ConfigService(Path("config")), tmp_path)

    run = service.train_baseline("erangel")

    payload = json.loads(Path(run.model_path).read_text(encoding="utf-8"))
    next_group = next(
        group
        for group in payload["groups"]
        if group["map_id"] == "erangel"
        and group["current_phase"] == 1
        and group["target_type"] == "next"
    )
    assert next_group["offset_x"] == 100
```

- [ ] **步骤 2：确认测试失败**

```bash
.venv/bin/python -m pytest backend/tests/services/test_training.py::test_train_baseline_uses_median_offset_to_reduce_outlier_impact -q
```

预期：失败，因为当前 `_fit_groups` 用的是算术平均。

- [ ] **步骤 3：改成中位数 offset**

在 `_fit_groups` 中替换 offset 计算：

```python
                    offset_x=float(median(offset[0] for offset in offsets)),
                    offset_y=float(median(offset[1] for offset in offsets)),
```

保留：

```python
sample_count=len(offsets)
```

- [ ] **步骤 4：同步算法名称断言**

相关测试统一期望：

```python
assert run.algorithm == "statistical_median_offset_v1"
```

artifact 中也应是同一个算法名。

- [ ] **步骤 5：运行训练测试**

```bash
.venv/bin/python -m pytest backend/tests/services/test_training.py -q
```

预期：全部通过。

---

## 任务 5：通过 API 和前端展示验证指标

**文件：**

- 修改：`backend/app/api/training.py`
- 修改：`backend/tests/test_training_api.py`
- 修改：`frontend/src/app/api.ts`
- 修改：`frontend/src/app/components/DataPreparation.tsx`

- [ ] **步骤 1：写 API 返回字段失败测试**

在 `backend/tests/test_training_api.py` 中更新 fake metric：

```python
ModelMetric(
    split="validation",
    map_id="erangel",
    current_phase=1,
    target_type="next",
    sample_count=2,
    mean_center_error=100.0,
    median_center_error=90.0,
    p90_center_error=150.0,
)
```

增加断言：

```python
assert body["metrics"][0]["split"] == "validation"
```

- [ ] **步骤 2：确认 API 测试失败**

```bash
.venv/bin/python -m pytest backend/tests/test_training_api.py -q
```

预期：失败，因为 `_metric_response` 还没有返回 `split`。

- [ ] **步骤 3：训练 API 返回 split**

在 `_metric_response` 中增加：

```python
        "split": metric.split,
```

- [ ] **步骤 4：更新前端类型**

在 `frontend/src/app/api.ts` 中更新 `ModelMetric`：

```ts
export type ModelMetric = {
  split: "train" | "validation";
  map_id: string;
  current_phase: number;
  target_type: "next" | "final";
  sample_count: number;
  mean_center_error: number;
  median_center_error: number;
  p90_center_error: number | null;
};
```

- [ ] **步骤 5：前端展示验证误差**

在 `DataPreparation.tsx` 中基于 active run 计算验证指标：

```tsx
  const validationMetrics = activeRun?.metrics.filter((metric) => metric.split === "validation") ?? [];
  const meanValidationError =
    validationMetrics.length > 0
      ? validationMetrics.reduce((sum, metric) => sum + metric.mean_center_error, 0) / validationMetrics.length
      : null;
```

在模型状态附近渲染：

```tsx
{meanValidationError !== null && (
  <div className="text-xs text-muted-foreground">
    验证误差: {Math.round(meanValidationError).toLocaleString()} m
  </div>
)}
```

- [ ] **步骤 6：运行 API 测试和前端构建**

```bash
.venv/bin/python -m pytest backend/tests/test_training_api.py -q
npm --prefix frontend run build
```

预期：后端测试通过，前端构建通过。

---

## 任务 6：最终回归和变更审查

**文件：**

- 审查任务 1-5 触及的全部文件。

- [ ] **步骤 1：运行目标后端测试**

```bash
.venv/bin/python -m pytest \
  backend/tests/services/test_training.py \
  backend/tests/services/test_prediction.py \
  backend/tests/test_training_api.py \
  backend/tests/db/test_migrations.py \
  -q
```

预期：全部通过。

- [ ] **步骤 2：运行完整后端测试**

```bash
.venv/bin/python -m pytest backend/tests -q
```

预期：全部通过。如果出现无关失败，记录具体失败测试，不修无关代码。

- [ ] **步骤 3：运行前端构建**

```bash
npm --prefix frontend run build
```

预期：构建通过。

- [ ] **步骤 4：运行 GitNexus 变更检测**

```bash
node .gitnexus/run.cjs detect_changes --scope compare --base-ref main --repo pubg-zone-predictor
```

预期：影响范围只包含训练、预测、训练 API/类型和相关测试。

- [ ] **步骤 5：检查工作区**

```bash
git status --short
git diff --stat
```

预期：只出现计划内文件。已有的用户本地修改，例如 `AGENTS.md` 或 `CLAUDE.md`，保持不动。

## 自查

- 范围覆盖：已覆盖第一批改造目标，包括合法几何、artifact 版本、验证指标、稳健统计基线、API/前端可见性和回归检查。
- 占位检查：文档中没有占位标记，也没有未定义的“以后再处理”步骤。
- 类型一致性：`ModelMetric.split` 会同时出现在训练服务、API 响应、测试和前端类型中。
- 兼容性：预测侧继续支持旧的 `statistical_mean_offset_v1` artifact，但新训练产物使用 `statistical_median_offset_v1`。

## 执行建议

推荐按任务逐个执行，并在每个任务后运行对应测试。最稳的方式是使用 subagent-driven 执行，每个任务完成后做一次 review；如果在当前会话内执行，也应严格按测试先行和 GitNexus impact 检查推进。
