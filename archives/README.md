# 報告済みスナップショット保管庫（report-archives）

運用進捗レポートの PNG / PDF / HTML を追記のみで保管するブランチです。
本番サーバー（`/var/data/reports`）が主、このブランチが遠隔の二重化です。

環境変数 `REPORT_BACKUP_TOKEN`（GitHub PAT）を Render に設定すると、
「報告済み」保存時に自動でここにアップロードされます。
