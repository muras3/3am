# OSS Notification Setup

For Slack and Discord notifications:

1. Create a Slack app / Discord bot in your own workspace or server
2. Grant the minimal permissions required for threaded delivery
3. Run `npx 3am integrations notifications`
4. 3am stores the credentials, verifies connectivity, and handles threaded incident delivery automatically

## Slack

### Minimal bot scopes

- `chat:write`
- `channels:read`
- `groups:read` if private channels must be selectable

### What the user does

1. Create a Slack app for their workspace
2. Add the scopes above
3. Install the app to the workspace
4. Copy the `Bot User OAuth Token`
5. Choose the target channel
6. Run:

```bash
npx 3am integrations notifications \
  --provider slack \
  --slack-bot-token xoxb-... \
  --slack-channel-id C...
```

### What 3am does after that

- Verifies the bot can post to the channel
- Stores the target in the Receiver
- Sends a parent incident notification
- Posts diagnosis follow-ups in the same Slack thread via `thread_ts`

## Discord

### Minimal bot permissions

- `View Channels`
- `Send Messages`
- `Create Public Threads`
- `Send Messages in Threads`
- `Read Message History`

### What the user does

1. Create a Discord application
2. Add a bot
3. Grant the permissions above
4. Invite the bot to the target server
5. Copy the bot token
6. Choose the target channel
7. Run:

```bash
npx 3am integrations notifications \
  --provider discord \
  --discord-bot-token ... \
  --discord-channel-id ...
```

### What 3am does after that

- Verifies the bot can post to the channel
- Creates a parent message for each incident
- Starts a Discord thread from that message
- Posts diagnosis follow-ups inside that thread

