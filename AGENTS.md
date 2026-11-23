# AGENTS.md

このリポジトリで作業する AI エージェント向けのルールです。コードを触る前に必ず読むこと。

## Git 運用ルール

### 基本方針

- **issue ドリブン**: どんなに小さな作業でも、まず issue を作ってから着手する
- **作業ブランチ**: 必ず作業ブランチを切って作業する。`main` で直接作業しない
- **PR → squash merge**: 変更は PR を作り、レビュー後に squash merge で `main` に取り込む

### main での直接作業

- `main` で直接作業（コミット・push）する場合は、**必ずユーザーの許可をとる**
- 許可なく `main` にコミット・push しない。ローカルの一時コミットであっても `main` は触らない

### 作業手順

1. issue を作成（タイトルと本文で作業内容を明確に）
2. 作業ブランチを切る: `<issue番号>-<slug>`（例: `31-fist-icon`）
3. ブランチで作業・コミット
4. `git push -u origin <branch>` で push
5. `gh pr create --base main --head <branch>` で PR を作成
6. CI チェックとレビューを通した後、squash merge

### コミットメッセージ

- プレフィックス: `[Add]` / `[Fix]` / `[Remove]` / `[Docs]`
- 本文は日本語で、何をしたか簡潔に
- 関連 issue は `（#番号）` で明記する

### リリース

- リリースはタグ `v<version>` を push するだけで、GitHub Actions の Release ワークフローがビルドとリリース作成を自動で行う
- 手動で `gh release create` を実行しない（ワークフローと重複して失敗するため）
