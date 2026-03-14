# Plan 3: Deterministic primaryService (B-1)

## Context

`createPacket()` で `primaryService = spans[0].serviceName` としており、
OTLP batch の span 順序に完全に依存している。
`buildFormationKey()` も `anomalousSpans[0].serviceName` を使うため、
packet の `scope.primaryService` と formation key の `primaryService` が
span 順序次第でズレうるバグがある。

具体的な問題:
- edge span・downstream span・sibling span がたまたま先頭に来ると incident の顔が変わる
- span 順序が変わると同じ障害が別 incident として判定されうる
- UI の "What broke" や diagnosis の主語に出るサービス名が誤ったものになる

本 Plan は **B-1 のみ**を対象とし、`primaryService` の意味を
**「incident を最初に起こした anomalous service（triggering service）」**
として固定する。

---

## Series Context

```
Wave 1:  ✅ Plan 1 (A-1+B-3)
Wave 2:  Plan 2 (A-2)  |  ▶ Plan 3 (B-1)  |  Plan 4 (B-2)  ← 並列可
Wave 3:  Plan 5–8
```

> ⛔ **BLOCKED until Plan 1 is merged to `develop`.**
> `updatePacketWithSpans()` が Plan 1 で追加されるため、Plan 3 はその上に乗る。
> Plan 1 が未マージの状態でブランチを切ってはいけない。

Plan 2 との関係:
- `ingest.ts` の `anomalousSpans` time-sort は **Plan 2 に含まれる**（Plan 3 はタッチしない）
- これにより formation key の `primaryService` と packet の `primaryService` が一致する
- Plan 3 は `packetizer.ts` のみを対象とし、Plan 2 と真に並列実行可能

---

## Execution Model

1. `develop` から `feat/packet-remediation-b1` ブランチを切る
2. **ADR 0018 amendment ドラフト → ユーザー承認**（実装前に必ず得る）
3. **Sonnet 単体エージェント**で実装
4. `/simplify` 実行
5. PR → Opus レビュー → 修正（最大 3 ラウンド）
6. Observable Completion Criteria 検証

---

## Semantic Decision（一意に固定）

> **`primaryService` = incident を新規作成させた最初の anomalous signal の service**
>
> - incident 生成時（`createPacket()` 呼び出し時）に一度だけ確定する
> - `updatePacketWithSpans()` では **絶対に再計算しない**（不変）
> - 後続 spans がより多くの anomalous signal を持っていても変わらない
> - 定義: `anomalousSpans` を `startTimeMs asc → serviceName asc` で sort した先頭 service
>
> **既知の tradeoff**: 不変にすることで、後続 signal によって incident の主役サービスが変わる場合でも
> `primaryService` は追従しない。UI の "What broke" や diagnosis の主語は常に triggering service を指す。
> これは「初報の起点を固定する」という設計上の意図的選択であり、ADR 0018 amendment に明記する。

この決定は ADR 0018 amendment で明文化する（Step 0）。

---

## Step 0: ADR 0018 amendment（ユーザー承認 gate）

**File:** `docs/adr/0018-incident-packet-semantic-sections.md` に追記

記録する意思決定:
1. `primaryService` の canonical 定義を明文化する
   - **定義**: "the service that first exhibited anomalous behavior when the incident was created"
   - **不変**: `createPacket()` 時に一度だけ確定し、以降の `updatePacketWithSpans()` では変更しない
2. `selectPrimaryService()` のアルゴリズムを明記
   - anomalous spans を `startTimeMs asc → serviceName asc` でソート
   - 先頭の serviceName を採用
   - anomalous spans がない場合（有り得ないが）は `spans[0].serviceName` にフォールバック
3. この定義が UI / diagnosis / formation key にも一貫して使われることを明記

---

## Step 1: `selectPrimaryService()` を packetizer に追加

**File:** `apps/receiver/src/domain/packetizer.ts`

### 新関数

```typescript
/**
 * Select the primaryService for a new incident.
 * Definition: the service that first exhibited anomalous behavior.
 * Sort by startTimeMs asc → serviceName asc for full determinism.
 * IMMUTABLE: call only at createPacket() time, never in updatePacketWithSpans().
 */
export function selectPrimaryService(spans: ExtractedSpan[]): string {
  const anomalous = [...spans.filter(isAnomalous)].sort((a, b) =>
    a.startTimeMs !== b.startTimeMs
      ? a.startTimeMs - b.startTimeMs
      : a.serviceName.localeCompare(b.serviceName),
  )
  return anomalous[0]?.serviceName ?? spans[0]?.serviceName ?? 'unknown'
}
```

### `createPacket()` 変更

```
primaryService: spans[0]?.serviceName  →  selectPrimaryService(spans)
```

### `updatePacketWithSpans()` — **変更しない**

```typescript
// primaryService は変更しない（triggering service は不変）
// コメントで明示する:
// NOTE: primaryService is immutable after incident creation (ADR 0018 amendment).
// Even if new spans show more anomalies from a different service, primaryService stays.
```

---

## Step 2: テスト

**File:** `apps/receiver/src/__tests__/domain/packetizer.test.ts`

### 2a. Order independence テスト

| ケース | 期待 |
|--------|------|
| `[normal-B(t=100), anomalous-A(t=50), normal-C(t=200)]` → primaryService = "A" | ✓ |
| `[anomalous-A(t=50), normal-B(t=100), normal-C(t=200)]` → primaryService = "A" | ✓ |
| `[normal-C(t=200), normal-B(t=100), anomalous-A(t=50)]` → primaryService = "A" | ✓ |

### 2b. Time-based 選定テスト

| ケース | 期待 |
|--------|------|
| service-A(t=100, 5xx) + service-B(t=200, 5xx) → "A" | ✓ |
| service-B(t=100, 5xx) + service-A(t=200, 5xx) → "B" | ✓ |
| 同時刻 anomaly: service-B + service-A → "A" (alphabetical tiebreak) | ✓ |

### 2c. Negative test

| ケース | 期待 |
|--------|------|
| downstream span が先頭でも upstream が primaryService になる | ✓ |
| non-anomalous 先頭 span は無視される | ✓ |
| anomalous spans なし → spans[0].serviceName (fallback) | ✓ |

**File:** `apps/receiver/src/__tests__/integration.test.ts`

### 2d. `updatePacketWithSpans()` 不変性テスト（Plan 1 依存パス）

| ケース | 期待 |
|--------|------|
| service-A の anomalous spans で incident 作成 → `primaryService = "A"` | ✓ |
| 後続 batch で service-B の anomalous spans が多数 attach → `primaryService` は "A" のまま | ✓ |
| 後続 batch で service-B の方が earlier timestamp でも → `primaryService` は "A" のまま（初回確定） | ✓ |

### 2e. Formation key 一致テスト（**joint test — Plan 2 マージ後に追加**）

> Plan 2 の `buildFormationKey(spans[])` + `ingest.ts` time-sort が揃って初めて検証可能。
> Plan 3 単体の PR では skip し、Plan 2 マージ後の joint integration PR で追加する。

| ケース | 期待 |
|--------|------|
| `selectPrimaryService(spans)` === `buildFormationKey(anomalousSpans).primaryService` | ✓ |
| span 順序変更後も両者の一致が保たれる | ✓ |

---

## Step 3: Diagnosis / product gate

**目的**: `primaryService` が UI headline と diagnosis に正しく反映されることを確認。

### 3a. View model unit test（**必須**）

`apps/console/src/__tests__/adapters.test.ts`（Phase D / Lane A で作成済みまたは作成予定）

| ケース | 期待 |
|--------|------|
| `packet.scope.primaryService = "api-service"` → `IncidentWorkspaceVM.headline` に "api-service" が含まれる | ✓ |

> Lane A 未実装の場合は `buildPrompt()` 出力への反映（3b）を代わりに必須とする。どちらか一方は必ず通すこと。

### 3b. Diagnosis prompt 確認

`packages/diagnosis/src/__tests__/prompt.test.ts`（既存または新規）

| ケース | 期待 |
|--------|------|
| `packet.scope.primaryService = "api-service"` → `buildPrompt(packet, ...)` の出力に "api-service" が含まれる | ✓ |

---

## Sonnet エージェント構成

単一タスク・単一ファイルが主なので **Sonnet 1 体**で十分。

```
Agent: implementation
  Step 0: ADR 0018 amendment ドラフト（ユーザー承認待ち）
  Step 1: selectPrimaryService() + createPacket 修正 + updatePacketWithSpans コメント
  Step 2: packetizer.test.ts (~10件) + integration.test.ts (2e: ~3件)
  Step 3: adapters.test.ts + prompt.test.ts 確認/追加（各 1件）
```

Step 0（ADR）のみユーザー承認後に Step 1 以降を実行する。

---

## 修正対象ファイル一覧

| ファイル | 変更種別 |
|---------|---------|
| `docs/adr/0018-incident-packet-semantic-sections.md` | amendment 追記（ユーザー承認必須） |
| `apps/receiver/src/domain/packetizer.ts` | `selectPrimaryService()` 追加、`createPacket` 修正 |
| `apps/receiver/src/__tests__/domain/packetizer.test.ts` | テスト追加（~10件） |
| `apps/receiver/src/__tests__/integration.test.ts` | 不変性テスト追加（~3件） |
| `apps/console/src/__tests__/adapters.test.ts` | headline 反映テスト追加（1件） |
| `packages/diagnosis/src/__tests__/prompt.test.ts` | primaryService prompt 反映テスト（1件） |

---

## リスク

| リスク | 重大度 | 対策 |
|--------|--------|------|
| `updatePacketWithSpans()` で primaryService を再計算するよう Plan 1 が実装されていた場合 | Medium | Plan 3 の Step 1 で明示的にコメントを追加し、再計算を削除して不変にする |
| time-sort による sort の副作用（`spans` 変数への影響） | Low | spread copy (`[...spans.filter(...)]`) してから sort する |
| count-based を期待する既存テストが壊れる | Low | 既存テストは単一サービスが多い → 影響軽微 |
| view model / prompt test のファイルが未存在 | Low | ファイルがない場合は新規作成。Lane A 未実装なら prompt test だけで代替 |

---

## Observable Completion Criteria

### Plan 3 単体完了条件

#### OC-1: Order independence
```
spans = [normal-B(t=100), anomalous-A(t=50), normal-C(t=200)]
→ packet.scope.primaryService === "service-A"

spans_shuffled = [anomalous-A(t=50), normal-C(t=200), normal-B(t=100)]
→ packet.scope.primaryService === "service-A" (同一)
```

#### OC-2: Time-based 選定
```
spans = [service-B anomalous(t=100), service-A anomalous(t=200)]
→ packet.scope.primaryService === "service-B" (B が先に壊れた)
```

#### OC-3: updatePacketWithSpans 不変性
```
createIncident (service-A anomalous) → primaryService = "A"
updatePacketWithSpans (service-B anomalous, 多数) → primaryService は "A" のまま
```

#### OC-4: Product / Diagnosis gate（どちらか一方は必須）
```
packet.scope.primaryService = "api-service"
→ IncidentWorkspaceVM.headline に "api-service" が含まれる  ← 優先
  または
→ buildPrompt(packet) に "api-service" が含まれる           ← Lane A 未実装時の代替
```

#### OC-5: CI Green
```
pnpm test       → 全 green（既存 + 新規）
pnpm typecheck  → 全 green
pnpm build      → 成功
```

---

### Joint 完了条件（Plan 2 マージ後に検証）

#### JOC-1: Formation key 一致
```
buildFormationKey(anomalousSpans).primaryService === packet.scope.primaryService
(spans 順序を変えても一致が保たれる)
```

> Plan 2 の `ingest.ts` time-sort が揃って初めて成立する条件。
> Plan 3 の PR マージ時点では pending とし、Plan 2 マージ後の joint integration PR で green にする。

---

## Verification

```bash
# typecheck + test
pnpm typecheck
pnpm test

# packetizer 単体
pnpm --filter @3amoncall/receiver test -- packetizer

# integration（Plan 1 更新パス確認）
pnpm --filter @3amoncall/receiver test -- integration

# diagnosis prompt
pnpm --filter @3amoncall/diagnosis test -- prompt
```
