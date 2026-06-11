import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Filter,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { api, apiErrorMessage, IngestJob, IngestMatch } from "../api";

type TaskStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

const filterModes = [
  {
    id: "hotspot_light",
    label: "轻量级热力图",
    desc: "基础位置数据，处理速度快。",
    interval: 30,
  },
  {
    id: "zone_only",
    label: "缩圈预测优先",
    desc: "只保留圈阶段数据，适合快速补充预测样本。",
    interval: 60,
  },
  {
    id: "full",
    label: "全量分析",
    desc: "包含所有遥测数据，占用存储空间大。",
    interval: 5,
  },
] as const;

type FilterMode = (typeof filterModes)[number]["id"];

function isTerminal(status: string) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function statusLabel(status: string | null | undefined) {
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  if (status === "running") return "进行中";
  if (status === "cancelled") return "已取消";
  if (status === "pending") return "待处理";
  return "未知";
}

function compactDate(value: string | null) {
  if (!value) return "未知时间";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function DataCollection() {
  const [limit, setLimit] = useState(20);
  const [filterMode, setFilterMode] = useState<FilterMode>("hotspot_light");
  const [currentJob, setCurrentJob] = useState<IngestJob | null>(null);
  const [matches, setMatches] = useState<IngestMatch[]>([]);
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedMode = useMemo(
    () => filterModes.find((mode) => mode.id === filterMode) ?? filterModes[0],
    [filterMode],
  );

  const taskStatus: TaskStatus = (currentJob?.status as TaskStatus | undefined) ?? "idle";
  const progress =
    currentJob && currentJob.total_count > 0
      ? Math.min(100, Math.round(((currentJob.success_count + currentJob.skipped_count + currentJob.failed_count) / currentJob.total_count) * 100))
      : currentJob?.status === "completed"
        ? 100
        : 0;

  const refreshMatches = async () => {
    setLoadingMatches(true);
    try {
      const response = await api.listMatches(50);
      setMatches(response.matches);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoadingMatches(false);
    }
  };

  useEffect(() => {
    void refreshMatches();
  }, []);

  useEffect(() => {
    if (!currentJob || isTerminal(currentJob.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const job = await api.getIngestJob(currentJob.id);
        setCurrentJob(job);
        if (isTerminal(job.status)) void refreshMatches();
      } catch (err) {
        setError(apiErrorMessage(err));
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [currentJob?.id, currentJob?.status]);

  const handleStart = async () => {
    setError(null);
    try {
      const job = await api.startSquadSampleIngest({
        maxMatches: limit,
        parseProfile: selectedMode.id,
        positionIntervalSeconds: selectedMode.interval,
      });
      setCurrentJob(job);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleStop = async () => {
    if (!currentJob) return;
    setError(null);
    try {
      setCurrentJob(await api.cancelIngestJob(currentJob.id));
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleRetry = async () => {
    if (!currentJob) return;
    setError(null);
    try {
      setCurrentJob(await api.retryIngestJob(currentJob.id));
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const handleDeleteMatch = async (matchId: string) => {
    setError(null);
    try {
      await api.deleteMatch(matchId);
      await refreshMatches();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  return (
    <div className="flex flex-col lg:flex-row h-full w-full bg-neutral-950 p-6 gap-6 overflow-y-auto">
      <div className="w-full lg:w-96 flex flex-col gap-6 shrink-0">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 shadow-sm">
          <h2 className="text-lg font-bold flex items-center gap-2 text-white mb-6">
            <Database className="w-5 h-5 text-blue-400" /> 发起采集任务
          </h2>

          <div className="space-y-5">
            <div>
              <label className="text-sm font-medium text-neutral-300 block mb-2">采集数量限制（场次）</label>
              <input
                type="number"
                min={1}
                max={100}
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-neutral-300 block mb-2">过滤模式</label>
              <div className="flex flex-col gap-3">
                {filterModes.map((mode) => (
                  <button
                    key={mode.id}
                    onClick={() => setFilterMode(mode.id)}
                    className={`p-3 rounded-lg border text-left transition-all ${filterMode === mode.id ? "bg-blue-500/10 border-blue-500" : "bg-neutral-950 border-neutral-800 hover:border-neutral-600"}`}
                  >
                    <div className={`font-medium text-sm ${filterMode === mode.id ? "text-blue-400" : "text-neutral-200"}`}>{mode.label}</div>
                    <div className="text-xs text-neutral-500 mt-1">{mode.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <button
              disabled={taskStatus === "running"}
              onClick={handleStart}
              className={`w-full py-3 rounded-lg font-bold flex items-center justify-center gap-2 transition-all ${taskStatus === "running" ? "bg-neutral-800 text-neutral-500 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/20 hover:-translate-y-0.5"}`}
            >
              <Play className="w-4 h-4 fill-current" /> 开始采集
            </button>

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 text-red-200 text-sm rounded-lg p-3">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-6 min-w-0">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold text-white">当前任务</h2>
            <div className="flex items-center gap-2">
              {taskStatus === "failed" && (
                <button onClick={handleRetry} className="flex items-center gap-1 px-3 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 rounded border border-blue-500/20 text-xs font-medium transition-colors">
                  <RotateCcw className="w-3 h-3" /> 重试
                </button>
              )}
              {taskStatus === "running" && (
                <button onClick={handleStop} className="flex items-center gap-1 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded border border-red-500/20 text-xs font-medium transition-colors">
                  <Square className="w-3 h-3 fill-current" /> 终止
                </button>
              )}
            </div>
          </div>

          {!currentJob ? (
            <div className="text-center py-8 text-neutral-500 text-sm border border-dashed border-neutral-800 rounded-lg">
              暂无活动中的采集任务。
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-between text-sm">
                <span className="text-neutral-300">任务ID: <span className="font-mono text-neutral-400">{currentJob.id}</span></span>
                <span className="text-blue-400 font-medium">{statusLabel(currentJob.status)} · {progress}%</span>
              </div>
              <div className="h-2 w-full bg-neutral-950 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 transition-all duration-300 ease-out" style={{ width: `${progress}%` }} />
              </div>
              <div className="flex flex-wrap gap-4 text-xs">
                <div className="flex items-center gap-1.5 text-neutral-400"><CheckCircle2 className="w-4 h-4 text-green-500" /> {currentJob.success_count} / {currentJob.total_count || limit} 场次</div>
                <div className="flex items-center gap-1.5 text-neutral-400"><AlertCircle className="w-4 h-4 text-yellow-500" /> {currentJob.skipped_count} 跳过 · {currentJob.failed_count} 失败</div>
              </div>
            </div>
          )}
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm flex-1 flex flex-col min-h-[300px]">
          <div className="p-5 border-b border-neutral-800 flex justify-between items-center">
            <h2 className="text-lg font-bold text-white">已采集对局列表</h2>
            <button onClick={refreshMatches} className="p-2 hover:bg-neutral-800 rounded-lg text-neutral-400 transition-colors" title="刷新">
              {loadingMatches ? <RotateCcw className="w-4 h-4 animate-spin" /> : <Filter className="w-4 h-4" />}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-neutral-300">
              <thead className="text-xs text-neutral-500 uppercase bg-neutral-950/50">
                <tr>
                  <th className="px-5 py-3 font-medium">对局ID</th>
                  <th className="px-5 py-3 font-medium">地图 / 模式</th>
                  <th className="px-5 py-3 font-medium">遥测数据</th>
                  <th className="px-5 py-3 font-medium">样本数</th>
                  <th className="px-5 py-3 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((match) => (
                  <tr key={match.match_id} className="border-b border-neutral-800/50 hover:bg-neutral-800/30 transition-colors">
                    <td className="px-5 py-3 font-mono text-neutral-400">{match.match_id}</td>
                    <td className="px-5 py-3">
                      <div className="font-medium text-neutral-200">{match.map_name ?? "未知地图"}</div>
                      <div className="text-xs text-neutral-500">{match.game_mode ?? "未知模式"} · {compactDate(match.created_at)}</div>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${match.telemetry_parse_status === "completed" ? "bg-green-500/10 text-green-400" : match.telemetry_parse_status === "failed" ? "bg-red-500/10 text-red-400" : "bg-yellow-500/10 text-yellow-500"}`}>
                        {statusLabel(match.telemetry_parse_status)}
                      </span>
                    </td>
                    <td className="px-5 py-3">{(match.circle_phase_count + match.position_sample_count + match.life_event_count).toLocaleString()}</td>
                    <td className="px-5 py-3 text-right">
                      <button onClick={() => handleDeleteMatch(match.match_id)} className="p-1.5 text-red-400 hover:bg-red-500/10 rounded" title="删除">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {matches.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-5 py-10 text-center text-neutral-500">
                      还没有已入库对局。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
