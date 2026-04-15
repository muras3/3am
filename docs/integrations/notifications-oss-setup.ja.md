# OSS 通知セットアップ

[English](./notifications-oss-setup.md) · **日本語**

Slack と Discord の通知をセットアップする手順:

1. 自分のワークスペースまたはサーバに Slack app / Discord bot を作成する
2. スレッド配信に必要な最小権限を付与する
3. `npx 3am integrations notifications` を実行する
4. 3am が資格情報を保存し、接続確認を行い、スレッド化されたインシデント配信を自動処理する

## Slack

### 最小 bot スコープ

- `chat:write`
- `channels:read`
- プライベートチャンネルを選択可能にする場合は `groups:read`

### ユーザー側の作業

1. 自分のワークスペース用に Slack app を作成する
2. 上記のスコープを追加する
3. app をワークスペースにインストールする
4. `Bot User OAuth Token` をコピーする
5. 対象チャンネルを選択する
6. 実行:

```bash
npx 3am integrations notifications \
  --provider slack \
  --slack-bot-token xoxb-... \
  --slack-channel-id C...
```

### その後 3am が行うこと

- bot がチャンネルに投稿できるか検証する
- Receiver に対象を保存する
- 親インシデント通知を送信する
- `thread_ts` を使って診断の続報を同じ Slack スレッドに投稿する

## Discord

### 最小 bot 権限

- `View Channels`
- `Send Messages`
- `Create Public Threads`
- `Send Messages in Threads`
- `Read Message History`

### ユーザー側の作業

1. Discord application を作成する
2. bot を追加する
3. 上記の権限を付与する
4. 対象のサーバに bot を招待する
5. bot トークンをコピーする
6. 対象チャンネルを選択する
7. 実行:

```bash
npx 3am integrations notifications \
  --provider discord \
  --discord-bot-token ... \
  --discord-channel-id ...
```

### その後 3am が行うこと

- bot がチャンネルに投稿できるか検証する
- インシデントごとに親メッセージを作成する
- その親メッセージから Discord スレッドを開始する
- 診断の続報をそのスレッド内に投稿する
