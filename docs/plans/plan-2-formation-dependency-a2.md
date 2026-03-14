# Plan 2: Formation Key with Dependency (A-2)

## Context

`formation.ts` の `buildFormationKey()` / `shouldAttachToIncident()` は
`environment + primaryService + 5min window` のみで incident を grouping している。
`IncidentFormationKey` スキーマに `dependency?` は定義済みだが、値が埋まらない。
`ExtractedSpan.peerService` は OTel `peer.service` を正しく抽出しているが formation で未使用。

ADR 0017 が基本キーとして明示した `dependency` が実装されていないため:

- **過剰 merge**: 同サービス・別 dependency の障害が同一 incident に混ざる
  例: `api-service → Stripe 429` と `api-service → Redis timeout` が 1 incident → diagnosis 混乱
- **不要 split**: 同 dependency・複数サービスへの障害が別 incident になる
  例: `api-service → Stripe 429` と `checkout-service → Stripe 429` が別々になる

本 Plan は **A-2 のみ** を対象とし、formation.ts / ingest.ts の最小限の変更で解消する。
ただし「merge しすぎる危険」と「それを止める gate/test」を設計の中心に置く。

---

## Series Context

```
Wave 1:  ✅ Plan 1 (A-1+B-3)
Wave 2:  ▶ Plan 2 (A-2)  |  Plan 3 (B-1)  |  Plan 4 (B-2)  ← 並列可
Wave 3:  Plan 5–8
```

> ✅ **Plan 1 は `develop` にマージ済み（PR #62）。**
> Plan 2 は `develop` から `feat/packet-remediation-a2` ブランチを切って開始できる。
> ただし OC-8 Diagnosis gate は Plan 1 + Plan 2 の合算検証となる（Plan 1 単体の validation は未実施）。

---

## Execution Model

1. `develop` から `feat/packet-remediation-a2` ブランチを切る
2. **ADR 0017 更新ドラフト → ユーザー承認**（実装前に必ず得る）
3. **TeamCreate** (Sonnet × 3) で並列実装（下記 Agent 構成）
4. `/simplify` 実行
5. PR → Opus レビュー → 修正（最大 3 ラウンド）
6. Observable Completion Criteria 検証

---

## Step 0: ADR 0017 更新（ユーザー承認 gate）

**File:** `docs/adr/0017-incident-formation-rules-v1.md`

記録する意思決定（以下 7 点を網羅する）:

1. **`peer.service` を formation 基本キーの `dependency` として使用する**
2. **dependency は split-first で使う**（同サービス・別 dependency → 必ず split）
3. **cross-service dependency merge は保守的ガードで制限する**
   `MAX_CROSS_SERVICE_MERGE = 3`。same dependency でも affectedServices が 3 件を超えたら新規 incident。
   **根拠**: 検証対象シナリオ `third_party_api_rate_limit_cascade` では Stripe を呼ぶサービスが 2 件。
   MAX=3 はこれを 1 incident に収めつつ、第 4 サービスを pull-in しない保守値。
   実運用データで調整余地あり。ADR に値の暫定性を明記する。
4. **peerService の normalization ルール**（以下は `undefined` 扱い = 依存情報なし）
   - 空文字 `""` / 未定義
   - loopback: `"localhost"`, `"127.0.0.1"`, `"::1"`
   - 生 IP アドレス（`/^\d+\.\d+\.\d+\.\d+$/` パターン）: IaaS 内部エンドポイントは `peer.service` に向かない
   - 将来拡張用に `IGNORED_DEPENDENCY_NAMES` の denylist として実装する（初期は loopback + IP のみ）
5. **batch 内に複数の distinct dependency がある場合は `dependency = undefined`**（fallback へ）
   anomalous spans の peerService が 1 種類に確定しないなら dependency 情報は使わない
6. **`dependency` がない場合のフォールバック**: 従来の `environment + primaryService + 5min`
7. **単一巨大 dependency（Stripe / DB / Redis）による mega-incident の防止**
   `MAX_CROSS_SERVICE_MERGE` がその guard として機能することを明記

---

## Step 1: `buildFormationKey()` の変更

**File:** `apps/receiver/src/domain/formation.ts`

### 現状の問題（point 2 対応）
`buildFormationKey(span: ExtractedSpan)` で先頭 span の peerService だけ使う → order-sensitive。
1 バッチに複数 dependency があると意図しない dependency が key になる。

### 変更後のシグネチャ

```typescript
/**
 * Build a formation key from the full set of anomalous spans in a batch.
 * dependency is derived only when ALL anomalous spans agree on the same peer.service.
 * Multiple distinct peer.service values → dependency = undefined (safe default).
 */
export function buildFormationKey(spans: ExtractedSpan[]): IncidentFormationKey {
  const firstSpan = spans[0]
  const rawDeps = new Set(spans.map(s => s.peerService).filter(Boolean) as string[])
  const rawDep = rawDeps.size === 1 ? [...rawDeps][0] : undefined
  const dependency = normalizeDependency(rawDep)

  return {
    environment: firstSpan.environment,
    primaryService: firstSpan.serviceName,
    dependency,
    timeWindow: {
      start: new Date(firstSpan.startTimeMs).toISOString(),
      end: new Date(firstSpan.startTimeMs + FORMATION_WINDOW_MS).toISOString(),
    },
  }
}

/** Returns undefined for generic / low-quality peer.service values. */
function normalizeDependency(raw: string | undefined): string | undefined {
  if (!raw || raw.trim() === '') return undefined
  if (IGNORED_DEPENDENCY_NAMES.has(raw.toLowerCase())) return undefined
  return raw
}

const IGNORED_DEPENDENCY_NAMES = new Set([
  'localhost', '127.0.0.1', '::1', '0.0.0.0',
])

const IP_ADDRESS_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/

// normalizeDependency 内でパターンチェックを追加:
// if (IP_ADDRESS_PATTERN.test(raw)) return undefined
```

注: `buildFormationKey` のシグネチャが `(span) → (spans[])` に変わるため、
ingest.ts の呼び出し側も変更が必要（Step 3 で対応）。

---

## Step 2: `shouldAttachToIncident()` の変更

**File:** `apps/receiver/src/domain/formation.ts`

### 判定ロジック（point 1 対応）

cross-service dependency merge は `affectedServices.length < MAX_CROSS_SERVICE_MERGE` に制限。
same service + same dependency は merge。different dependency は常に split。

```typescript
export const MAX_CROSS_SERVICE_MERGE = 3

export function shouldAttachToIncident(
  key: IncidentFormationKey,
  incident: Incident,
  signalTimeMs: number,
): boolean {
  if (incident.status !== 'open') return false

  const scope = incident.packet.scope
  if (scope.environment !== key.environment) return false

  const openedAtMs = new Date(incident.openedAt).getTime()
  if (signalTimeMs - openedAtMs > FORMATION_WINDOW_MS) return false

  if (key.dependency !== undefined) {
    // dependency defined: split-first
    if (!scope.affectedDependencies.includes(key.dependency)) {
      return false  // different dependency → always split
    }
    // same dependency found in incident scope
    const sameService =
      scope.primaryService === key.primaryService ||
      scope.affectedServices.includes(key.primaryService)
    if (sameService) return true
    // cross-service + same dependency: only merge within guard
    return scope.affectedServices.length < MAX_CROSS_SERVICE_MERGE
  }

  // no dependency info → classic service matching
  return scope.primaryService === key.primaryService
}
```

"NOTE: dependency matching deferred to Phase C" コメントを削除する。

---

## Step 3: Ingest 変更

**File:** `apps/receiver/src/transport/ingest.ts`

`buildFormationKey(firstSpan)` → `buildFormationKey(anomalousSpans)` に変更。
同時に `anomalousSpans` を time-sort する（Plan 3 の `selectPrimaryService()` との一致を保証）。

```typescript
// Before:
const firstSpan = anomalousSpans[0];
const formationKey = buildFormationKey(firstSpan);
const signalTimeMs = firstSpan.startTimeMs;

// After:
const anomalousSpans = spans
  .filter(isAnomalous)
  .sort((a, b) =>
    a.startTimeMs !== b.startTimeMs
      ? a.startTimeMs - b.startTimeMs
      : a.serviceName.localeCompare(b.serviceName),
  )
const formationKey = buildFormationKey(anomalousSpans);
const signalTimeMs = anomalousSpans[0].startTimeMs;
```

> この time-sort は Plan 3 (B-1) の `selectPrimaryService()` と同一アルゴリズムを使う。
> これにより formation key の `primaryService` と packet の `primaryService` が常に一致する。

---

## Step 4: テスト（point 5 / 6 / 7 対応）

### 4a. `formation.test.ts` — 追加テスト（~18 件）

**Happy path（正常系）**:

| ケース | 期待 |
|--------|------|
| buildFormationKey: 全スパンが同一 peerService → dependency に入る | ✓ |
| buildFormationKey: 複数 distinct peerService → dependency = undefined | ✓ |
| buildFormationKey: peerService なし → dependency = undefined | ✓ |
| split: same service, different dependency → shouldAttach false | ✓ |
| merge: same service, same dependency → shouldAttach true | ✓ |
| merge: different service, same dependency, small incident → shouldAttach true | ✓ |
| fallback: no peerService → classic primaryService matching | ✓ |

**Negative test — false merge を止める（point 5 / 6 対応）**:

| ケース | 期待 |
|--------|------|
| cross-service + same dep, affectedServices.length === MAX-1 (=2) → true（境界: merge） | ✓ |
| cross-service + same dep, affectedServices.length === MAX (=3) → false（境界: split） | ✓ |
| cross-service + same dep, affectedServices.length > MAX → false | ✓ |
| same dep だが env が異なる → false | ✓ |
| same dep だが 5min window 外 → false | ✓ |
| different dep + closed incident → false | ✓ |
| Stripe incident に Redis 障害が来ても merge されない（different dep split） | ✓ |
| same service + different dep → false（split-first 確認） | ✓ |

**Instrumentation quality (point 7 対応)**:

| ケース | 期待 |
|--------|------|
| peerService = "" → normalizeDependency returns undefined | ✓ |
| peerService = "localhost" → normalizeDependency returns undefined | ✓ |
| peerService = "127.0.0.1" → normalizeDependency returns undefined | ✓ |
| peerService = "192.168.1.100" → normalizeDependency returns undefined（IP アドレス） | ✓ |
| peerService = "10.0.0.1" → normalizeDependency returns undefined（内部 IP） | ✓ |
| localhost で grouping されないこと（fallback に降りる） | ✓ |
| IP アドレス peer.service で grouping されないこと（fallback に降りる） | ✓ |

### 4b. `integration.test.ts` — Observable Completion Criteria の E2E

OC-1 (split): separate requests → `GET /api/incidents` で 2 件
OC-2 (merge): separate requests → 1 件
OC-3 (fallback): peerService なし → 従来通り 1 件
OC-5 (shared dep regression): 4 services → same dep → MAX_CROSS_SERVICE_MERGE で 2 incident
OC-6 (batch multi-dep): 1 batch に Stripe+Redis → dependency=undefined → service matching

---

## Step 5: Diagnosis gate（point 3 対応）

Plan 1 + Plan 2 の変更後、5 シナリオ validation を re-run する。
本 Step は **実装完了後、PR 作成前に必ず実施**する。

確認項目（明文化）:

| 確認項目 | 期待値 |
|---------|--------|
| `third_party_api_rate_limit_cascade` の incident count | 1 件（Stripe cascade が 1 incident に収まる） |
| 同シナリオの `affectedDependencies` | `["stripe"]` を含む |
| 同シナリオの `affectedServices` | Stripe 呼び出し元サービスが全て含まれている |
| diagnosis avg score（5 シナリオ） | >= 7.4/8（Plan 1 前ベースライン、回帰なし） |
| `third_party_api_rate_limit_cascade` score | 8/8 維持 |

---

## Sonnet 並列化（TeamCreate）

```
Agent A: Step 0 — ADR 0017 更新ドラフト作成（ユーザー承認まで待機）
Agent B: Step 1 + Step 2 — formation.ts 変更 + formation.test.ts (~18件)
Agent C: Step 3 + Step 4b — ingest.ts 変更 + integration.test.ts (OC-1〜6)
```

Agent A は ADR ドラフトを作成してユーザー承認を待つ。
Agent B・C は **ADR 承認後** に並列起動する。

---

## 修正対象ファイル一覧

| ファイル | 変更種別 |
|---------|---------|
| `docs/adr/0017-incident-formation-rules-v1.md` | 更新（ユーザー承認必須） |
| `apps/receiver/src/domain/formation.ts` | ロジック変更（メイン） |
| `apps/receiver/src/transport/ingest.ts` | 呼び出しシグネチャ変更 + `anomalousSpans` time-sort 追加 |
| `apps/receiver/src/__tests__/domain/formation.test.ts` | テスト追加（~18件） |
| `apps/receiver/src/__tests__/integration.test.ts` | OC-1〜6 追加 |

---

## リスク

| リスク | 重大度 | 対策 |
|--------|--------|------|
| MAX_CROSS_SERVICE_MERGE = 3 が小さすぎて合法的な cascade を split してしまう | Medium | OC-5 境界値 3ケースで確認。ADR に暫定値であることを明記。値は実データで再調整 |
| cross-service merge そのものが過剰 merge を招く（共有 DB/キャッシュ障害時） | Medium | split-first 原則を ADR に明記。MAX=3 で制限。OC-5 で観測 |
| 1 バッチ内の multi-dependency スパンが dependency=undefined にフォールバック → triggerSignals が貧弱になる | Medium | ADR に既知制限として明記。diagnosis gate で packet composition を見て劣化を検出 |
| IGNORED_DEPENDENCY_NAMES が不完全（IaaS 内部 IP、k8s Service FQDN 等） | Low | 初期 denylist は loopback + IP アドレスパターン。実運用データで拡張 |
| 既存テストへの影響（buildFormationKey のシグネチャ変更 × 6箇所） | Medium | 既存 test の呼び出しを `buildFormationKey([BASE_SPAN])` に修正する |
| Diagnosis 品質低下（grouping 変更により packet 内容が変わる） | Medium | OC-8 で packet composition + per-scenario score の両方を確認 |

---

## Observable Completion Criteria

### OC-1: Split 観測
```
POST /v1/traces (service-A → peer.service=stripe, HTTP 429)
POST /v1/traces (service-A → peer.service=twilio, HTTP 500)
GET /api/incidents → 2件（別 incidentId）
```

### OC-2: Merge 観測（cross-service, same dep, small incident）+ packet composition 検証
```
POST /v1/traces (service-A → peer.service=stripe, HTTP 429)
POST /v1/traces (service-B → peer.service=stripe, HTTP 429)
GET /api/incidents → 1件（同一 incidentId）  [affectedServices が MAX 未満のため merge]
GET /api/packets/:packetId → packet composition を確認:
  scope.affectedDependencies  ⊇ ["stripe"]
  scope.affectedServices      ⊇ ["service-A", "service-B"]
  triggerSignals              ⊇ [{signal: "http_429", entity: "service-A"},
                                  {signal: "http_429", entity: "service-B"}]
```

### OC-3: Fallback 観測
```
POST /v1/traces (service-A, peerService なし, HTTP 500)
POST /v1/traces (service-A, peerService なし, HTTP 502)
GET /api/incidents → 1件（従来の service matching）
```

### OC-4: CI Green
```
pnpm test       → 全 green（既存 + 新規）
pnpm typecheck  → 全 green
pnpm build      → 成功
```

### OC-5: Shared Dependency Regression（Stripe 過剰 merge 防止）+ 境界値 3ケース
```
# ケース a: MAX-1 まで → 1 incident（merge 許容）
POST /v1/traces (service-A → stripe, 429)
POST /v1/traces (service-B → stripe, 429)   ← affectedServices.length = 2 = MAX-1
GET /api/incidents → 1件

# ケース b: MAX 到達 → split（境界）
POST /v1/traces (service-A → stripe, 429)
POST /v1/traces (service-B → stripe, 429)
POST /v1/traces (service-C → stripe, 429)   ← affectedServices.length = 3 = MAX → split
GET /api/incidents → 2件

# ケース c: MAX+1 → split 継続
POST /v1/traces (service-D → stripe, 429)   ← さらに追加
GET /api/incidents → 2件以上（D は新規 incident）
```

### OC-6: Batch Multi-Dependency Safe Default
```
POST /v1/traces (1 batch: service-A→stripe 429 + service-A→redis timeout)
GET /api/incidents → 1件（dependency=undefined → service matching にフォールバック）
```

### OC-7: Instrumentation Quality Degrade
```
POST /v1/traces (service-A → peer.service="localhost", HTTP 500)
POST /v1/traces (service-A → peer.service="localhost", HTTP 502)
GET /api/incidents → 1件（localhost は無視、service matching）
```

### OC-8: Diagnosis Gate
```
validation シナリオ 5件（特に third_party_api_rate_limit_cascade）を Receiver + LLM に流す

【Packet composition チェック（third_party_api_rate_limit_cascade）】
  incident count              : 1（Stripe cascade が 1 incident に収まること）
  scope.affectedDependencies  : peer.service として記録された Stripe 識別子を含む
  scope.affectedServices      : Stripe を呼んだ全サービスが含まれること
  triggerSignals              : http_429 シグナルが含まれること
  evidence.representativeTraces: 複数サービスのスパンが含まれること

【Diagnosis score チェック】
  avg score（5 シナリオ）          : >= 7.4/8（Plan 1 ベースライン維持）
  third_party_api_rate_limit_cascade: 8/8 維持
  個別スコア回帰なし               : Plan 1 ベースラインから各シナリオ 1 点超の低下があれば要調査
```

---

## Verification

```bash
# typecheck + test
pnpm typecheck
pnpm test

# formation 単体
pnpm --filter @3amoncall/receiver test -- formation

# integration
pnpm --filter @3amoncall/receiver test -- integration

# Diagnosis gate (Step 5)
cd validation
docker compose up -d
docker compose exec scenario-runner node run.js third_party_api_rate_limit_cascade
# → Step 5 の確認項目テーブルに基づいて検証
```
