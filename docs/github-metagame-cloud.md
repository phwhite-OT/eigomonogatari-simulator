# GitHub Actionsでの対戦環境評価

対戦環境評価はGitHub Actions上で実行し、途中経過と評価結果をmetagame-resultsブランチへ保存します。GitHubホステッドランナーは実行時間に上限があるため、標準では1回につき属性・コスト1縛り分の10区画を計算して確実に再開します。

## 初回設定

1. GitHubで空のリポジトリを作成し、このプロジェクトをpushします。リモート未設定の場合は、次のように設定します。

   ```bash
   git remote add origin https://github.com/<account>/<repository>.git
   git add .
   git commit -m "Add metagame cloud evaluation"
   git push -u origin master
   ```

2. リポジトリのSettings > Actions > General > Workflow permissionsで、Read and write permissionsを許可します。
3. ActionsタブでMetagame environment evaluationを選び、Run workflowを実行します。

初回実行でmetagame-resultsブランチが自動作成されます。評価結果は通常のソースブランチへ直接コミットしません。

## 実行と再開

- 手動実行ではmax_tasksは1のままにします。属性・コスト1縛りの残り区画だけを最後まで処理し、状態・JSON評価結果をmetagame-resultsへpushします。
- max_tasksは1を推奨します。実測では1縛り約40分で完了し、GitHub Actionsの実行上限内に収まります。
- 毎時のスケジュール実行も設定済みです。計算中に新しい実行は重複せず、同じ環境評価は同時に1本だけ動きます。
- 失敗した場合も、Actionsの実行をもう一度開始すれば、最後に保存された区画の次から再開します。

進捗はmetagame-resultsブランチのreports/metagame-v6-batch-status.jsonで確認できます。completedRunsが280になれば全区画が完了です。

再計算中は、画面にv3の旧環境データだけを暫定表示します。v4で属性・コスト1組分の10区画が完了した時点でv4へ切り替わり、v3とv4の評価結果を混在させません。

## 結果の反映

すべて完了すると、ワークフローがsrc/data/metagame-simulator-data.jsも更新します。GitHub上でmetagame-resultsから通常ブランチへプルリクエストを作成して取り込んでください。

取り込み後、ローカルで次を実行します。

    npm run build

## v7 fixed-environment evaluation

Fire / cost 100 is evaluated by `.github/workflows/metagame-v7-cloud.yml`. It saves resumable progress to the `metagame-v7-results` branch at `reports/metagame-ratings-v7/fire-100/progress.json`, then writes `report.json` and `report.csv` after all five positions finish.

## 注意

- GitHubホステッドランナーは、PCをスリープしても計算を続行します。
- リポジトリが長期間操作されない場合、GitHubはスケジュール実行を停止することがあります。その場合はRun workflowで手動再開できます。
- 結果ブランチには評価JSONが蓄積されます。GitHubのリポジトリ容量を確認してください。
