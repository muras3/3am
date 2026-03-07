# ADR 0010: Branching Strategy

- Status: Accepted
- Date: 2026-03-07

## Context

Phase 1 以降、複数のフィーチャーを並行開発する。main を誤って汚染しないよう、開発フローを明文化する必要がある。

## Decision

### ブランチ構成

| ブランチ | 役割 |
|---------|------|
| `main` | リリース専用。直接コミット禁止。`devmain` からのマージのみ許可 |
| `devmain` | 開発統合ブランチ。全フィーチャーブランチのマージ先 |
| `feat/*`, `fix/*`, `docs/*` 等 | 作業ブランチ。`devmain` base で作成し `devmain` へ PR |

### フロー

```
feat/xxx ──PR──> devmain ──PR(リリース時のみ)──> main
fix/yyy  ──PR──> devmain
docs/zzz ──PR──> devmain
```

### ルール

- **`main` への直接コミット禁止**（ADR 0006 を拡張）
- **`main` へのマージはリリース時のみ**。日常的な開発は `devmain` で完結させる
- フィーチャーブランチは `devmain` から切り、`devmain` へ PR してマージ
- `devmain` → `main` の PR はリリースノートを添付する

## Consequences

- `main` が常にリリース可能な状態を保てる
- 開発途中の変更が `main` に紛れ込まない
- `devmain` がリリース候補の集積点となり、まとめてテスト・QA が可能

## Related

- [0006-pr-only-integration-workflow.md](/Users/murase/project/3amoncall/docs/adr/0006-pr-only-integration-workflow.md)
