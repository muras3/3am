# ADR 0013: Cross-Platform Storage Driver

- Status: Accepted
- Date: 2026-03-07

## Context

Receiver は Vercel（Node.js runtime）と Cloudflare Workers（V8 isolate）の両方にデプロイできる必要がある。
Incident Console（Web UI）にインシデント履歴を表示するため、Receiver は Incident Packet を永続化しなければならない。

以下の制約がある：

- **ユーザーの DB 管理コストをゼロにする**：Deploy Button で一発デプロイ後、ユーザーが DB を意識しない
- **OSS セルフホスト**：3am がホストする共有 DB は持たない
- **クロスプラットフォーム**：CF Workers と Vercel で動く単一の抽象化が必要
- **無料または極めて安価**：インシデント数は1日数十件程度

gpt-5.4（Codex）への相談でも同じ結論に至った。

## Decision

**StorageDriver インターフェース + プラットフォームネイティブアダプター** を採用する。

```typescript
interface StorageDriver {
  createIncident(packet: IncidentPacket): Promise<void>;
  updateIncidentStatus(id: string, status: IncidentStatus): Promise<void>;
  appendDiagnosis(id: string, result: DiagnosisResult): Promise<void>;
  listIncidents(opts: { limit: number; cursor?: string }): Promise<IncidentPage>;
  getIncident(id: string): Promise<Incident | null>;
  deleteExpiredIncidents(before: Date): Promise<void>;
}
```

### 標準アダプター（2本）

| デプロイ先 | アダプター | ストレージ | ユーザー管理 |
|---|---|---|---|
| Cloudflare Workers | `CloudflareAdapter` | D1（SQLite） | ゼロ（CF が管理） |
| Vercel | `VercelAdapter` | Vercel Postgres（Neon） | ほぼゼロ（ダッシュボードで自動プロビジョニング） |

### 外部アダプター（オーバーライド用）

- `ExternalAdapter`（Turso / libSQL over HTTP）
- デフォルトではなく、上級者向けオーバーライドとして後で追加
- ローカル開発環境や複数プラットフォーム横断デプロイが必要なユーザー向け

## Rationale

- **外部 DB をデフォルトにしない**：「無料だからアカウント作って」はユーザーに小さく見えて大きな摩擦。Deploy Button のコンバージョンを下げる
- **プラットフォームネイティブが唯一の「デプロイしたら動く」を実現できる手段**：CF D1 も Vercel Postgres も、デプロイ時に自動プロビジョニング可能
- **抽象化のコストは小さい**：操作は6本程度。汎用 ORM は不要。薄い repository 層で十分
- **「ネイティブがデフォルト、外部はオーバーライド」がスモールチームにとって最適なバランス**

## Consequences

- `StorageDriver` インターフェースへの依存により、ストレージ実装をテストでモック化できる
- CF Workers / Vercel それぞれのデプロイメントで異なるアダプターを使用するため、E2E テストは環境ごとに必要
- Vercel Postgres は Hobby プランで無料（0.5GB）、D1 は Workers 無料枠で無料（5GB）
- 将来的に SQLite ベースのローカル開発アダプターを追加することで、ローカル動作確認が容易になる
