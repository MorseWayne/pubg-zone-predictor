import { useState } from "react";
import { Database, Play, Square, RotateCcw, Trash2, Filter, AlertCircle, CheckCircle2 } from "lucide-react";

type TaskStatus = 'idle' | 'running' | 'completed' | 'failed';

export function DataCollection() {
  const [limit, setLimit] = useState(100);
  const [filterMode, setFilterMode] = useState("priority");
  const [taskStatus, setTaskStatus] = useState<TaskStatus>('idle');
  const [progress, setProgress] = useState(0);

  const handleStart = () => {
    setTaskStatus('running');
    setProgress(0);
    const interval = setInterval(() => {
      setProgress(p => {
        if (p >= 100) {
          clearInterval(interval);
          setTaskStatus('completed');
          return 100;
        }
        return p + 5;
      });
    }, 200);
  };

  const handleStop = () => {
    setTaskStatus('idle');
    setProgress(0);
  };

  const matches = [
    { id: "M-9921", map: "艾伦格", mode: "四排 FPP", time: "10 分钟前", status: "Complete", samples: 1420 },
    { id: "M-9920", map: "米拉玛", mode: "四排 FPP", time: "25 分钟前", status: "Complete", samples: 1105 },
    { id: "M-9919", map: "艾伦格", mode: "双排 FPP", time: "1 小时前", status: "Failed", samples: 45 },
    { id: "M-9918", map: "萨诺", mode: "四排 TPP", time: "2 小时前", status: "Complete", samples: 890 },
  ];

  return (
    <div className="flex flex-col lg:flex-row h-full w-full bg-neutral-950 p-6 gap-6 overflow-y-auto">
      
      {/* Left Column: Initiation */}
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
                value={limit}
                onChange={(e) => setLimit(parseInt(e.target.value))}
                className="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-neutral-300 block mb-2">过滤模式</label>
              <div className="flex flex-col gap-3">
                {[
                  { id: "lightweight", label: "轻量级热力图", desc: "基础位置数据，处理速度快。" },
                  { id: "priority", label: "缩圈预测优先", desc: "侧重于阶段过渡和圈型变化。" },
                  { id: "full", label: "全量分析", desc: "包含所有遥测数据，占用存储空间大。" }
                ].map(mode => (
                  <button
                    key={mode.id}
                    onClick={() => setFilterMode(mode.id)}
                    className={`p-3 rounded-lg border text-left transition-all ${filterMode === mode.id ? 'bg-blue-500/10 border-blue-500' : 'bg-neutral-950 border-neutral-800 hover:border-neutral-600'}`}
                  >
                    <div className={`font-medium text-sm ${filterMode === mode.id ? 'text-blue-400' : 'text-neutral-200'}`}>{mode.label}</div>
                    <div className="text-xs text-neutral-500 mt-1">{mode.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <button
              disabled={taskStatus === 'running'}
              onClick={handleStart}
              className={`w-full py-3 rounded-lg font-bold flex items-center justify-center gap-2 transition-all ${taskStatus === 'running' ? 'bg-neutral-800 text-neutral-500 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/20 hover:-translate-y-0.5'}`}
            >
              <Play className="w-4 h-4 fill-current" /> 开始采集
            </button>
          </div>
        </div>
      </div>

      {/* Right Column: Progress & Data */}
      <div className="flex-1 flex flex-col gap-6 min-w-0">
        
        {/* Task Progress */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold text-white">当前任务</h2>
            <div className="flex items-center gap-2">
               {taskStatus === 'running' && (
                 <button onClick={handleStop} className="flex items-center gap-1 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded border border-red-500/20 text-xs font-medium transition-colors">
                   <Square className="w-3 h-3 fill-current" /> 终止
                 </button>
               )}
            </div>
          </div>

          {taskStatus === 'idle' ? (
            <div className="text-center py-8 text-neutral-500 text-sm border border-dashed border-neutral-800 rounded-lg">
              暂无活动中的采集任务。
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-between text-sm">
                <span className="text-neutral-300">任务ID: <span className="font-mono text-neutral-400">#TSK-8891-A</span></span>
                <span className="text-blue-400 font-medium">{progress}%</span>
              </div>
              <div className="h-2 w-full bg-neutral-950 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-blue-500 transition-all duration-300 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="flex gap-4 text-xs">
                <div className="flex items-center gap-1.5 text-neutral-400"><CheckCircle2 className="w-4 h-4 text-green-500" /> {Math.floor((limit * progress) / 100)} / {limit} 场次</div>
                <div className="flex items-center gap-1.5 text-neutral-400"><AlertCircle className="w-4 h-4 text-yellow-500" /> 2 跳过</div>
              </div>
            </div>
          )}
        </div>

        {/* Matches Table */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl shadow-sm flex-1 flex flex-col min-h-[300px]">
          <div className="p-5 border-b border-neutral-800 flex justify-between items-center">
            <h2 className="text-lg font-bold text-white">已采集对局列表</h2>
            <button className="p-2 hover:bg-neutral-800 rounded-lg text-neutral-400 transition-colors">
              <Filter className="w-4 h-4" />
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
                {matches.map((m, i) => (
                  <tr key={i} className="border-b border-neutral-800/50 hover:bg-neutral-800/30 transition-colors">
                    <td className="px-5 py-3 font-mono text-neutral-400">{m.id}</td>
                    <td className="px-5 py-3">
                      <div className="font-medium text-neutral-200">{m.map}</div>
                      <div className="text-xs text-neutral-500">{m.mode}</div>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${m.status === 'Complete' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                        {m.status === 'Complete' ? '完成' : '失败'}
                      </span>
                    </td>
                    <td className="px-5 py-3">{m.samples.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {m.status === 'Failed' && (
                           <button className="p-1.5 text-blue-400 hover:bg-blue-500/10 rounded" title="重试">
                             <RotateCcw className="w-4 h-4" />
                           </button>
                        )}
                        <button className="p-1.5 text-red-400 hover:bg-red-500/10 rounded" title="删除">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}