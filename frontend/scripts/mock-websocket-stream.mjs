import { createServer } from "http";
import { randomUUID } from "crypto";
import { WebSocketServer } from "ws";

const host = process.env.MOCK_WS_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.MOCK_WS_PORT ?? "8787", 10);
const intervalMs = Number.parseInt(process.env.MOCK_WS_INTERVAL_MS ?? "2000", 10);

const symbolProfiles = {
  FPT: {
    symbol: "FPT",
    provider_symbol: "FPT.VN",
    company_name: "FPT Corporation",
    price: 128.25,
    mtf_score: 77.2,
    mtf_signal: "BUY",
    ls_ratio: 2.14,
    ls_signal: "SHOCK_ACCUMULATION",
    z_score: 1.28,
    z_signal: "NEUTRAL",
    trend_delta: 15.2,
    trend_signal: "BULLISH_TREND",
  },
  HPG: {
    symbol: "HPG",
    provider_symbol: "HPG.VN",
    company_name: "Hoa Phat Group",
    price: 26.75,
    mtf_score: 58.4,
    mtf_signal: "NEUTRAL",
    ls_ratio: 1.42,
    ls_signal: "NEUTRAL",
    z_score: -0.34,
    z_signal: "NEUTRAL",
    trend_delta: -11.1,
    trend_signal: "BEARISH_TREND",
  },
  VCB: {
    symbol: "VCB",
    provider_symbol: "VCB.VN",
    company_name: "Joint Stock Commercial Bank for Foreign Trade of Vietnam",
    price: 91.8,
    mtf_score: 82.1,
    mtf_signal: "BUY",
    ls_ratio: 1.95,
    ls_signal: "NEUTRAL",
    z_score: 2.12,
    z_signal: "SELL_OVERBOUGHT",
    trend_delta: 20.5,
    trend_signal: "BULLISH_TREND",
  },
};

const dashboardSymbols = {
  dash_01: ["FPT", "HPG", "VCB"],
  banking: ["VCB", "FPT"],
  steel: ["HPG"],
};

const clientState = new Map();

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function updateProfile(profile) {
  const noise = (Math.random() - 0.5) * 0.9;
  const drift = profile.mtf_signal === "BUY" ? 0.22 : profile.mtf_signal === "SELL" ? -0.22 : 0;
  const nextPrice = Math.max(1, profile.price + noise + drift);

  profile.price = Number(nextPrice.toFixed(2));
  profile.mtf_score = Number(clamp(profile.mtf_score + noise * 2.5, 5, 99).toFixed(2));
  profile.ls_ratio = Number(clamp(profile.ls_ratio + Math.abs(noise) * 0.15, 0.5, 4).toFixed(2));
  profile.z_score = Number(clamp(profile.z_score + noise * 0.6, -6, 6).toFixed(2));
  profile.trend_delta = Number(clamp(profile.trend_delta + noise * 4, -200, 200).toFixed(2));

  profile.mtf_signal = profile.mtf_score > 75 ? "BUY" : profile.mtf_score < 30 ? "SELL" : "NEUTRAL";
  profile.ls_signal = profile.ls_ratio > 2.2 ? (noise >= 0 ? "SHOCK_ACCUMULATION" : "SHOCK_DISTRIBUTION") : "NEUTRAL";
  profile.z_signal = profile.z_score > 2 ? "SELL_OVERBOUGHT" : profile.z_score < -2 ? "BUY_OVERSOLD" : "NEUTRAL";
  profile.trend_signal = profile.trend_delta > 8 ? "BULLISH_TREND" : profile.trend_delta < -8 ? "BEARISH_TREND" : "NEUTRAL";

  return profile;
}

function buildPacket(dashboardId, connectionId) {
  const symbols = dashboardSymbols[dashboardId] ?? dashboardSymbols.dash_01;
  const payload = {};
  for (const symbol of symbols) {
    const source = symbolProfiles[symbol] ?? symbolProfiles.FPT;
    payload[symbol] = { ...updateProfile(source) };
  }

  return {
    dashboard_id: dashboardId,
    connection_id: connectionId,
    as_of_epoch: Math.floor(Date.now() / 1000),
    data: payload,
  };
}

const httpServer = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      service: "local-mock-websocket-stream",
      websocket: `ws://${host}:${port}`,
      usage: "Connect with ?dashboardId=dash_01",
      dataMode: "synthetic",
    })
  );
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("error", (error) => {
  if (error?.code !== "EADDRINUSE") {
    console.error("[mock-ws] websocket server error:", error);
    process.exit(1);
  }

  console.warn(`[mock-ws] port ${port} is already in use; reusing existing stream server if available.`);
  setInterval(() => {
    // Keep process alive so concurrently does not kill Next.js.
  }, 60_000);
});

wss.on("connection", (socket, request) => {
  const reqUrl = new URL(request.url ?? "/", `ws://${request.headers.host ?? "localhost"}`);
  const dashboardId = (reqUrl.searchParams.get("dashboardId") || "dash_01").trim() || "dash_01";
  const connectionId = `local_${randomUUID().slice(0, 8)}`;

  const timer = setInterval(() => {
    const packet = buildPacket(dashboardId, connectionId);
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(packet));
    }
  }, Math.max(500, intervalMs));

  clientState.set(socket, { timer, dashboardId, connectionId });

  const packet = buildPacket(dashboardId, connectionId);
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(packet));
  }

  socket.on("close", () => {
    const state = clientState.get(socket);
    if (state) {
      clearInterval(state.timer);
      clientState.delete(socket);
    }
  });
});

httpServer.listen(port, host, () => {
  console.log(`[mock-ws] running on ws://${host}:${port}`);
  console.log(`[mock-ws] interval ${Math.max(500, intervalMs)}ms`);
  console.log("[mock-ws] mode synthetic");
  console.log("[mock-ws] dashboards: dash_01, banking, steel");
});
