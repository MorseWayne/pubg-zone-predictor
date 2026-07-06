import { createBrowserRouter } from "react-router";
import { Root } from "./components/Root";
import { TacticalPrediction } from "./components/TacticalPrediction";
import { DataCollection } from "./components/DataCollection";
import { DataPreparation } from "./components/DataPreparation";
import { PlayerMatchAnalysis } from "./components/PlayerMatchAnalysis";
import { TeamDashboard } from "./components/TeamDashboard";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Root,
    children: [
      { index: true, Component: TacticalPrediction },
      { path: "collection", Component: DataCollection },
      { path: "preparation", Component: DataPreparation },
      { path: "analysis", Component: PlayerMatchAnalysis },
      { path: "team-dashboard", Component: TeamDashboard },
    ],
  },
]);
