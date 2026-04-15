# OSS 通知セットアップ

[English](./notifications-oss-setup.md) · **日本語**

Slack と Discord の通知をつなぐには、次の 4 ステップで設定します。

1. 自分のワークスペースまたはサーバで Slack app または Discord bot を作る
2. スレッド配信に必要な最小権限を付与する
3. `npx 3am integrations notifications` を実行する
4. 3am が認証情報を保存し、疎通を確認する。以降のスレッド形式でのインシデント配信は自動で行われる

## Slack

### 最小 bot スコープ

- `chat:write`
- `channels:read`
- プライベートチャンネルも選べるようにするなら `groups:read`

### ユーザー側の作業

1. 自分のワークスペース向けに Slack app を作る
2. 上のスコープを追加する
3. app をワークスペースにインストールする
4. `Bot User OAuth Token` をコピーする
5. 投稿先のチャンネルを選ぶ
6. 次を実行:

```bash
npx 3am integrations notifications \
  --provider slack \
  --slack-bot-token xoxb-... \
  --slack-channel-id C...
```

### そのあと 3am が行う処理

- bot がチャンネルに投稿できるか確認する
- 送信先を Receiver に保存する
- 親インシデントの通知を送信する
- `thread_ts` を指定して、診断の続報を同じ Slack スレッドに投稿する

## Discord

### 最小 bot 権限

- `View Channels`
- `Send Messages`
- `Create Public Threads`
- `Send Messages in Threads`
- `Read Message History`

### ユーザー側の作業

1. Discord Application を作る
2. bot を追加する
3. 上の権限を付与する
4. bot を対象のサーバに招待する
5. bot トークンをコピーする
6. 投稿先のチャンネルを選ぶ
7. 次を実行:

```bash
npx 3am integrations notifications \
  --provider discord \
  --discord-bot-token ... \
  --discord-channel-id ...
```

### そのあと 3am が行う処理

- bot がチャンネルに投稿できるか確認する
- インシデントごとに親メッセージを投稿する
- その親メッセージから Discord スレッドを起こす
- 診断の続報を、そのスレッド内に投稿する
