import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import zhCN from "@astryxdesign/core/locales/zh-CN.generated.js";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { RouterProvider } from "react-router";
import { router } from "./routes";

export default function App() {
  return (
    <Theme theme={neutralTheme} mode="dark">
      <InternationalizationProvider locale="zh-CN" messages={{ "zh-CN": zhCN }}>
        <RouterProvider router={router} />
      </InternationalizationProvider>
    </Theme>
  );
}
