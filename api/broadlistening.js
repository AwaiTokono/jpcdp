// JPCDP Phase 4 — BroadListening API
// 現場の声を受信 → AI分析 → Supabase保存 → MSI調整値を返す

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MSI_CATEGORIES = [
  { id: "density",       label: "教会密度",        keywords: ["教会が少ない","教会が増え","開拓","新しい教会","教会がない"] },
  { id: "baptism",       label: "洗礼率",          keywords: ["洗礼","受洗","決心","信仰告白","新来者","求道者"] },
  { id: "access",        label: "福音アクセス密度", keywords: ["接点","オンライン","SNS","聖書会","礼拝","集会","伝道"] },
  { id: "bearer",        label: "担い手持続性",     keywords: ["牧師","後継者","若者","担い手","引退","高齢","後継"] },
  { id: "accessibility", label: "アクセシビリティ", keywords: ["バリアフリー","手話","外国人","車椅子","オンライン礼拝","移動"] },
  { id: "openness",      label: "地域開放性",       keywords: ["地域","子ども食堂","ボランティア","開放","社会","交流"] },
];

const REGIONS = [
  { id: "hokkaido", name: "北海道", prefs: ["北海道"] },
  { id: "tohoku",   name: "東北",   prefs: ["青森","岩手","宮城","秋田","山形","福島"] },
  { id: "kanto",    name: "関東",   prefs: ["茨城","栃木","群馬","埼玉","千葉","東京","神奈川","山梨"] },
  { id: "chubu",    name: "中部",   prefs: ["新潟","富山","石川","福井","長野","岐阜","静岡","愛知","三重"] },
  { id: "kinki",    name: "近畿",   prefs: ["滋賀","京都","大阪","兵庫","奈良","和歌山"] },
  { id: "chugoku",  name: "中国",   prefs: ["鳥取","島根","岡山","広島","山口"] },
  { id: "shikoku",  name: "四国",   prefs: ["徳島","香川","愛媛","高知"] },
  { id: "kyushu",   name: "九州・沖縄", prefs: ["福岡","佐賀","長崎","熊本","大分","宮崎","鹿児島","沖縄"] },
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // GET: 地域別の蓄積されたシグナルを返す
  if (req.method === "GET") {
    const { region_id } = req.query;
    try {
      let query = supabase
        .from("bl_msi_signals")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (region_id) query = query.eq("region_id", region_id);
      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json({ signals: data || [] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST: 新しい声を受信・分析・保存
  if (req.method !== "POST") return res.status(405).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  const { text, region_id, prefecture, submitter_type, anonymous } = req.body;
  if (!text || !region_id) return res.status(400).json({ error: "text and region_id required" });

  const region = REGIONS.find(r => r.id === region_id);
  if (!region) return res.status(400).json({ error: "Invalid region_id" });

  try {
    // ── AI分析: MSIシグナル抽出 ──────────────────────────────
    const analysisPrompt = `あなたはJPCDP（日本プロテスタント教会データプラットフォーム）のMSIシグナル抽出AIです。

以下の現場報告テキストを分析し、宣教構造指数（MSI）の6指標への影響を抽出してください。

【現場報告】
地域: ${region.name}
投稿者種別: ${submitter_type || "不明"}
テキスト: "${text}"

【MSI指標定義】
1. density（教会密度）: 地域人口に対する教会の存在度
2. baptism（洗礼率）: 求道者・受洗者の状況
3. access（福音アクセス密度）: 礼拝・集会・SNS等の接触機会
4. bearer（担い手持続性）: 牧師・奉仕者・次世代の継承
5. accessibility（アクセシビリティ）: 誰でも参加できる環境
6. openness（地域開放性）: 地域社会との連携・開放性

以下のJSON形式のみで回答してください（説明文不要）:
{
  "signals": [
    {
      "category": "指標ID(density/baptism/access/bearer/accessibility/openness)",
      "direction": "positive または negative または neutral",
      "strength": 1〜3の整数（1:弱い, 2:中程度, 3:強い）,
      "evidence": "根拠となる引用（20文字以内）",
      "suggested_delta": -1〜+1の小数（スコア調整推奨値）
    }
  ],
  "summary": "この報告の要約（40文字以内）",
  "urgency": "high または medium または low"
}`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        messages: [{ role: "user", content: analysisPrompt }],
      }),
    });

    const aiData = await aiRes.json();
    const aiText = aiData.content?.[0]?.text || "{}";

    let analysis = { signals: [], summary: text.slice(0, 40), urgency: "low" };
    try {
      const clean = aiText.replace(/```json|```/g, "").trim();
      analysis = JSON.parse(clean);
    } catch (e) {
      console.error("JSON parse error:", e);
    }

    // ── Supabaseに保存 ──────────────────────────────────────
    const voiceRecord = {
      region_id,
      prefecture: prefecture || null,
      submitter_type: submitter_type || "anonymous",
      text_content: anonymous ? "[匿名]" : text,
      summary: analysis.summary,
      urgency: analysis.urgency,
      signals: analysis.signals,
      created_at: new Date().toISOString(),
    };

    const { data: saved, error: saveError } = await supabase
      .from("bl_msi_voices")
      .insert(voiceRecord)
      .select()
      .single();

    if (saveError) throw saveError;

    // ── シグナルを別テーブルに展開 ──────────────────────────
    if (analysis.signals?.length > 0) {
      const signalRows = analysis.signals.map(s => ({
        voice_id: saved.id,
        region_id,
        category: s.category,
        direction: s.direction,
        strength: s.strength,
        evidence: s.evidence,
        suggested_delta: s.suggested_delta,
        created_at: new Date().toISOString(),
      }));
      await supabase.from("bl_msi_signals").insert(signalRows);
    }

    return res.status(200).json({
      success: true,
      voice_id: saved.id,
      analysis,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
