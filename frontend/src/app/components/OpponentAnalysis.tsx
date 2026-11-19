import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Search } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { apiErrorMessage } from "../api";
import { analyzeOpponents, type OpponentReport } from "../opponentAnalysis";
import { usePlayerWorkspace } from "../playerWorkspace";
import { OpponentOverview } from "./OpponentOverview";

export function OpponentAnalysis() {
  const { player, matchDate } = usePlayerWorkspace();
  const [limit, setLimit] = useState("20");
  const [report, setReport] = useState<OpponentReport | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      run.current?.abort();
    },
    [],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const controller = new AbortController();
    run.current = controller;
    setBusy(true);
    setReport(null);
    setError("");
    try {
      const range = matchDate ? { match_date: matchDate } : { limit: Number(limit) };
      await analyzeOpponents(player.player_id, range, controller.signal, setReport, setStatus);
      setStatus("分析完成");
    } catch (e) {
      if (controller.signal.aborted) setStatus("已停止查询");
      else {
        setError(apiErrorMessage(e));
        setStatus("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-body text-primary">
      <div className="mx-auto flex max-w-7xl flex-col gap-5 px-3 py-5 sm:px-6 sm:py-7">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">交手对手强度</h1>
            <p className="mt-2 text-sm text-secondary">
              汇总实际发生伤害、击倒或淘汰的对手，查看对方战绩与交手结果。
            </p>
          </div>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            {!matchDate && (
              <SegmentedControl
                label="最近对局数"
                value={limit}
                onChange={setLimit}
                isDisabled={busy}
                size="lg"
              >
                <SegmentedControlItem value="15" label="近 15 局" />
                <SegmentedControlItem value="20" label="近 20 局" />
              </SegmentedControl>
            )}
            <Button
              type="submit"
              label="分析"
              icon={<Search size={16} />}
              variant="primary"
              size="lg"
              isDisabled={busy}
            />
            <Button label="多人对比" variant="secondary" href="/team-dashboard" as={Link} />
            {busy && (
              <Button
                type="button"
                label="停止"
                variant="secondary"
                size="lg"
                onClick={() => run.current?.abort()}
              />
            )}
          </form>
        </header>
        {status && (
          <p role="status" className="text-sm text-secondary">
            {status}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-amber-400">
            {error}
          </p>
        )}
        {report && <OpponentOverview report={report} busy={busy} />}
      </div>
    </div>
  );
}
