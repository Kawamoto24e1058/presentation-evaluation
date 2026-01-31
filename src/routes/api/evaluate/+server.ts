import { env } from '$env/dynamic/private';
import Groq from 'groq-sdk';
import { json } from '@sveltejs/kit';
import type { RequestEvent } from './$types';

const groq = new Groq({
    apiKey: env.GROQ_API_KEY
});

export const POST = async ({ request }: RequestEvent) => {
    try {
        const { transcript, audioFeatures } = await request.json();

        if (!transcript) {
            return json({ error: 'Transcript is required' }, { status: 400 });
        }

        let audioPrompt = "";
        if (audioFeatures) {
            audioPrompt = `
### Audio Analysis Data (Recorded Audio Features)
- **Pitch Variance**: ${audioFeatures.pitchVariance} (High variance indicates good intonation/expressiveness)
- **Volume Dynamics**: Max ${audioFeatures.volumeMax.toFixed(2)}, Min ${audioFeatures.volumeMin.toFixed(2)}, Avg ${audioFeatures.volumeAvg.toFixed(2)} (Range indicates vocal variety)
- **Pauses**: ${audioFeatures.pauseCount} pauses detected (Average duration: ${audioFeatures.pauseAvgDuration}ms). (Appropriate pauses indicate good pacing)

Use this data to refine your evaluation of **Delivery** and **Pace** according to the following guidelines:
1. **Low Pitch Variance**: If variance is low (< 0.5), mention "一本調子で、重要なポイントが埋もれています (Monotone, burying key points)".
2. **High Pitch Variance & Volume**: If variance is high (> 2.0) and volume range is wide, mention "抑揚が豊かで、熱意と自信が伝わります (Rich intonation, conveying enthusiasm and confidence)".
3. **Fast Pace but High Variance**: If the speaker is fast but has good pitch variance, mention "ピッチのメリハリが効いているため、スピード感があっても内容がスッと入ってきます (Good pitch modulation makes the fast pace easy to understand)".
`;
        }

        const systemPrompt = `
あなたはプロのプレゼンテーションコーチです。
ユーザーが提供するプレゼン原稿を分析し、以下の「大学生向けプレゼン5原則」に基づいて評価・添削を行ってください。
出力は必ずJSON形式のみとし、マークダウン記法や他のテキストを含めないでください。

### 🚨 採点ポリシー (重要)
1. **細密採点 (Granular Scoring)**:
   - **5点刻み（80, 85, 90等）の採点は禁止**です。「82点」「87点」「93点」など、詳細な分析に基づく**「1点単位のリアルな数値」**を算出してください。
2. **加点方式 (Additive Scoring)**:
   - 「完璧な状態から減点する」のではなく、**「良い要素（工夫、熱意、個性）」を見つけてポイントを積み上げる方式**で採点してください。
   - 多少の粗があっても、**「聴衆の心を動かす」「独自のスタイルがある」**場合は積極的にボーナス点を加算してください。
3. **個性重視 (Personality over Textbook)**:
   - 「教科書通りの優等生的なプレゼン」を求めすぎないでください。
   - 独特な言い回しや情熱的なスタイルも、説得力があれば「高いプレゼンスキル」として評価してください。

### 評価基準（各0-100点）
1. **Structure (構成)**: 
   - 冒頭のフック（興味付け）や、論理の飛躍がないか。
   - 独創的な構成や、意図的な伏線回収があれば加点して評価してください。
2. **Sentence (文章のキレ)**: 
   - 一文の長さ、リズム感。
   - 接続詞（〜ですが、〜なので）の多用回避。
   - 力強い言い切りや、印象的なフレーズがあれば高く評価してください。
3. **Delivery (デリバリー)**: 
   - 文脈から読み取れる「自信」や「熱量」。
   - 丸暗記感のない、自分の言葉で語りかけている感覚を加点評価します。
4. **Explaining Data (説明力)**: 
   - 事実（データ）と解釈（意見）の区別。
   - 難しい概念を例え話でわかりやすく説明していれば大幅に加点してください。
5. **Pace (話速/情報密度)**: 
   - 単なる「速度」ではなく**「質の高い情報伝達」**を評価してください。
   - **良い早口（高得点）**: 情報密度が高く、かつ聞き取りやすい（滑舌が良い、間が良い）。「テンポが良く、知的な印象を与える」とポジティブに評価すること。
   - **悪い早口（減点）**: 息継ぎがなく、情報の羅列になっている場合のみ減点する。
6. **Overall (総合評価)**: 
   - 上記5項目の平均ではなく、**「このプレゼンを聞いた聴衆がどう感じるか」**という全体的な印象点で算出してください。
   - 多少の技術的欠点があっても、**「面白かった」「心が動いた」**と感じられるなら90点以上の高得点をつけてください。

### 想定質問
発表内容についての鋭い質問や、深掘りされそうなポイントを3〜5つ提案してください。

### 出力フォーマット (JSON)
{
  "title": "内容を要約した15文字程度のタイトル",
  "score": {
    "structure": 0, /* int (e.g. 82, 91) */
    "sentence": 0,
    "delivery": 0,
    "explaining_data": 0,
    "pace": 0,
    "overall": 0
  },
  "feedback": "具体的なアドバイス（日本語）。「ここが良かった」という加点ポイントを具体的に褒め、その上で修正点を提案してください。",
  "structured_summary": "【一言要約】\nプレゼンの核心を1文で簡潔に記述します。\n\n\n【話の構造（AIにはこう伝わりました）】\n● 導入\n（ここには概要を記述）\n\n● 本論\n（ここには主張の根拠を記述）\n\n● 結論\n（ここにはメッセージを記述）\n\n\n【あなたのプレゼンの強み（Highlights）】\n1. （強み1）\n\n2. （強み2）\n\n3. （強み3）\n\n\n【キーワード】\nキーワード1 / キーワード2 / キーワード3\n\n※各【項目】の間には必ず空行を2つ入れ、項目内でも改行を適切に使用して視覚的に区別してください。",
  "questions": ["質問1", "質問2", "質問3"]
}
`;

        console.log("--- Sending Prompt to Groq ---");
        // Log truncated transcript for privacy/readability
        console.log(transcript.substring(0, 100) + "...");
        console.log("--------------------------------");

        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: transcript }
            ],
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" }
        });

        const content = completion.choices[0]?.message?.content;

        console.log("--- Raw Response from Groq ---");
        // Log the full content clearly
        console.log(JSON.stringify(content, null, 2));
        console.log("--------------------------------");

        if (!content) {
            throw new Error('No content received from Groq');
        }

        // Improved Regex to find the JSON object.
        // It looks for the first '{' and the last '}' that matches a valid JSON structure structure roughly.
        // Using a simple greedy match for now but with a fallback.
        const jsonMatch = content.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
            try {
                const jsonString = jsonMatch[0];
                const result = JSON.parse(jsonString);
                console.log("--- Parsed JSON successfully ---");
                return json(result);
            } catch (e) {
                console.error("Regex matched but JSON.parse failed:", e);
                // Proceed to fallback
            }
        }

        // Fallback: Try cleaning the string (remove potential Markdown ```json ... ``` wrappers manually if regex missed)
        const cleaned = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        try {
            const result = JSON.parse(cleaned);
            return json(result);
        } catch (e) {
            throw new Error("Failed to parse JSON from AI response. Raw content: " + content.substring(0, 100));
        }

    } catch (error: any) {
        console.error('Error in evaluation API (Groq):', error);
        return json({
            error: 'Failed to evaluate presentation',
            details: error.message || String(error)
        }, { status: 500 });
    }
};
