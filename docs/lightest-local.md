# 最軽装: ローカル並列計算

最軽装の完全探索はGitHub Actionsを使わず、Windows PC上のNode.js Workerで実行する。通常のUI検索とは別に、長時間の計算・再開・結果キャッシュを対象にしたCLIである。

## 実行

`configs/lightest-example.json` のような設定JSONを作り、次を実行する。

```powershell
npm run run:lightest:local -- --stage=configs/lightest-example.json
```

Worker数は既定で論理CPU数から1を引いた数になる。PC操作をさらに優先したい場合は明示的に減らせる。

```powershell
npm run run:lightest:local -- --stage=configs/lightest-example.json --workers=8
```

通常は収録キャラデータを使う。ローカルの所持状態や編集済みキャラを使う場合は、キャラ配列（または `characters` 配列を含むJSON）を指定する。

```powershell
npm run run:lightest:local -- --stage=configs/lightest-example.json --characters=data/my-characters.json
```

## 設定例

```json
{
  "maxCost": 120,
  "maxTurns": 12,
  "deckSizes": [1, 2, 3, 4, 5],
  "difficulty": "pine",
  "allowedAttributes": ["fire", "water", "wind"],
  "rarities": [],
  "eventBonusIds": [],
  "requiredLastSkillType": "revive",
  "enemies": [
    { "characterId": "em-4b8a1db2788c" },
    { "characterId": "em-ccd4db81276f", "hp": 10000, "pow": 1200 }
  ],
  "searchOptions": {
    "allowDuplicates": true,
    "ownedOnly": true,
    "answerMultiplier": 2.592,
    "enemyAttackMultiplier": 1
  }
}
```

敵は `characterId` を指定し、必要なら `hp` と `pow` で上書きする。既に解決済みの敵データを渡す場合は `sourceCharacterId` を指定する。

## 探索順序と正確性

1. 自動ターゲット・自動スキル・HP順の代表配置で高速探索を行い、勝利コストの上限を見つける。
2. 上限以下のコスト帯を低い順に完全探索する。同一コスト内では候補組合せをWorkerへ剰余分割する。
3. 低コスト帯をすべて完了した後、上限コストで★3勝利が見つかった時点で最小コストを確定する。

完全検証ではスキル順を完全探索し、ターゲットはまず自動選択を試して失敗した場合に全手動ターゲットへ拡張する。この遅延分岐は探索順だけを変え、手動ターゲットの解を除外しない。

## 再開とキャッシュ

設定・戦闘ルール・キャラデータ全体からハッシュを作り、次を保存する。

- `.cache/lightest/<hash>.checkpoint.json` — 完了済みコスト・shard・高速探索の上限
- `.cache/lightest/<hash>.json` — 完了結果

同じ条件は結果キャッシュを即座に返す。停止やPC再起動後は同じコマンドを実行すれば、未完了shardだけを続行する。キャラデータ・設定・戦闘ロジックのソースが変わればハッシュも変わるため、古い結果は自動的に使われない。
