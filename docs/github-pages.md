# GitHub Pages公開

`master` へのpushごとに、GitHub Actionsが `npm run build` を実行し、生成した `index.html` をGitHub Pagesへ公開します。

公開URLは次の形式です。

`https://phwhite-ot.github.io/eigomonogatari-simulator/`

## 初回設定

1. GitHubのリポジトリで **Settings > Pages** を開きます。
2. **Build and deployment** の **Source** を **GitHub Actions** に設定します。
3. Actionsの **Deploy public site** が成功すると、上記URLから誰でもアクセスできます。

以後は `master` へのpushで自動更新されます。必要に応じてActions画面から **Deploy public site** を手動実行して再公開できます。
