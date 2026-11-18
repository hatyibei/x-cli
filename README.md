# x-cli

X (Twitter) の**非公式** API を使った CLI と、AI コーディングエージェント用のスキル集です。Claude Code などのエージェントから操作することを想定しています。すべてのコマンドは JSON を出力します。

- **投稿**: テキスト・スレッド（`---` 区切り）・画像/動画・返信・引用・予約投稿。日本語は 2 文字分として長さをチェックします。
- **交流**: いいね、リポスト、ブックマーク、フォロー、ホームタイムライン。
- **リサーチ**: 検索（`from:` `min_faves:` などの演算子対応）、ユーザー、会話、フォロワー。
- **分析**: いいね・閲覧数・エンゲージメント率の分布、画像/リンク/ハッシュタグの効果、文字数、投稿曜日・時間帯（JST）、上位の投稿と著者。

> ⚠️ X の公式 API ではありません。Web 版 x.com と同じ内部 API を、ログイン済みのブラウザの Cookie で呼び出します。X の利用規約は自動化を制限しており、**アカウントがロック・凍結されるリスクがあります**。少量の個人利用にとどめ、大量のいいね・フォロー・投稿には使わないでください。

## 仕組み

X は内部 API の ID（GraphQL の queryId）を頻繁に変えるため、x-cli はそれを固定で持たず、**実行時に x.com の Web アプリの JS を読んで見つけます**（12 時間キャッシュ）。2026 年時点で x.com は新しい Web アプリ（Relay）に移行中なので、旧形式と新形式の両方に対応しています。リクエストには Web 版と同じ `x-client-transaction-id` ヘッダーを付けます。

X が仕様を変えて壊れたときは `x-cli ops --refresh` → `x-cli doctor` で状況がわかります。`x-cli raw <操作名> --vars '{...}'` で読み取り系の操作を直接呼んでレスポンスを確認できます（書き込み系は `--allow-mutation` が必要）。

## インストール

[Bun](https://bun.sh) 1.2 以降が必要です。

```bash
curl -fsSL https://bun.sh/install | bash
```

Claude Code にプラグインとして入れる:

```text
/plugin marketplace add hatyibei/x-cli
/plugin install x-cli@x-cli
```

ローカルで試す:

```bash
bun install && bun run build
./dist/x-cli.js --help
```

## ログイン

```bash
x-cli auth login     # Chrome/Edge が開くので、そこで普通に X にログイン
x-cli auth status
```

パスワードは x-cli を通りません。ログイン用のブラウザは使い捨てのプロファイルで開き、終了時（Ctrl-C でも）に削除します。デバッグ用の TCP ポートは開かず、パイプで通信します。

ブラウザが見つからない場合は、DevTools → Application → Cookies → `https://x.com` から `auth_token` と `ct0` を `auth_token=...; ct0=...` の形でクリップボードにコピーして:

```bash
pbpaste | x-cli auth import
```

（`--auth-token` / `--ct0` 引数でも渡せますが、シェルの履歴に残ります。）

セッションは `~/.config/x-cli/session.json`（ファイル 600 / フォルダ 700）に保存されます。`X_COOKIE` 環境変数に Cookie ヘッダーを入れると、保存したセッションより優先されます。

## コマンド

```bash
# 投稿
x-cli count "テキスト"                          # 重み付き文字数（上限 280、日本語・絵文字 2、URL 23）
x-cli post "本文" --dry-run                     # 投稿せずに確認
x-cli post --file thread.md                     # `---` だけの行でスレッドに分割（--no-thread で無効）
x-cli post "本文" --media a.png --alt "説明"     # 画像は最大 4 枚
x-cli post "本文" --reply-to <id|URL>  /  --quote <id|URL>
x-cli post "本文" --schedule 2026-11-20T09:00:00+09:00   # 予約投稿（X 側で廃止されている可能性あり）
x-cli delete <id|URL>

# 交流
x-cli like | unlike | retweet | unretweet | bookmark | unbookmark <id|URL>
x-cli follow | unfollow <screen_name>
x-cli home [--latest]   x-cli bookmarks   x-cli whoami

# リサーチ
x-cli search "AI lang:ja min_faves:100" --product top|latest|people|media --limit 50
x-cli user <screen_name> --limit 20 [--replies]
x-cli tweet <id|URL> --replies 30
x-cli followers | following <screen_name>
x-cli likers | retweeters <id|URL>

# 分析
x-cli analyze search "<query>" --limit 100
x-cli analyze user [<screen_name>] --limit 100   # 省略すると自分

# メンテナンス
x-cli doctor          # セッション・API ID の発見・transaction-id の状態
x-cli ops --grep Tweet [--refresh]
x-cli raw <OperationName> --vars '{"tweetId":"..."}'   # 書き込み系は --allow-mutation が必要
```

一覧系（`search` `user` など）は `--limit` を少し超えて返すことがあります（続きを取る `--cursor` で取りこぼさないため）。

エラーは stderr に `{"error": {"code", "message"}}` で出ます（終了コード 1、使い方の誤りは 2）。`AUTOMATION_SUSPECTED`（X のエラー 226）が出たら、その日はそれ以上操作しないでください。スレッドの途中で失敗すると `PARTIAL_THREAD` になり、`detail.published` に公開済みの投稿が入ります（全体をやり直さないこと）。

リクエストの間隔は 1 秒以上（書き込みは 3 秒以上）空けます。コマンドを別々に実行しても同じです。

## 環境変数

カレントディレクトリの `.env` に書かれた `X_COOKIE` / `X_CLI_*` は無視します（Bun は `.env` を自動で読むため、他人のリポジトリ内で実行してもアカウントやセッションが差し替えられないように）。シェルで設定してください。Cookie は `x.com` / `api.x.com` / `upload.x.com` 以外には送りません。

| 変数 | 既定値 | 説明 |
|---|---|---|
| `X_COOKIE` | | Cookie ヘッダー。保存済みセッションより優先 |
| `X_CLI_HOME` | `~/.config/x-cli` | セッションとキャッシュの置き場所 |
| `X_CLI_INTERVAL_MS` | `1000` | リクエスト間の最小間隔 |
| `X_CLI_TZ` | `Asia/Tokyo` | 分析で使うタイムゾーン |
| `X_CLI_NO_TRANSACTION_ID` | | `x-client-transaction-id` を付けない |
| `X_CLI_GRAPHQL_BASE` | | `https://x.com/i/api/graphql` か `https://api.x.com/graphql` に固定（既定は前者 → 後者の順に試す） |
| `X_CLI_USER_AGENT` | Chrome 140 | User-Agent |
| `X_CLI_MAX_SCAN_FILES` | `4000` | API ID を探すときに読む JS ファイル数の上限 |
| `X_CLI_CACHE_TTL_MS` | 12 時間 | API ID キャッシュの有効期間 |
| `X_CLI_DEBUG` | | 処理の段階を stderr に出す（Cookie の値は出さない） |

## 開発

```bash
bun test
bun run check   # 型チェック + テスト + ビルド
```

参考: [shoot16625/note-cli](https://github.com/shoot16625/note-cli)（構成を参考にしました）、XClientTransaction（transaction-id のアルゴリズム）
