# ADR 0006: Integrate Changes via PRs to Main Only

- Status: Accepted
- Date: 2026-03-06

## Context

validation harness の実装では branch をまたぐ複数 PR を並行で扱った。  
この過程で、次の運用事故が発生した。

- ローカル `main` に commit を作ってしまった
- 複数 PR を `main` ではなく別の dev branch に積み上げてしまった
- merge 済みの認識と、実際に `origin/main` に入っている状態がずれた

この状態では、何が本当に main に入っているかを誤認しやすく、評価対象のコードベースが不明確になる。

## Decision

3amoncall の変更統合は `main` を base にした PR 経由のみで行う。

運用ルールは以下とする。

- `main` では commit を作らない
- 実装前に必ず topic branch を切る
- PR の base は必ず `main` にする
- merge 後は `origin/main` とローカル `main` の一致を確認する

## Consequences

- どの修正が本当に評価対象へ入ったかを追跡しやすくなる
- branch stack を使う場合でも、最終的に `main` へ統合する PR を明示する必要がある
- 開発速度はわずかに落ちるが、状態誤認によるロスが減る

## Related

- [README.md](/Users/murase/project/3amoncall/docs/adr/README.md)
