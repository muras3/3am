# UI/UX 監査レポート — Codex — 2026-03-12

- 対象: Console + Evidence Studio
- 参照資料: [uiux-review-2026-03-12.md](/Users/murase/project/3amoncall/docs/reviews/uiux-review-2026-03-12.md) および [validation/reports](/Users/murase/project/3amoncall/validation/reports) 配下のスクリーンショット 8 枚
- レビュアー: Codex
- 使用スキル: `ui-ux-pro-max`, `web-design-guidelines`
- ガイドライン参照元: 2026-03-12 時点で取得した Vercel Web Interface Guidelines
- スコープ: スクリーンショットベースの UI/UX 監査、情報設計、視認性、操作性、ガイドライン適合性

## 総評

現状の UI は、インシデント対応コンソールとしての方向性自体は悪くありません。ただし、実運用で素早く判断するための画面としてはまだ弱いです。問題の中心は見た目の洗練不足というより、情報の包み方にあります。重要な事実は画面上に存在していますが、長い文章、低優先度の細かい文字、スキーマそのままの表現、広すぎる空白領域の中に埋もれており、結果として「情報量は多いが判断しにくい」画面になっています。

既存レビューでは、スキーマ露出、因果連鎖カードの可読性不足、空状態の弱さが的確に指摘されていました。今回の再監査でより強く見えたのは、プロダクト全体に「何が起きたか」「今どこが重要か」「次に何をすべきか」を安定して伝える階層設計が不足している点です。この欠陥が、ほぼ全画面に共通して現れています。

## 優先度別の指摘

### P0

#### 1. 画面最上部のインシデント要約が 5 秒で把握できない

対象画面:
- [01-console-main.png](/Users/murase/project/3amoncall/validation/reports/01-console-main.png)
- [staging-console-full-2026-03-10.png](/Users/murase/project/3amoncall/validation/reports/staging-console-full-2026-03-10.png)

最初に目に入る要約文が長すぎます。トリガー、影響、仮説、補足テレメトリが単一の段落に混在しており、読むことを強制しています。インシデント対応画面の初手は、文章理解ではなくスキャンであるべきです。最初のビューポートでは 3 から 5 個の構造化された事実が見える必要があります。

- `ui-ux-pro-max`: 視覚的階層が弱い。内容の優先順位づけと余白によるグルーピングが不足している
- `web-design-guidelines`: 情報自体はあるが、長文を実用的な UI コンテンツとして扱えていない。高シグナルなコピー設計になっていない

改善方向:
- 長文要約を、トリガー、影響範囲、失敗中の依存先、信頼度、推奨アクションなどのファクトチップまたは要約グリッドへ分解する
- 段落本文は折りたたみ可能な補足情報に下げる

#### 2. Immediate Action は目立つが、実行指示としては重すぎる

対象画面:
- [01-console-main.png](/Users/murase/project/3amoncall/validation/reports/01-console-main.png)
- [staging-console-2026-03-10.png](/Users/murase/project/3amoncall/validation/reports/staging-console-2026-03-10.png)

赤いアクションパネルは確かに最重要として見えますが、中身は依然として説明文です。実際に何をどの順番でやるべきかを、利用者が文章から抽出しなければなりません。これはアクション面をしている説明文です。

- `ui-ux-pro-max`: 主要アクションが順序立てられておらず、見た目の強さに対して実行性が低い
- `web-design-guidelines`: コピーは具体的で高シグナルであるべきで、強い枠線だけでは不十分

改善方向:
- 2 から 3 ステップの順序付きアクションへ変える
- 「今やること」「やってはいけないこと」「その理由」を別ブロックに分離する

#### 3. 因果連鎖カードは運用画面として読める密度を下回っている

対象画面:
- [01-console-main.png](/Users/murase/project/3amoncall/validation/reports/01-console-main.png)
- [staging-console-2026-03-10.png](/Users/murase/project/3amoncall/validation/reports/staging-console-2026-03-10.png)

EXTERNAL → SYSTEM → INCIDENT → IMPACT の流れ自体は良いです。ただし、各カードが狭く、テキスト量が多すぎます。利用者は「因果連鎖がある」ことは分かっても、中身を無理なく読めません。その時点で構造は説明ではなく飾りになります。

- `ui-ux-pro-max`: 本文サイズ、行間、カード幅が説明文に対して不足している
- `web-design-guidelines`: 長文コンテンツの扱いが不十分で、現状のままでは読ませるか切るかの設計が曖昧

改善方向:
- 初期表示は高信頼の 3 ノード程度に絞る
- 補足説明はホバー、展開、右パネル詳細へ逃がす
- 各カード本文は 1 文 + 1 指標程度に抑える

#### 4. Metrics タブは分析 UI ではなく、生データ出力に見える

対象画面:
- [03-evidence-metrics.png](/Users/murase/project/3amoncall/validation/reports/03-evidence-metrics.png)

Evidence Studio の中で最も深刻な問題です。指標名、値、サマリ文字列が、グルーピングもトレンド文脈も閾値文脈もなく並んでいます。データを運んできた結果をそのまま列に描いている印象で、分析 UI になっていません。

- `ui-ux-pro-max`: chart/data 領域として破綻している。比較、異常強調、意味単位での束ね方がない
- `web-design-guidelines`: スキーマ形の UI と低シグナル表示のアンチパターン。数値中心の画面には要約と整列が必要

改善方向:
- traffic、failures、latency、saturation のような意味単位でグループ化する
- 生の行一覧をやめて、ミニチャート + 異常指標テーブルに置き換える
- ベースラインとの差分と「なぜ重要か」を明示する

### P1

#### 5. Evidence Studio のモーダルは広いのに、データを見る面積が足りない

対象画面:
- [02-evidence-traces.png](/Users/murase/project/3amoncall/validation/reports/02-evidence-traces.png)
- [03-evidence-metrics.png](/Users/murase/project/3amoncall/validation/reports/03-evidence-metrics.png)
- [04-evidence-logs.png](/Users/murase/project/3amoncall/validation/reports/04-evidence-logs.png)
- [05-evidence-platform-logs.png](/Users/murase/project/3amoncall/validation/reports/05-evidence-platform-logs.png)

モーダル全体は大きいのに、有効な情報は中央の細い領域に押し込められています。右側はほぼ死んだ空間で、肝心の表やチャート側が窮屈です。これは画面サイズ不足ではなく、レイアウト戦略の問題です。

- `ui-ux-pro-max`: データ密度に対してレイアウト配分が合っていない
- `web-design-guidelines`: 固定的な比率ではなく、タスクに合った flex/grid 設計が必要

改善方向:
- 右ペインに意味がある時だけ分割レイアウトにする
- そうでなければ、アクティブな evidence ペインに横幅を譲る
- フルスクリーン表示を追加する

#### 6. Traces 画面は「異常がある」ことは分かるが、「何を先に見るか」が分からない

対象画面:
- [02-evidence-traces.png](/Users/murase/project/3amoncall/validation/reports/02-evidence-traces.png)
- [02-evidence-studio-traces.png](/Users/murase/project/3amoncall/validation/reports/02-evidence-studio-traces.png)

ウォーターフォールは teal と orange のバーで最低限の差はありますが、意味づけが弱いです。凡例がなく、色と状態の対応が説明されず、下の表も `status 0` や `status 2` のような人間に優しくない値に落ちています。「何か悪い」は伝わっても、原因や優先順位では並べ替えられません。

- `ui-ux-pro-max`: chart/data とアクセシビリティ両面で弱い。色に頼りすぎている
- `web-design-guidelines`: 色だけで意味を伝えるべきではなく、UI 文言はバックエンドコードではなく意味を出すべき

改善方向:
- `error`, `slow`, `ok` の凡例とバッジを追加する
- 表には duration、endpoint、span type、error reason を前面に出す
- 受信順ではなく、影響順に並べる

#### 7. 空状態が「復帰の入口」ではなく「行き止まり」になっている

対象画面:
- [04-evidence-logs.png](/Users/murase/project/3amoncall/validation/reports/04-evidence-logs.png)
- [05-evidence-platform-logs.png](/Users/murase/project/3amoncall/validation/reports/05-evidence-platform-logs.png)

データがないことは表示されていますが、なぜないのかが分かりません。ロギング無効なのか、まだ届いていないのか、対象外なのか、フィルタに落ちているのか、収集失敗なのかを区別できません。次の一手も示されないため、ツールへの信頼が落ちます。

- `ui-ux-pro-max`: 空状態に説明と次アクションがない
- `web-design-guidelines`: 空状態は壊れたように見せてはいけず、次の手段を含むべき

改善方向:
- なぜ空なのかを説明する
- retry、時間範囲拡張、ingestion 確認、元システム参照など 1 つの次アクションを示す
- アイコンや簡単なビジュアルで「未実装感」を減らす

#### 8. Platform logs タブに内部用語が露出している

対象画面:
- [05-evidence-platform-logs.png](/Users/murase/project/3amoncall/validation/reports/05-evidence-platform-logs.png)

`TimePlaneDetailsRole` がそのまま UI に出ています。これは実装の断片にしか見えず、プロダクトの言葉として読めません。信頼感を直接損ないます。

- `ui-ux-pro-max`: コピー品質と命名システムの破綻
- `web-design-guidelines`: 典型的なスキーマ露出であり、ユーザー向け語彙へ置き換えるべき

改善方向:
- 内部ラベルを利用者向けの語彙へ変換する
- Evidence 系タブ全体で、スキーマ由来文字列の露出を監査する

#### 9. 右レールは情報自体は良いが、読む順番が設計されていない

対象画面:
- [01-console-main.png](/Users/murase/project/3amoncall/validation/reports/01-console-main.png)
- [staging-console-full-2026-03-10.png](/Users/murase/project/3amoncall/validation/reports/staging-console-full-2026-03-10.png)

`Confidence Assessment`, `Uncertainty`, `Operator Check` という構成は適切です。ただし、すべてが同じような密度の文章ブロックになっており、どこから読めばいいか分かりません。信頼度の数字も埋もれています。

- `ui-ux-pro-max`: タイポグラフィ階層と段階的開示が不足している
- `web-design-guidelines`: この幅のレールに対して文章量が多く、コピーの密度が高すぎる

改善方向:
- 信頼度は大きな数値アンカーにして、根拠は短い箇条書きへ分ける
- 不確実性は 2 から 3 個の明示的な caveat に圧縮する
- Operator Check は動詞始まりのチェックリストにする

### P2

#### 10. 高ストレス環境向けの画面として、全体の文字サイズが小さすぎる

対象画面:
- [01-console-main.png](/Users/murase/project/3amoncall/validation/reports/01-console-main.png)
- [staging-console-2026-03-10.png](/Users/murase/project/3amoncall/validation/reports/staging-console-2026-03-10.png)

因果連鎖カード、Mitigation Watch、ヘッダー、サイドレールなどに 10 から 12px 級の文字が多く使われています。コントラストが成立していても、密度の高い小文字は緊張時に読みづらく、全体を窮屈で壊れやすい印象にします。

- `ui-ux-pro-max`: 読みやすい本文サイズと行間の基準を安定して満たせていない
- `web-design-guidelines`: 数値比較画面では、タイポのリズムと tabular numerals の徹底が重要

改善方向:
- デフォルト本文サイズを一段引き上げる
- 極小文字は低優先度メタ情報に限定する
- メトリクス、時刻、件数には tabular numerals を統一適用する

#### 11. ヘッダーのメタ情報が、本来の価値以上に画面を支配している

対象画面:
- [01-console-main.png](/Users/murase/project/3amoncall/validation/reports/01-console-main.png)
- [staging-console-full-2026-03-10.png](/Users/murase/project/3amoncall/validation/reports/staging-console-full-2026-03-10.png)

incident ID、service、severity、timestamp、status は必要ですが、上部バーで占める視覚重量が強すぎます。主役であるはずの要約とアクションが、その下で競合しています。

- `ui-ux-pro-max`: コンテキスト用の chrome と実際の判断領域の階層バランスが悪い

改善方向:
- メタ情報は軽い二次バーへ圧縮する
- severity は目立たせつつ、識別子系の重みを下げる

#### 12. モーダルのタブと閉じる操作が、操作可能要素として弱い

対象画面:
- [02-evidence-traces.png](/Users/murase/project/3amoncall/validation/reports/02-evidence-traces.png)
- [03-evidence-metrics.png](/Users/murase/project/3amoncall/validation/reports/03-evidence-metrics.png)

Close ボタンは静かすぎ、タブは低コントラストで、アクティブ状態の差も弱いです。結果として、モーダル全体が対話的というより静的なオーバーレイに見えます。

- `ui-ux-pro-max`: 状態変化の視認性が弱い
- `web-design-guidelines`: インタラクティブ要素は周囲より明確に目立つべき

改善方向:
- タブのコントラストとアクティブ表示を強める
- Close のヒットエリアと配置の明確さを上げる
- hover、focus、pressed をはっきり作る

## 画面ごとの補足

### Console

- [01-console-main.png](/Users/murase/project/3amoncall/validation/reports/01-console-main.png): 構造の方向性は良いが、低優先度テキストが多すぎる
- [staging-console-2026-03-10.png](/Users/murase/project/3amoncall/validation/reports/staging-console-2026-03-10.png): 少し詰まった構図でも同じ階層問題が再現している
- [staging-console-full-2026-03-10.png](/Users/murase/project/3amoncall/validation/reports/staging-console-full-2026-03-10.png): 右レールと要約段落の再設計が必要であることが最もよく見える

### Evidence Studio

- [02-evidence-traces.png](/Users/murase/project/3amoncall/validation/reports/02-evidence-traces.png): 見た目の出発点は悪くないが、意味づけと表設計が弱い
- [02-evidence-studio-traces.png](/Users/murase/project/3amoncall/validation/reports/02-evidence-studio-traces.png): 同じ問題が再現しており、一時的な描画崩れではない
- [03-evidence-metrics.png](/Users/murase/project/3amoncall/validation/reports/03-evidence-metrics.png): 現状プロダクト内で最も弱い画面
- [04-evidence-logs.png](/Users/murase/project/3amoncall/validation/reports/04-evidence-logs.png): 空状態が未実装に見える
- [05-evidence-platform-logs.png](/Users/murase/project/3amoncall/validation/reports/05-evidence-platform-logs.png): 空状態の弱さとスキーマ露出が同時に起きている
- [staging-evidence-studio-2026-03-10.png](/Users/murase/project/3amoncall/validation/reports/staging-evidence-studio-2026-03-10.png): staging 側でもほぼ同じ問題が確認でき、構造的な課題と見てよい

## 推奨する改善順序

1. 画面上部の要約を、構造化された incident facts と段階的な action block に作り直す。
2. Evidence Studio のレイアウトを見直し、アクティブな evidence ペインがモーダル幅を使えるようにする。
3. Metrics を生データ一覧ではなく、グループ化された insight + compact chart へ置き換える。
4. Traces テーブルを triage 向けの意味列に再設計する。duration、endpoint、status、error reason を前面に出す。
5. すべての空状態を、理由説明 + 次アクション付きの状態へ変える。
6. プロダクト全体の文言を監査し、スキーマ露出や内部用語を除去する。
7. ベースの文字サイズを引き上げ、tabular numerals を統一する。

## 既存レビューとの差分

既存レビューは大きな欠点を正しく捉えていました。その上で、今回の監査では次の 3 点をより強く結論づけています。

- 問題の中心は「見た目の粗さ」より「情報の包み方の失敗」にある
- Evidence Studio の問題は、個別コンポーネント以前にレイアウト戦略の問題が大きい
- 右レールとアクションパネルは要素自体は正しいが、現状は scan-first な運用 UI ではなく、長文説明に寄りすぎている
