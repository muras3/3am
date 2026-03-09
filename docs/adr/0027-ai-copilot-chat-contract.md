# ADR 0027: AI Copilot Chat Contract

- **Status**: Accepted
- **Date**: 2026-03-09
- **Deciders**: murase

## Context

Phase E の AI Copilot チャット機能。Right Rail の静的 UI を、インシデントに紐づいたコンテキストを持つ対話型チャットに置き換える。
ローカル完結実装（外部 AI サービス以外の外部プラットフォームに依存しない）を前提とする。

## Decisions

### エンドポイント

```
POST /api/chat/:incidentId
Authorization: Bearer <RECEIVER_AUTH_TOKEN>
Content-Type: application/json
```

**Request schema:**
```json
{
  "message": "string (max 500 chars)",
  "history": [
    { "role": "user" | "assistant", "content": "string" }
  ]
}
```

**Response schema:**
```json
{ "reply": "string" }
```

### バリデーション

| 条件 | HTTP ステータス |
|------|----------------|
| auth なし | 401 |
| `message` なし / 空 | 400 |
| `message` > 500 chars | 400 |
| `history` が配列でない | 400 |
| history ターン数 > 10 | 422 |
| `incidentId` が存在しない | 404 |
| `diagnosisResult` 未セット | 404 (診断未完了) |

ターン数 = history 配列の要素数。`message` 送信後の会話 = 最大 10 往復まで（11 ターン目は 422 を返す）。

### システムプロンプト（情報漏洩対策）

raw packet JSON / raw evidence は **含めない**。サマリーのみ:

```
You are an incident responder assistant. The engineer is investigating an active incident.

Incident summary: {diagnosisResult.summary.what_happened}
Root cause: {diagnosisResult.summary.root_cause_hypothesis}
Recommended action: {diagnosisResult.recommendation.immediate_action}
Causal chain: {step1.title} → {step2.title} → ...

Answer concisely in 1-3 sentences. Do not speculate beyond the provided context.
```

### プロンプトインジェクション対策

ユーザーメッセージは `<user_message>` XML タグでサンドボックス化してから history に追加する。
history 内の既存ターンはすでにサンドボックス化済みとみなす（クライアント管理）。

### モデル設定

- モデル: `claude-haiku-4-5-20251001`（チャットは短答・低レイテンシ重視）
- `max_tokens`: 512
- `temperature`: 0.3（診断より少し温度を上げる — 対話的な応答のため）
- モデルは `CHAT_MODEL` 環境変数でオーバーライド可（テスト用）

### 認証

既存の `bearerAuth` middleware がすべての `/api/*` ルートをカバーするため、追加実装不要。

### history 管理

- クライアント（Console）が history を管理し、毎リクエストに全 history を送信する
- サーバーはステートレス（history をストレージに保存しない）
- 10 ターン超過チェックはサーバー側で行う（クライアントの実装ミスに対する防衛）

### クイックプロンプト（Ask About チップ）

チップクリックは「input に挿入のみ」ではなく **即送信** とする。
クリック→挿入→送信ボタン押下の 2 ステップより UX が優れるため。

### コスト制御

- `max_tokens: 512` で 1 返答の上限を制御
- 手動 smoke テストは合計 20 API コール到達時にユーザーへ報告

## Consequences

- Receiver に `@anthropic-ai/sdk` の直接依存が加わる（diagnosis パッケージとは独立した用途）
- CI テストは `vi.mock("@anthropic-ai/sdk")` でモック化し、実 API key は不要
- E2E テストは global-setup でモック HTTP サーバー（port 4320）を起動し、`ANTHROPIC_BASE_URL` を差し替える
