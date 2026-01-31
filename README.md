# Vocalog AI (旧: AI Presentation Coach)

あなたの声をリアルタイムで分析し、星空のような美しいビジュアルと共にフィードバックを提供するAIプレゼンコーチングアプリです。
話した内容は即座に文字起こしされ、AIが「構成」「話し方」「個性」の観点から評価・アドバイスを行います。

## 機能
- **リアルタイム文字起こし**: Web Speech APIを使用した高精度な音声認識。
- **オーディオビジュアライザー**: マイク入力の音量やピッチに合わせて、背景の星空や流星が反応します。
- **AI評価**: Groq (Llama 3 70B) を使用し、プレゼンの構成や話し方を5段階で評価。
- **構造化要約 (Mirroring)**: 話した内容を「導入・本論・結論」に整理し、あなたの強み (Highlights) を抽出します。
- **Mute-Sync**: ブラウザのミュート設定と連動し、意図しない音声認識を防ぎます。
- **履歴機能**: 過去の練習結果をブラウザに保存し、成長を確認できます。

## セットアップ

### 必要条件
- Node.js (v18以降推奨)
- [Groq API Key](https://console.groq.com/) (無料で取得可能)

### インストール
```bash
git clone <repository-url>
cd presentation-evaluation
npm install
```

### 環境設定
プロジェクトルートに `.env` ファイルを作成し、GroqのAPIキーを設定してください。

```env
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxx
```

### 開発サーバーの起動
```bash
npm run dev
```
ブラウザで `http://localhost:5173` を開いてください。

## デプロイ (Vercel)

このプロジェクトは Vercel へのデプロイに最適化されています。

1. GitHub にリポジトリをプッシュします。
2. Vercel で新しいプロジェクトを作成し、リポジトリをインポートします。
3. **Environment Variables** 設定画面で `GROQ_API_KEY` を追加します。
4. Deploy をクリックすれば完了です。

## 技術スタック
- **Frontend**: SvelteKit, TypeScript, Web Audio API, Web Speech API, Canvas API
- **Backend**: SvelteKit Serverless Functions
- **AI**: Groq API (Llama 3.3 70B Versatile)
- **Styling**: CSS Variables (Dark Theme), Glassmorphism
