# キャラデータベースの管理権限

図鑑は全利用者が閲覧できます。キャラの追加・編集、JSON取込、収録データへの復帰は、`src/auth/admin.js` の管理者メールでログインしたアカウントだけに表示されます。

保存先は Supabase の `public.character_catalog_overrides` です。追加キャラはそのまま登録され、既存キャラを編集した場合は同じIDの差分として保存されます。公開図鑑・編成検索・計算は、収録データにこの差分を上書きして利用します。

## 初回の有効化

Supabase Dashboard の SQL Editor で、[20260817_character_catalog_overrides.sql](../supabase/migrations/20260817_character_catalog_overrides.sql) を一度だけ実行します。SQL は次を設定します。

- 全利用者に公開図鑑用の読取り権限を付与
- `justdoittakama1029@gmail.com` だけに追加・編集権限を付与
- RLS を有効化し、画面を直接操作されても他アカウントからの書込みを拒否

管理者を変更する場合は、`src/auth/admin.js` と SQL 内のメールアドレスを同じ値に変更してから、Supabase 側のポリシーを再適用してください。
