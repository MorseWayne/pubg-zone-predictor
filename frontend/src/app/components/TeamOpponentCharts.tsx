import { useState } from "react";
import { teamOpponentDistribution, type TeamComparison } from "../opponentAnalysis";
import "./teamOpponentCharts.css";

function coverage(known: number, total: number) {
  return `已知 ${known} / ${total} 人次 · 暂缺 ${total - known} 人次`;
}

export function TeamOpponentCharts({ report }: { report: TeamComparison }) {
  const [percent, setPercent] = useState(false);
  const { kd, levels, total } = teamOpponentDistribution(report);
  const kdKnown = kd.reduce((sum, band) => sum + band.count, 0);
  const levelKnown = levels.reduce((sum, band) => sum + band.count, 0);
  const kdMax = Math.max(...kd.map(band => band.count));
  const levelMax = levels.reduce((max, band) => Math.max(max, band.count), 0);
  const tiers = [...new Set(levels.map(band => band.tier))];
  const starts = [...new Set(levels.map(band => band.start))].sort((a, b) => a - b);
  const cells = new Map(levels.map(band => [`${band.tier}/${band.start}`, band.count]));
  const share = (count: number, known: number) => `${(100 * count / known).toFixed(1)}%`;
  const value = (count: number, known: number) => percent ? share(count, known) : String(count);

  return (
    <div className="team-charts">
      <div className="team-charts-toolbar">
        <div role="group" aria-label="分布图显示单位" className="team-chart-toggle">
          {[false, true].map(asPercent => (
            <button key={String(asPercent)} type="button" aria-pressed={percent === asPercent}
              onClick={() => setPercent(asPercent)}>{asPercent ? "占比" : "人次"}</button>
          ))}
        </div>
      </div>
      <div className="team-charts-grid">
        <section className="team-chart" aria-label="对手赛季 KD 分布">
          <h4>对手赛季 KD 分布</h4>
          <p className="team-chart-note">{coverage(kdKnown, total)}</p>
          {kdKnown ? (
            <div className="team-histogram">
              {kd.map(band => (
                <div key={band.label} className="team-hist-column"
                  title={`KD ${band.label} · ${band.count} 人次 · ${share(band.count, kdKnown)}`}>
                  <div className="team-hist-track">
                    <div className={`team-hist-bar ${band.color}`}
                      style={{ height: `${80 * band.count / kdMax}%` }}>
                      <strong>{value(band.count, kdKnown)}</strong>
                    </div>
                  </div>
                  <span className="team-hist-label">{band.label}</span>
                </div>
              ))}
            </div>
          ) : <p className="team-chart-empty">暂无已知 KD 的交手样本</p>}
        </section>
        <section className="team-chart" aria-label="对手生存等级分布">
          <h4>对手生存等级分布</h4>
          <p className="team-chart-note">{coverage(levelKnown, total)}</p>
          {levelKnown ? <>
            <div className="team-heat-scroll">
              <table className="team-heat">
                <caption>各阶的等级段（Lv.）</caption>
                <thead><tr><th scope="col">阶数</th>
                  {starts.map(start => <th scope="col" key={start}>{start}–{start + 99}</th>)}
                </tr></thead>
                <tbody>{tiers.map(tier => <tr key={tier}>
                  <th scope="row">{tier} 阶</th>
                  {starts.map(start => {
                    const count = cells.get(`${tier}/${start}`) ?? 0;
                    return <td key={start} data-intensity={Math.ceil(4 * count / levelMax)}
                      title={`${tier} 阶 · Lv.${start}–${start + 99} · ${count} 人次 · ${share(count, levelKnown)}`}>
                      {value(count, levelKnown)}
                    </td>;
                  })}
                </tr>)}</tbody>
              </table>
            </div>
            <div className="team-heat-legend" aria-hidden="true">少
              {[0, 1, 2, 3, 4].map(step => <i key={step} data-intensity={step} />)}多
            </div>
          </> : <p className="team-chart-empty">暂无已知等级的交手样本</p>}
        </section>
      </div>
      <p className="team-chart-note">占比按各图已知人次计算。KD 取该局所属赛季和模式，生存等级取查询时的值。</p>
    </div>
  );
}
