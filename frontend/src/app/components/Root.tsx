import { Outlet, NavLink } from "react-router";
import { Map as MapIcon, Database, Activity, Target, Route } from "lucide-react";
import { Button } from "./ui/button";

export function Root() {
  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100 font-sans overflow-hidden">
      <nav className="w-64 border-r border-neutral-800 bg-neutral-900/50 flex flex-col backdrop-blur-sm z-10 shrink-0">
        <div className="p-6 flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-orange-500/20 text-orange-500 flex items-center justify-center">
            <Target className="w-5 h-5" />
          </div>
          <h1 className="text-lg font-bold tracking-wider">战术<span className="text-orange-500">预测系统</span></h1>
        </div>
        <div className="flex flex-col gap-2 px-4 mt-4">
          <Button variant="ghost" asChild className="w-full justify-start h-auto py-3 px-4 font-medium transition-colors hover:bg-neutral-800 hover:text-neutral-200">
            <NavLink to="/" className={({isActive}) => isActive ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20 rounded-lg' : 'text-neutral-400'}>
               <MapIcon className="w-4 h-4 mr-3" /> 战术预测
            </NavLink>
          </Button>
          <Button variant="ghost" asChild className="w-full justify-start h-auto py-3 px-4 font-medium transition-colors hover:bg-neutral-800 hover:text-neutral-200">
            <NavLink to="/collection" className={({isActive}) => isActive ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20 rounded-lg' : 'text-neutral-400'}>
               <Database className="w-4 h-4 mr-3" /> 数据采集
            </NavLink>
          </Button>
          <Button variant="ghost" asChild className="w-full justify-start h-auto py-3 px-4 font-medium transition-colors hover:bg-neutral-800 hover:text-neutral-200">
            <NavLink to="/preparation" className={({isActive}) => isActive ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20 rounded-lg' : 'text-neutral-400'}>
               <Activity className="w-4 h-4 mr-3" /> 数据准备
            </NavLink>
          </Button>
          <Button variant="ghost" asChild className="w-full justify-start h-auto py-3 px-4 font-medium transition-colors hover:bg-neutral-800 hover:text-neutral-200">
            <NavLink to="/analysis" className={({isActive}) => isActive ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20 rounded-lg' : 'text-neutral-400'}>
               <Route className="w-4 h-4 mr-3" /> 对局分析
            </NavLink>
          </Button>
        </div>
        <div className="mt-auto p-4 border-t border-neutral-800">
          <div className="flex items-center gap-3 px-2 py-2">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs text-neutral-500 font-medium">模型服务器：在线</span>
          </div>
        </div>
      </nav>
      <main className="flex-1 relative bg-neutral-950 h-full flex flex-col min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
