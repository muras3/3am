# Console Implementation — Shared Assumptions

receiver / diagnosis / frontend を並行開発する前に、全員が共有すべき前提を固定する。

前提ドキュメント:
- `docs/mock/lens-prototype-v1.html`
- `docs/design/console-data-requirements.md`
- `docs/design/console-implementation-planning-input.md`
- `docs/product-concept-v0.2.md`

## Source of Truth

- validated mock (`docs/mock/lens-prototype-v1.html`) が UI の source of truth
- `docs/design/console-data-requirements.md` がデータ契約の source of truth
- mock の再議論・再設計はしない。実装に入る

## ナビゲーションモデル

- Lens (zoom) モデル: Map → Incident → Evidence の 3 レベル
- 旧 3-column layout は廃止。zoom in/out のトランジションで画面遷移する
- 各レベルは独立した全画面 section。CSS scale + opacity + blur で zoom 表現

## API 前提

- new console の UI-facing contract は curated API のみ:
  - `GET /api/runtime-map`
  - `GET /api/incidents/:id` (拡張)
  - `GET /api/incidents/:id/evidence`
- 既存 raw API (`/api/services`, `/api/activity`, `/api/incidents/:id/telemetry/*`, `/api/chat/:id`) は debug / support / migration 専用。new console の frontend コードから直接消費しない
- curated API の response shape は console-data-requirements.md §2 にスケッチ済み。ただし §3 に列挙された以下の sub-contract は未確定であり、各 plan で個別に固定する:
  - §3.1 expected behavior contract (baseline source, window, fallback)
  - §3.2 runtime map derivation contract (node id, tier classification, edge dedup, ordering)
  - §3.3 blast radius contract (target unit, impact metric, aggregation)
  - §3.4 proof card reference contract (card id, target surface, ref type)
  - §3.5 Q&A contract (turn model, evidence refs, confidence, unanswerable handling)
  - §3.6 absence evidence contract (pattern set, threshold, ownership)
  - §3.7 empty/degraded state contract (pending, sparse, insufficient baseline)
  - §3.8 old/new API coexistence contract (migration boundary)

## IncidentPacket

- IncidentPacket は raw fact contract のまま維持する
- UI 表示用フィールド（headline, action wording 等）を追加しない
- UI が必要とする構造化データは receiver の curated layer と diagnosis の narrative layer が別途生成する

## Layer 責務

### Receiver

deterministic reasoning structure を作る:
- runtime map (node/edge 導出、3-tier: entry_point / runtime_unit / dependency)
- blast radius 算出
- expected vs observed 比較データ (baseline window + incident window)
- evidence counts / timestamps
- proof reference 構造
- absence evidence 候補

これらは LLM を使わない。観測データからの決定論的導出のみ。

### Diagnosis

2-stage prompting:
- Stage 1: incident packet → root cause / immediate action / causal chain / confidence (既存 v5 prompt 基盤)
- Stage 2: receiver の deterministic structure + Stage 1 結果 → proof card summaries / confidence rationale / risk wording / Q&A answers / follow-up questions (新規)

### Frontend

推論しない。描画と interaction に集中する:
- map inference, expected-vs-observed 比較ロジック, claim clustering, absence evidence 検出, blast radius 算出はフロントエンドに置かない
- curated API が返す構造をそのまま描画する

## Evidence Studio

- Q&A と evidence linking が必須。generic chat ではない
- question → grounded answer → supporting evidence の 3 点が常に接続される
- **answer 自身が evidence refs を持つ** — answer テキストから下の surface へ落ちる構造。proof card の接続に加えて、answer → proof/surface ref の契約も必要
- expected vs observed の差分が proof browser の中心
- proof card は evidence ref を持ち、traces / metrics / logs surface と deterministic にリンクする
- traces / metrics / logs の各 surface は stable id または group id を持つ。frontend が id なしで接続を推論してはならない
- tabs: Traces / Metrics / Logs の 3 タブ。Platform は primary surface にしない
- absence evidence (「該当ログがない」こと自体が証拠) を構造的に表現する

## Evidence スコープ

- OTel traces / OTel logs / OTel metrics のみ
- platform logs は primary evidence surface にしない
- generic observability dashboard は作らない

## 並行開発

backend (receiver + diagnosis) と frontend は別ブランチで並行開発する。

### Tier 1: 並行開発開始の前提 (receiver plan で確定する)

1. curated API の top-level response shape が freeze されていること (§2 レベル)
2. §3.2 runtime map derivation: node id scheme と tier classification rule が確定していること
3. §3.3 blast radius: target unit (service / route / mixed) と impact metric が確定していること
4. §3.7 empty/degraded state: diagnosis pending, sparse evidence, no baseline の各 state enum が確定していること

### Tier 2: Evidence Studio 並行開発の前提 (diagnosis plan で確定する)

5. §3.1 expected behavior: baseline source と window rule が確定していること
6. §3.4 proof card reference: card id scheme と target surface scheme が確定していること
7. §3.5 Q&A: answer の evidence refs 構造と unanswerable handling が確定していること
8. §3.6 absence evidence: pattern set と ownership (receiver vs diagnosis) が確定していること

### 共通条件

- frontend は fixture (freeze 済み shape に準拠した static JSON) で開発する
- frontend が存在しない backend behavior を自前で発明しない
- backend が old raw-only UI の前提で最適化しない

## Non-goals

- mock の再設計
- UX コンセプトの再議論
- generic observability dashboard
- chat panel の復活
- このドキュメントで実装タスク分解を行うこと
