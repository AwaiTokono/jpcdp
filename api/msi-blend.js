// JPCDP Phase 4 — MSI Blend API
// 統計スコア（JMR基盤）＋ BroadListeningシグナル → ブレンドMSIを返す

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Phase 2/3 統計ベーススコア
const BASE_SCORES = {
  hokkaido: [3,1,1,2,2,2],
  tohoku:   [2,1,0,1,2,2],
  kanto:    [4,3,4,3,4,3],
  chubu:    [2,1,1,2,3,2],
  kinki:    [3,2,3,2,4,3],
  chugoku:  [2,1,1,1,2,2],
  shikoku:  [1,1,2,1,1,1],
  kyushu:   [2,2,2,2,3,3],
};

const CAT_INDEX = { density:0, baptism:1, access:2, bearer:3, accessibility:4, openness:5 };

// シグナル強度 → 重み
function signalWeight(direction, strength) {
  const base = strength * 0.15; // max 0.45
  return direction === "positive" ? base : direction === "negative" ? -base : 0;
}

// 直近30日のシグナルを取得・集計してブレンドスコアを計算
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // 直近30日のシグナルを取得
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: signals, error } = await supabase
      .from("bl_msi_signals")
      .select("region_id, category, direction, strength, suggested_delta, created_at")
      .gte("created_at", since);

    if (error) throw error;

    // 地域×指標ごとにシグナルを集計
    const adjustments = {};
    Object.keys(BASE_SCORES).forEach(rid => {
      adjustments[rid] = [0, 0, 0, 0, 0, 0]; // 6指標の調整値
    });

    (signals || []).forEach(sig => {
      const rid = sig.region_id;
      const ci = CAT_INDEX[sig.category];
      if (rid in adjustments && ci !== undefined) {
        // 直近ほど重み大（時間減衰）
        const age = (Date.now() - new Date(sig.created_at)) / (30 * 24 * 60 * 60 * 1000);
        const decay = Math.max(0, 1 - age);
        const weight = signalWeight(sig.direction, sig.strength) * decay;
        adjustments[rid][ci] += weight;
      }
    });

    // ブレンドスコア計算
    const blended = {};
    Object.entries(BASE_SCORES).forEach(([rid, base]) => {
      const adj = adjustments[rid];
      const blendedScores = base.map((b, i) =>
        Math.max(0, Math.min(5, parseFloat((b + adj[i]).toFixed(2))))
      );
      const baseMS = Math.round((base.reduce((a,b)=>a+b,0)/30)*100);
      const blendMSI = Math.round((blendedScores.reduce((a,b)=>a+b,0)/30)*100);
      blended[rid] = {
        base_scores: base,
        base_msi: baseMS,
        adjustments: adj.map(a => parseFloat(a.toFixed(2))),
        blended_scores: blendedScores,
        blended_msi: blendMSI,
        delta: blendMSI - baseMS,
        signal_count: (signals || []).filter(s => s.region_id === rid).length,
      };
    });

    // 声のサマリー（地域別最新3件）
    const { data: recentVoices } = await supabase
      .from("bl_msi_voices")
      .select("region_id, summary, urgency, submitter_type, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(50);

    const voiceSummary = {};
    (recentVoices || []).forEach(v => {
      if (!voiceSummary[v.region_id]) voiceSummary[v.region_id] = [];
      if (voiceSummary[v.region_id].length < 3) voiceSummary[v.region_id].push(v);
    });

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      period_days: 30,
      total_signals: (signals || []).length,
      blended,
      recent_voices: voiceSummary,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
