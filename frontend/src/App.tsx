import { useEffect, useState } from "react";

type HealthState =
  | { status: "loading" }
  | { status: "ok"; service: string; version: string; environment: string }
  | { status: "error"; message: string };

const routeStrategies = ["贴边进圈", "抢中心", "慢进圈", "绕路避战"];

export default function App() {
  const [health, setHealth] = useState<HealthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetch("/api/health")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`健康检查失败：${response.status}`);
        }
        return response.json() as Promise<{
          service: string;
          version: string;
          environment: string;
        }>;
      })
      .then((body) => {
        if (!cancelled) {
          setHealth({ status: "ok", ...body });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHealth({
            status: "error",
            message: error instanceof Error ? error.message : "无法连接后端",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Local analysis workspace</p>
          <h1>PUBG 圈型预测与宏观路线工具</h1>
          <p className="lede">
            P1 骨架已预留 FastAPI、React、共享配置和地图工作台边界，后续会接入资产、采集、训练与预测服务。
          </p>
        </div>
        <HealthBadge health={health} />
      </section>

      <section className="workspace-grid">
        <div className="map-placeholder" aria-label="地图工作区占位">
          <div className="circle current">当前圈</div>
          <div className="circle next">下一圈</div>
          <div className="route-line" />
          <span>地图与 overlay 工作区</span>
        </div>

        <aside className="control-panel">
          <h2>控制面板边界</h2>
          <label>
            地图
            <select defaultValue="erangel">
              <option value="erangel">Erangel</option>
            </select>
          </label>
          <label>
            当前 Zone
            <select defaultValue="3">
              {[1, 2, 3, 4, 5, 6, 7].map((phase) => (
                <option key={phase} value={phase}>
                  Zone {phase}
                </option>
              ))}
            </select>
          </label>
          <label>
            路线策略
            <select defaultValue="贴边进圈">
              {routeStrategies.map((strategy) => (
                <option key={strategy} value={strategy}>
                  {strategy}
                </option>
              ))}
            </select>
          </label>
          <button type="button">预测按钮占位</button>
        </aside>
      </section>
    </main>
  );
}

function HealthBadge({ health }: { health: HealthState }) {
  if (health.status === "loading") {
    return <div className="health-badge pending">检查后端中…</div>;
  }

  if (health.status === "error") {
    return <div className="health-badge error">后端未连接：{health.message}</div>;
  }

  return (
    <div className="health-badge ok">
      <span>后端在线</span>
      <strong>{health.service}</strong>
      <small>
        v{health.version} · {health.environment}
      </small>
    </div>
  );
}
