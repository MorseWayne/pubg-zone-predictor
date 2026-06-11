import { useState } from "react";
import { Activity, Brain, Map as MapIcon, ShieldAlert, Cpu, Layers, RefreshCw, CheckCircle2 } from "lucide-react";

export function DataPreparation() {
  const [isGenerating, setIsGenerating] = useState(false);
  const [isTraining, setIsTraining] = useState(false);
  const [hotspotReady, setHotspotReady] = useState(false);
  const [modelReady, setModelReady] = useState(false);

  const handleGenerate = () => {
    setIsGenerating(true);
    setTimeout(() => {
      setIsGenerating(false);
      setHotspotReady(true);
    }, 2000);
  };

  const handleTrain = () => {
    setIsTraining(true);
    setTimeout(() => {
      setIsTraining(false);
      setModelReady(true);
    }, 3000);
  };

  return (
    <div className="flex flex-col h-full w-full bg-neutral-950 p-6 gap-6 overflow-y-auto">
      
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-purple-500/20 text-purple-400 rounded-lg">
          <Activity className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">预测基建</h1>
          <p className="text-sm text-neutral-400">管理数据就绪状态和模型状态，以确保准确的战术预测。</p>
        </div>
      </div>

      {/* Readiness Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Hotspot Card */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 flex flex-col gap-4">
          <div className="flex justify-between items-start">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-500/10 rounded border border-blue-500/20 text-blue-400">
                <Layers className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-neutral-200">热力图数据</h3>
                <p className="text-xs text-neutral-500">空间密度映射</p>
              </div>
            </div>
            {hotspotReady ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-green-400 bg-green-500/10 px-2 py-1 rounded">
                <CheckCircle2 className="w-3.5 h-3.5" /> 已就绪
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-medium text-yellow-500 bg-yellow-500/10 px-2 py-1 rounded">
                <ShieldAlert className="w-3.5 h-3.5" /> 需要更新
              </span>
            )}
          </div>
          
          <div className="text-sm text-neutral-400 mt-2 flex-1">
            基于已采集的对局生成高危区域。目前有 14,200 个新样本等待集成。
          </div>

          <button 
            onClick={handleGenerate}
            disabled={isGenerating || hotspotReady}
            className={`w-full py-2.5 rounded-lg text-sm font-bold flex justify-center items-center gap-2 transition-all ${isGenerating ? 'bg-neutral-800 text-neutral-400' : hotspotReady ? 'bg-neutral-800/50 text-neutral-500 border border-neutral-700' : 'bg-blue-600 hover:bg-blue-500 text-white'}`}
          >
            {isGenerating ? <RefreshCw className="w-4 h-4 animate-spin" /> : '生成热力图'}
          </button>
        </div>

        {/* Model Card */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 flex flex-col gap-4">
          <div className="flex justify-between items-start">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-500/10 rounded border border-purple-500/20 text-purple-400">
                <Brain className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-neutral-200">预测模型</h3>
                <p className="text-xs text-neutral-500">XGBoost 区域推断</p>
              </div>
            </div>
            {modelReady ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-green-400 bg-green-500/10 px-2 py-1 rounded">
                <CheckCircle2 className="w-3.5 h-3.5" /> v2.5 已激活
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs font-medium text-yellow-500 bg-yellow-500/10 px-2 py-1 rounded">
                <ShieldAlert className="w-3.5 h-3.5" /> 已过期 (v2.4)
              </span>
            )}
          </div>
          
          <div className="text-sm text-neutral-400 mt-2 flex-1">
            在最新的热力图和阶段数据上训练预测模型。需要就绪的热力图数据以获得最佳结果。
          </div>

          <button 
            onClick={handleTrain}
            disabled={isTraining || modelReady || (!hotspotReady && !modelReady)}
            className={`w-full py-2.5 rounded-lg text-sm font-bold flex justify-center items-center gap-2 transition-all ${isTraining ? 'bg-neutral-800 text-neutral-400' : modelReady ? 'bg-neutral-800/50 text-neutral-500 border border-neutral-700' : !hotspotReady ? 'bg-neutral-800 text-neutral-500 cursor-not-allowed' : 'bg-purple-600 hover:bg-purple-500 text-white'}`}
          >
            {isTraining ? <RefreshCw className="w-4 h-4 animate-spin" /> : !hotspotReady && !modelReady ? '等待热力图' : '训练模型'}
          </button>
        </div>

      </div>

      {/* System Summary */}
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 mt-2">
         <h3 className="text-sm font-bold text-neutral-200 mb-4 flex items-center gap-2">
           <Cpu className="w-4 h-4 text-neutral-400" /> 系统总览
         </h3>
         <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
           <div className="bg-neutral-950 p-4 rounded-lg border border-neutral-800">
             <div className="text-xs text-neutral-500 mb-1">总对局数</div>
             <div className="text-xl font-bold text-white">45,102</div>
           </div>
           <div className="bg-neutral-950 p-4 rounded-lg border border-neutral-800">
             <div className="text-xs text-neutral-500 mb-1">总样本数</div>
             <div className="text-xl font-bold text-white">1.2M</div>
           </div>
           <div className="bg-neutral-950 p-4 rounded-lg border border-neutral-800">
             <div className="text-xs text-neutral-500 mb-1">模型准确率</div>
             <div className="text-xl font-bold text-green-400">76.4%</div>
           </div>
           <div className="bg-neutral-950 p-4 rounded-lg border border-neutral-800">
             <div className="text-xs text-neutral-500 mb-1">规则回退使用率</div>
             <div className="text-xl font-bold text-yellow-500">12%</div>
           </div>
         </div>

         {!hotspotReady && !modelReady && (
           <div className="mt-4 bg-orange-500/10 border border-orange-500/20 p-4 rounded-lg text-sm text-orange-200 flex items-start gap-3">
             <ShieldAlert className="w-5 h-5 text-orange-400 shrink-0" />
             <div>
               <strong className="block text-orange-400 mb-1">规则回退已激活</strong>
               如果在模型更新之前请求预测，系统将暂时依赖硬编码的启发式规则（例如，加权中心收缩），这会降低准确率。
             </div>
           </div>
         )}
      </div>

    </div>
  );
}