const PUBG_MAP_DISPLAY_NAMES: Record<string, string> = {
  Baltic_Main: "Erangel",
  Erangel_Main: "Erangel",
  Chimera_Main: "Paramo",
  Desert_Main: "Miramar",
  Savage_Main: "Sanhok",
  DihorOtok_Main: "Vikendi",
  Summerland_Main: "Karakin",
  Tiger_Main: "Taego",
  Kiki_Main: "Deston",
  Neon_Main: "Rondo",
};

export function mapDisplayName(mapName: string | null) {
  if (!mapName) return "未知地图";
  return PUBG_MAP_DISPLAY_NAMES[mapName] ?? mapName.replace(/_Main$/, "");
}
