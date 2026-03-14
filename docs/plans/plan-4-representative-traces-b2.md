# Plan 4: Representative Traces Ranking (B-2)

## Context

`createPacket()` で `representativeTraces = spans.slice(0, 10)` を使っており、
OTLP batch の到着順先頭 10 件をそのまま返している。
異常度の高い trace・依存先 span・サービス間の spread が一切考慮されず、
LLM 入力としての代表性が低い。

具体的な問題:
- anomalous span が後方に到着すると選出されない
- `/checkout` 504 が incident の本体でも、route diversity cap だけで絞ると本体 trace が落ちる可能性
- upstream 1本 + downstream 20本の cascade で downstream ばかり入る
- dependency span（外部呼び出し）が入らず、外部起因障害の診断材料が欠ける

本 Plan は **B-2 のみ**を対象とし、2段階選定アルゴリズムを実装することで
「高異常度の核心 trace は必ず残る、その上で diversity をかける」設計にする。

---

## Series Context

```
Wave 1:  ✅ Plan 1 (A-1+B-3)
Wave 2:  Plan 2 (A-2)  |  Plan 3 (B-1)  |  ▶ Plan 4 (B-2)  ← 並列可
Wave 3:  Plan 5–8
```

> ⛔ **BLOCKED until Plan 1 is merged to `develop`.**
> Plan 1 後は `rebuildPacket()` 経由で representativeTraces が更新される。
> Plan 4 の integration test は `rebuildPacket()` 上に乗るため、Plan 1 が前提。

---

## Execution Model

1. `develop` から `feat/packet-remediation-b2` ブランチを切る
2. ADR 変更なし（アルゴリズム設計根拠は packetizer.ts のコメントに記録）
3. **Sonnet × 2** で並列実装（下記 Agent 構成）
4. `/simplify` 実行
5. PR → Opus レビュー → 修正（最大 3 ラウンド）
6. Observable Completion Criteria 検証

---

## Step 1: 選定アルゴリズム設計（packetizer.ts）

**定数（export — テストから参照可能にする）**:

```typescript
export const MAX_REPRESENTATIVE_TRACES = 10
export const TOP_ANOMALY_GUARANTEE = 3   // Phase 1: 無条件で入れるトップ anomaly 数
export const MAX_ROUTE_DIVERSITY = 3     // Phase 2: (serviceName, httpRoute) 単位の cap
```

**Scoring function**（各 span を整数スコアに変換）:

| 条件 | 加点 |
|------|------|
| HTTP 5xx | +3 |
| HTTP 429 | +3 |
| exceptionCount > 0 | +2 |
| spanStatusCode === 2 (error) | +2 |
| durationMs > 5000 | +1 |
| peerService あり（dependency span） | +1 |

**2段階選定アルゴリズム**:

```
Phase 1 — Top anomaly guarantee:
  scored = spans sorted by (score desc, traceId+spanId lex)
  guaranteed = scored の上位 TOP_ANOMALY_GUARANTEE 件（スコア > 0 のもの）
  → これらは route cap / service cap に関係なく必ず入る

Phase 2 — Diversity fill:
  routeCaps = Map<serviceName+httpRoute, count>  ← Phase 1 の件数も計上する
  serviceSet = guaranteed に含まれる serviceName の Set
  remaining = scored から guaranteed を除いた残り（スコア順）
  for span in remaining:
    if selected.length >= MAX_REPRESENTATIVE_TRACES: break
    if routeCaps[(span.serviceName, span.httpRoute)] >= MAX_ROUTE_DIVERSITY: skip
    prefer: serviceSet に含まれていない service を優先（service diversity）
    add span, routeCaps を更新

Dependency injection:
  if selected に peerService を持つ span が 0 件:
    depSpan = scored から peerService あり・未選出の最高スコア span を探す
    if not found: skip
    置換ルール（優先順）:
      1. Phase 2 picks の中で score = 0 かつ最後尾の span を置換対象にする
      2. score = 0 の Phase 2 pick がなければ、Phase 2 の最後尾（最低スコア）を置換
      3. Phase 2 picks が 0 件 かつ selected.length < MAX なら append
      4. それ以外（guaranteed のみ + MAX 到達）: inject スキップ
    ※ Phase 1 guaranteed spans は絶対に置換しない
```

**Tie-break**: 同スコア → `traceId + spanId` の辞書順（determinism 保証）

---

## Step 2: テスト（packetizer.test.ts）

### 2a. Top anomaly guarantee テスト

| ケース | 期待 |
|--------|------|
| 30 spans: `/checkout` 504 × 5 (score=5) + normal × 25 → top 3 の `/checkout` 504 が必ず入る | ✓ |
| score > 0 が 1 件しかない → その 1 件は必ず representativeTraces に含まれる | ✓ |
| TOP_ANOMALY_GUARANTEE 件は route cap に関係なく保護される | ✓ |

### 2b. Cascade service diversity テスト

| ケース | 期待 |
|--------|------|
| upstream-svc (1 span, HTTP 500) + downstream-svc (20 spans, HTTP 504) → upstream span が選出される | ✓ |
| service diversity: 異なる service の span が Phase 2 で優先される | ✓ |

### 2c. Dependency injection テスト

| ケース | 期待 |
|--------|------|
| 全 spans に peerService なし → injection スキップ（副作用なし） | ✓ |
| Phase 2 に score=0 の normal span あり → それが置換対象になる（Phase 1 は保護） | ✓ |
| Phase 2 picks が全て score > 0 → Phase 2 最後尾（最低スコア）が置換対象 | ✓ |
| Phase 2 picks が 0 件 かつ selected < MAX → dependency span を append | ✓ |
| Phase 2 picks が 0 件 かつ selected == MAX → inject スキップ（Phase 1 を壊さない） | ✓ |
| dependency span が Phase 1 で既に入っている → injection スキップ | ✓ |

### 2d. Route diversity テスト

| ケース | 期待 |
|--------|------|
| 同一 service-A / route `/api/pay` の 429 × 20 → MAX_ROUTE_DIVERSITY = 3 で cap される | ✓ |
| cap = 3 の残り枠は別 route / 別 service で埋まる | ✓ |
| Phase 1 guaranteed 3 件 + Phase 2 cap 残 0 → guaranteed は cap を超えても落ちない | ✓ |

### 2e. Determinism / order independence テスト

| ケース | 期待 |
|--------|------|
| 同一 span set を 2 回処理 → 完全一致 | ✓ |
| spans 入力順を shuffle → 同一 output | ✓ |
| 同スコア spans の tie-break が `traceId+spanId` lex で決まる | ✓ |

---

## Step 3: Product / Diagnosis gate

**目的**: 旧 `slice(0,10)` では落ちていた重要 trace が新 ranking で入ることを具体的に示す。

### 3a. 旧実装との比較テスト（packetizer.test.ts）

| ケース | 旧 slice(0,10) | 新 ranking | 期待 |
|--------|---------------|------------|------|
| normal × 10 + anomalous (HTTP 429) × 1 [index=10] | anomalous が落ちる（11番目） | Phase 1 guarantee で選出 | ✓ |
| normal × 15 + dependency span (peerService=stripe) × 1 [index=15] | dependency span が落ちる（確実） | injection により選出 | ✓ |

### 3b. Diagnosis prompt 確認（prompt.test.ts）

| ケース | 期待 |
|--------|------|
| representativeTraces に `peerService=stripe` の span が含まれる packet → `buildPrompt()` 出力に "stripe" が含まれる | ✓ |
| representativeTraces に HTTP 429 span がある packet → `buildPrompt()` 出力に "429" または "rate limit" が含まれる | ✓ |

### 3c. End-to-end diagnosis gate（stretch goal）

`packages/diagnosis/src/__tests__/diagnose.test.ts`（既存または新規）

dependency span が旧 slice では落ちていたシナリオで `diagnose()` まで通し、
外部依存の言及が reasoning に含まれることを確認する。

| ケース | 期待 |
|--------|------|
| dependency span なし packet（旧実装相当）→ `diagnose()` → reasoning に外部依存の言及なし | ✓（baseline） |
| dependency span あり packet（新 ranking 相当）→ `diagnose()` → reasoning に "stripe" / 外部依存の言及あり | ✓（改善確認） |

> このテストはモック LLM または recorded response で可。実 API 呼び出しは不要。

---

## Step 4: Rebuild integration test（Plan 1 依存パス）

**File:** `apps/receiver/src/__tests__/integration.test.ts`

| ケース | 期待 |
|--------|------|
| 初回 incident 作成（normal spans × 3） → representativeTraces は ranking ルールに従う | ✓ |
| 後続 spans attach（anomalous spans × 5） → `rebuildPacket()` 後の representativeTraces に anomalous spans が含まれる | ✓ |
| rebuild 後の representativeTraces が MAX_REPRESENTATIVE_TRACES 以下 | ✓ |
| rebuild を 2 回実行しても同一 representativeTraces（determinism） | ✓ |

---

## Sonnet エージェント構成

```
Agent A: Step 1 — 2段階アルゴリズム実装 + Step 2a/2b/2c/2d/2e テスト
Agent B: Step 3 — product/diagnosis gate + Step 4 — rebuild integration test
```

Agent B は Agent A の実装完了後に起動する（integration test が実装に依存するため）。

---

## 修正対象ファイル一覧

| ファイル | 変更種別 |
|---------|---------|
| `apps/receiver/src/domain/packetizer.ts` | 2段階選定アルゴリズム追加、`createPacket` 修正 |
| `apps/receiver/src/__tests__/domain/packetizer.test.ts` | テスト追加（~20件） |
| `apps/receiver/src/__tests__/integration.test.ts` | rebuild integration test 追加（~4件） |
| `packages/diagnosis/src/__tests__/prompt.test.ts` | diagnosis gate テスト追加（2件） |
| `packages/diagnosis/src/__tests__/diagnose.test.ts` | end-to-end gate（stretch goal, 2件） |

---

## リスク

| リスク | 重大度 | 対策 |
|--------|--------|------|
| TOP_ANOMALY_GUARANTEE = 3 が大きすぎて diversity fill 枠を圧迫する | Low | MAX=10 に対して 3 は 30%。OC-2 で balance を確認 |
| Dependency injection が Phase 2 の最低スコア span を置換する際に有用な normal trace を消す | Low | score=0 の normal span を優先置換対象にする（Step 1 置換ルール 1） |
| Phase 1 guaranteed が injection で壊れる（実装ミス） | Medium | injection は Phase 2 picks のみが対象。2c テストで明示的に検証 |
| rebuildPacket() の実装が Plan 1 時点で raw spans を保持しない場合 | Medium | Plan 1 の contract に `rawSpans` の蓄積が含まれることを事前確認 |
| 既存テスト（slice(0,10) を前提とした件数確認）の崩壊 | Low | 既存テストは単一 service 少数 spans が多い → ranking と同一結果になるはず |

---

## Observable Completion Criteria

### OC-1: Top anomaly guarantee
```
30 spans: service-A /checkout 504 (score=5) × 5 + normal × 25
→ representativeTraces に /checkout 504 が TOP_ANOMALY_GUARANTEE(=3) 件以上含まれる
→ top scorer が必ず index=0 に来る
```

### OC-2: Cascade service spread（重複抑制 + 核心 trace 保持）
```
upstream-svc: 1 span (HTTP 500, score=5)
downstream-svc: 20 spans (HTTP 504, score=5)
→ representativeTraces に upstream-svc span が含まれる（service diversity）
→ downstream-svc は MAX_ROUTE_DIVERSITY(=3) で cap される
→ 核心である upstream span は落ちていない
```

### OC-3: Dependency coverage（旧実装で確実に落ちるケース）
```
spans: service-A normal × 15 + service-A→stripe dependency span × 1 [index=15]
旧 slice(0,10): dependency span が落ちる（index=15 なので確実に選出されない）
新 ranking: dependency injection により必ず選出される
→ representativeTraces に peerService=stripe の span が含まれる
```

### OC-4: "旧 slice で落ちた anomalous trace が新 ranking で入る"（product gate）
```
spans: normal × 10 + anomalous (HTTP 429) × 1 [index=10]
旧 slice(0,10): anomalous span が落ちる（11番目）
新 ranking: anomalous span が Phase 1 guarantee で選出される
```

### OC-5: Determinism
```
同一 span set を 2 回処理 → representativeTraces が完全一致
spans 入力順を shuffle → 同一 output
```

### OC-6: Rebuild後 representativeTraces が ranking ルールを満たす
```
createIncident (normal × 3) → attach anomalous × 5 → rebuildPacket()
→ rebuilt representativeTraces の先頭が anomalous spans
→ 件数 <= MAX_REPRESENTATIVE_TRACES
→ 2回 rebuild → 同一結果
```

### OC-7: CI Green
```
pnpm test       → 全 green（既存 + 新規）
pnpm typecheck  → 全 green
pnpm build      → 成功
```

---

## Verification

```bash
# typecheck + test
pnpm typecheck
pnpm test

# packetizer 単体
pnpm --filter @3amoncall/receiver test -- packetizer

# integration（rebuild パス確認）
pnpm --filter @3amoncall/receiver test -- integration

# diagnosis prompt + end-to-end gate
pnpm --filter @3amoncall/diagnosis test -- prompt
pnpm --filter @3amoncall/diagnosis test -- diagnose
```
