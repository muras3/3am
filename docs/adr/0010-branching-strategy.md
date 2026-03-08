# ADR 0010: Branching Strategy

- Status: Accepted
- Date: 2026-03-07

## Context

Phase 1 以降、複数のフィーチャーを並行開発する。main を誤って汚染しないよう、開発フローを明文化する必要がある。

## Decision

### ブランチ構成

| ブランチ | 役割 |
|---------|------|
| `main` | リリース専用。直接コミット禁止。`develop` からのマージのみ許可 |
| `develop` | 開発統合ブランチ。全フィーチャーブランチのマージ先 |
| `feat/*`, `fix/*`, `docs/*` 等 | 作業ブランチ。`develop` base で作成し `develop` へ PR |

### フロー

```
feat/xxx ──PR──> develop ──PR(リリース時のみ)──> main
fix/yyy  ──PR──> develop
docs/zzz ──PR──> develop
```

### ルール

- **`main` への直接コミット禁止**（ADR 0006 を置き換える現行方針）
- **`main` へのマージはリリース時のみ**。日常的な開発は `develop` で完結させる
- フィーチャーブランチは `develop` から切り、`develop` へ PR してマージ
- `develop` → `main` の PR はリリースノートを添付する

## Consequences

- `main` が常にリリース可能な状態を保てる
- 開発途中の変更が `main` に紛れ込まない
- `develop` がリリース候補の集積点となり、まとめてテスト・QA が可能

## Related

- [0006-pr-only-integration-workflow.md](/Users/murase/project/3amoncall/docs/adr/0006-pr-only-integration-workflow.md)
