import { createBrowserRouter, Navigate } from "react-router";
import { Root } from "./components/Root";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Root,
    children: [
      { index: true, element: <Navigate to="/analysis" replace /> },
      {
        path: "collection",
        lazy: async () => {
          const { DataCollection } = await import("./components/DataCollection");
          return { Component: DataCollection };
        },
      },
      {
        path: "analysis",
        lazy: async () => ({ Component: (await import("./components/PlayerMatchAnalysis")).PlayerMatchAnalysis }),
      },
      { path: "opponents", element: <Navigate to="/team-dashboard" replace /> },
      {
        path: "personal-trend",
        lazy: async () => {
          const { PersonalTrend } = await import("./components/PersonalTrend");
          return { Component: PersonalTrend };
        },
      },
      {
        path: "team-dashboard",
        lazy: async () => {
          const { TeamDashboard } = await import("./components/TeamDashboard");
          return { Component: TeamDashboard };
        },
      },
      { path: "preparation", element: <Navigate to="/analysis" replace /> },
    ],
  },
]);
